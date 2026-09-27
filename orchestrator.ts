/**
 * orchestrator.ts
 * -----------------------------------------------------------------------
 * Orchestration layer for the Personal AI OS.
 *
 * This file coordinates — it does not plan and does not invent results:
 *   - Planning is delegated entirely to planner.ts (`planRequest`).
 *   - Approval gating is enforced here and can only ever be made stricter,
 *     never relaxed, relative to what the plan already requires.
 *   - Execution is delegated to a small, explicit registry of step
 *     executors. If no executor exists for a step, that step is reported
 *     as `no_executor` — it is never marked "completed" without a real
 *     executor having actually run and returned success.
 *
 * Public API (kept stable for existing callers):
 *   createTask(request: string)
 *   executeTask(taskId: string, request: string, plan?: Plan)
 *   approveTask(taskId: string)
 *   rejectTask(taskId: string)
 * -----------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import { exec, query } from './db.js';
import { planRequest } from './planner.js';
import type { TaskStatus, Plan, Risk } from './types.js';

type PlanStep = Plan['steps'][number];

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function hasPg() {
  return Boolean(process.env.DATABASE_URL);
}

// ---------------------------------------------------------------------
// Plan validation (defense in depth)
// ---------------------------------------------------------------------
// planner.ts already validates and enforces the approval safety floor.
// The orchestrator re-validates anyway because plans may also arrive
// here from storage (audit logs) rather than directly from the planner,
// and this file must never trust an unchecked plan.

function isRisk(value: unknown): value is Risk {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL';
}

function mustRequireApproval(risk: Risk): boolean {
  return risk === 'HIGH' || risk === 'CRITICAL';
}

class PlanIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanIntegrityError';
  }
}

function validatePlan(raw: unknown): Plan {
  if (typeof raw !== 'object' || raw === null) {
    throw new PlanIntegrityError('Plan is not an object');
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.summary !== 'string' || p.summary.trim().length === 0) {
    throw new PlanIntegrityError('Plan is missing a valid "summary"');
  }
  if (typeof p.needsAI !== 'boolean') {
    throw new PlanIntegrityError('Plan is missing a valid "needsAI" boolean');
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    throw new PlanIntegrityError('Plan is missing a non-empty "steps" array');
  }

  const seenIds = new Set<string>();
  const steps: PlanStep[] = p.steps.map((rawStep, index) => {
    if (typeof rawStep !== 'object' || rawStep === null) {
      throw new PlanIntegrityError(`Plan step at index ${index} is not an object`);
    }
    const s = rawStep as Record<string, unknown>;
    if (typeof s.id !== 'string' || s.id.trim().length === 0) {
      throw new PlanIntegrityError(`Plan step at index ${index} is missing a valid "id"`);
    }
    if (typeof s.action !== 'string' || s.action.trim().length === 0) {
      throw new PlanIntegrityError(`Plan step "${s.id}" is missing a valid "action"`);
    }
    if (!isRisk(s.risk)) {
      throw new PlanIntegrityError(`Plan step "${s.id}" has an invalid "risk" value`);
    }
    if (typeof s.requiresApproval !== 'boolean') {
      throw new PlanIntegrityError(`Plan step "${s.id}" is missing a valid "requiresApproval" flag`);
    }
    if (seenIds.has(s.id)) {
      throw new PlanIntegrityError(`Plan contains duplicate step id "${s.id}"`);
    }
    seenIds.add(s.id);

    return { id: s.id, action: s.action, risk: s.risk, requiresApproval: s.requiresApproval } as PlanStep;
  });

  return { summary: p.summary, needsAI: p.needsAI, steps } as Plan;
}

/**
 * Safety floor: HIGH/CRITICAL steps must always require approval.
 * This can only ADD an approval requirement, never remove one.
 */
function withApprovalFloor(plan: Plan): Plan {
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      requiresApproval: step.requiresApproval || mustRequireApproval(step.risk),
    })) as Plan['steps'],
  };
}

// ---------------------------------------------------------------------
// Agent-creation capability (local-only, no external side effects)
// ---------------------------------------------------------------------

interface AgentCreationResult {
  id: string;
  name: string;
  role?: string;
  created: boolean;
  message: string;
}

function parseAgentCreationRequest(request: string): string | null {
  const text = request.trim();

  const patterns = [
    /create\s+(?:a\s+)?(?:test\s+)?agent\s+named\s+["']?([^"'\.\n]+?)["']?(?:\.|,|\s+with|\s+that|\s+which|$)/i,
    /create\s+(?:a\s+)?agent\s+(?:called|named)\s+["']([^"']+)["']/i,
    /(?:make|build)\s+(?:a\s+)?(?:test\s+)?agent\s+(?:called|named)\s+["']?([^"'\.\n]+?)["']?(?:\.|,|\s+with|\s+that|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const name = match[1].trim().replace(/["']+$/g, '').trim();
      if (name) return name;
    }
  }

  return null;
}

async function createAgentFromRequest(request: string): Promise<AgentCreationResult | null> {
  const name = parseAgentCreationRequest(request);
  if (!name) return null;

  const existing = await query<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name]
  );

  if (existing[0]) {
    return {
      id: existing[0].id,
      name: existing[0].name,
      created: false,
      message: 'Agent already exists.',
    };
  }

  const agentId = id('agent');
  const lowerRequest = request.toLowerCase();
  const role = lowerRequest.includes('research') ? 'research' : 'general';
  const description = `AI agent created from user request: ${request}`;
  const instructions = [
    'Receive user tasks.',
    'Break each task into a clear plan before execution.',
    'Execute tasks safely and report the result.',
    'Do not access or modify external services unless a permitted tool is explicitly connected.',
    'Pause for approval before sensitive actions.',
  ].join(' ');

  await exec(
    `INSERT INTO agents (id, name, description, role, instructions, tools, permissions, status, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 1)`,
    [agentId, name, description, role, instructions, JSON.stringify([]), JSON.stringify([])]
  );

  await exec(
    `INSERT INTO audit_logs (event, entity_type, entity_id, detail) VALUES ($1, $2, $3, $4)`,
    ['agent.created', 'agent', agentId, JSON.stringify({ name, role, sourceRequest: request })]
  );

  return { id: agentId, name, role, created: true, message: 'Agent created successfully.' };
}

// ---------------------------------------------------------------------
// Step executor registry
// -----------------------------------------------------------------------
// This is the extension point for future capabilities (memory, web
// research, file tools, Android/device tools, scheduling, autonomous
// agents, etc). Add a new executor here; nothing else in this file needs
// to change. If no executor claims a step, that step is honestly
// reported as `no_executor` — never faked as completed.

type StepExecutionStatus = 'completed' | 'no_executor' | 'failed' | 'skipped';

interface StepResult {
  id: string;
  action: string;
  risk: Risk;
  requiresApproval: boolean;
  status: StepExecutionStatus;
  executorName?: string;
  detail?: unknown;
  error?: string;
}

interface StepExecutor {
  name: string;
  canHandle(step: PlanStep, request: string): boolean;
  run(step: PlanStep, request: string): Promise<{ detail?: unknown }>;
}

const understandingExecutor: StepExecutor = {
  name: 'understanding',
  canHandle: (step) => step.id === 'understand',
  async run() {
    return { detail: { note: 'Request parsed and structurally validated by the orchestrator.' } };
  },
};

const agentCreationExecutor: StepExecutor = {
  name: 'agent-creation',
  canHandle: (_step, request) => parseAgentCreationRequest(request) !== null,
  async run(_step, request) {
    const agent = await createAgentFromRequest(request);
    if (!agent) {
      throw new Error('Agent creation did not produce a result.');
    }
    return { detail: agent };
  },
};

const executorRegistry: StepExecutor[] = [understandingExecutor, agentCreationExecutor];

async function runStep(step: PlanStep, request: string, priorStepFailed: boolean): Promise<StepResult> {
  const base = { id: step.id, action: step.action, risk: step.risk, requiresApproval: step.requiresApproval };

  if (priorStepFailed) {
    return { ...base, status: 'skipped', error: 'Skipped because an earlier step failed.' };
  }

  const executor = executorRegistry.find((e) => {
    try {
      return e.canHandle(step, request);
    } catch {
      return false;
    }
  });

  if (!executor) {
    return { ...base, status: 'no_executor' };
  }

  try {
    const outcome = await executor.run(step, request);
    return { ...base, status: 'completed', executorName: executor.name, detail: outcome.detail };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      executorName: executor.name,
      error: error instanceof Error ? error.message : 'Unknown execution error',
    };
  }
}

// ---------------------------------------------------------------------
// Persisted-plan lookup (used by approveTask to avoid re-planning drift)
// -----------------------------------------------------------------------
// The plan a human approved must be the same plan that gets executed.
// Re-running planRequest() at approval time could, in principle, produce
// a different plan (e.g. a non-deterministic AI response). To avoid
// that drift, we recover the originally-generated plan from the audit
// log written at task creation, and only fall back to re-planning if it
// cannot be found or fails validation.

async function getStoredPlan(taskId: string): Promise<Plan | null> {
  try {
    const rows = await query<{ detail: unknown }>(
      `SELECT detail FROM audit_logs WHERE event = 'task.created' AND entity_id = $1 LIMIT 1`,
      [taskId]
    );
    const raw = rows[0]?.detail;
    if (raw == null) return null;

    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const planCandidate = (parsed as Record<string, unknown> | null)?.plan;
    if (!planCandidate) return null;

    return validatePlan(planCandidate);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export async function createTask(request: string) {
  if (typeof request !== 'string' || request.trim().length === 0) {
    throw new Error('createTask requires a non-empty request string');
  }

  const taskId = id('task');

  const rawPlan = await planRequest(request);
  const plan = withApprovalFloor(validatePlan(rawPlan));

  const approval = plan.steps.some((step) => step.requiresApproval) ? 'required' : 'not_required';
  const status: TaskStatus = approval === 'required' ? 'WAITING_APPROVAL' : 'RUNNING';

  if (await hasPg()) {
    await exec(
      `INSERT INTO tasks (id, request, status, current_step, progress, approval_state) VALUES ($1, $2, $3, $4, $5, $6)`,
      [taskId, request, status, 'understand', 20, approval]
    );

    await exec(
      `INSERT INTO audit_logs (event, entity_type, entity_id, detail) VALUES ($1, $2, $3, $4)`,
      ['task.created', 'task', taskId, JSON.stringify({ plan })]
    );
  }

  if (status === 'RUNNING') {
    const result = await executeTask(taskId, request, plan);
    return { id: taskId, status: 'COMPLETED', plan, result };
  }

  return { id: taskId, status, plan };
}

export async function executeTask(taskId: string, request: string, plan?: Plan) {
  const currentPlan = plan ? withApprovalFloor(validatePlan(plan)) : withApprovalFloor(validatePlan(await planRequest(request)));

  if (await hasPg()) {
    try {
      await exec(
        `UPDATE tasks SET status = 'RUNNING', current_step = 'execute', progress = 60, updated_at = now() WHERE id = $1`,
        [taskId]
      );
    } catch (error) {
      console.warn('Failed to update task to RUNNING before execution:', error);
    }
  }

  const stepResults: StepResult[] = [];
  let priorStepFailed = false;
  for (const step of currentPlan.steps) {
    const res = await runStep(step, request, priorStepFailed);
    if (res.status === 'failed') priorStepFailed = true;
    stepResults.push(res);
  }

  const agentResult =
    (stepResults.find((r) => r.executorName === 'agent-creation')?.detail as AgentCreationResult | undefined) ?? null;

  const allCompleted = stepResults.every((r) => r.status === 'completed');
  const anyFailed = stepResults.some((r) => r.status === 'failed');

  const result = {
    message: anyFailed
      ? 'Task execution encountered one or more failures.'
      : allCompleted
        ? 'Task executed by Personal AI OS orchestration layer.'
        : 'Task processed; one or more steps have no available executor yet.',
    request,
    agent: agentResult,
    steps: stepResults,
    // No executor in this build reaches outside the local system/database.
    externalSideEffect: false,
    success: allCompleted,
    note: agentResult
      ? 'The agent is stored in PostgreSQL and is ready to receive tasks through the orchestration layer.'
      : 'Connect a permitted tool or executor to perform additional actions.',
  };

  if (await hasPg()) {
    try {
      await exec(
        `UPDATE tasks SET status = 'COMPLETED', current_step = 'verified', progress = 100, result = $2, updated_at = now() WHERE id = $1`,
        [taskId, JSON.stringify(result)]
      );

      await exec(
        `INSERT INTO audit_logs (event, entity_type, entity_id, detail) VALUES ($1, $2, $3, $4)`,
        ['task.completed', 'task', taskId, JSON.stringify(result)]
      );
    } catch (error) {
      console.warn('Failed to persist task completion:', error);
    }
  }

  return result;
}

export async function approveTask(taskId: string) {
  if (!(await hasPg())) {
    throw new Error('Approval persistence requires DATABASE_URL in this build.');
  }

  const rows = await query<{ request: string; status: string }>(
    `SELECT request, status FROM tasks WHERE id = $1`,
    [taskId]
  );

  if (!rows[0]) {
    throw new Error('Task not found');
  }
  if (rows[0].status !== 'WAITING_APPROVAL') {
    throw new Error('Task is not waiting for approval');
  }

  // Prefer the plan that was actually presented for approval; only
  // re-plan if it cannot be recovered or fails validation.
  const storedPlan = await getStoredPlan(taskId);
  const plan = withApprovalFloor(storedPlan ?? validatePlan(await planRequest(rows[0].request)));

  await exec(
    `UPDATE tasks SET approval_state = 'approved', status = 'RUNNING', updated_at = now() WHERE id = $1`,
    [taskId]
  );

  return executeTask(taskId, rows[0].request, plan);
}

export async function rejectTask(taskId: string) {
  if (await hasPg()) {
    await exec(
      `UPDATE tasks SET approval_state = 'rejected', status = 'CANCELLED', updated_at = now() WHERE id = $1`,
      [taskId]
    );
  }

  return { id: taskId, status: 'CANCELLED' };
}
