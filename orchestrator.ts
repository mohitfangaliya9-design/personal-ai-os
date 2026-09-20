import crypto from 'node:crypto';
import { exec, query } from './db.js';
import { planRequest } from './planner.js';
import type { TaskStatus } from './types.js';

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Detect simple agent-creation requests and create a real Agent
 * record in PostgreSQL.
 *
 * This capability is local-only. It does not connect to or modify
 * any external service.
 */
function parseAgentCreationRequest(request: string) {
  const text = request.trim();

  const patterns = [
    /create\s+(?:a\s+)?(?:test\s+)?agent\s+named\s+["']?([^"'\.\n]+?)["']?(?:\.|,|\s+with|\s+that|\s+which|$)/i,

    /create\s+(?:a\s+)?agent\s+(?:called|named)\s+["']([^"']+)["']/i,

    /(?:make|build)\s+(?:a\s+)?(?:test\s+)?agent\s+(?:called|named)\s+["']?([^"'\.\n]+?)["']?(?:\.|,|\s+with|\s+that|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const name = match[1]
        .trim()
        .replace(/["']+$/g, '')
        .trim();

      if (name) {
        return name;
      }
    }
  }

  return null;
}

async function createAgentFromRequest(request: string) {
  const name = parseAgentCreationRequest(request);

  if (!name) {
    return null;
  }

  // Prevent duplicate agents with the same name.
  const existing = await query<{ id: string; name: string }>(
    `SELECT id, name
     FROM agents
     WHERE LOWER(name) = LOWER($1)
     LIMIT 1`,
    [name]
  );

  if (existing[0]) {
    return {
      id: existing[0].id,
      name: existing[0].name,
      created: false,
      message: 'Agent already exists.'
    };
  }

  const agentId = id('agent');
  const lowerRequest = request.toLowerCase();

  const role = lowerRequest.includes('research')
    ? 'research'
    : 'general';

  const description =
    `AI agent created from user request: ${request}`;

  const instructions = [
    'Receive user tasks.',
    'Break each task into a clear plan before execution.',
    'Execute tasks safely and report the result.',
    'Do not access or modify external services unless a permitted tool is explicitly connected.',
    'Pause for approval before sensitive actions.'
  ].join(' ');

  await exec(
    `INSERT INTO agents
      (id, name, description, role, instructions, tools, permissions, status, version)
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, 'active', 1)`,
    [
      agentId,
      name,
      description,
      role,
      instructions,
      JSON.stringify([]),
      JSON.stringify([])
    ]
  );

  await exec(
    `INSERT INTO audit_logs
      (event, entity_type, entity_id, detail)
     VALUES
      ($1, $2, $3, $4)`,
    [
      'agent.created',
      'agent',
      agentId,
      JSON.stringify({
        name,
        role,
        sourceRequest: request
      })
    ]
  );

  return {
    id: agentId,
    name,
    role,
    created: true,
    message: 'Agent created successfully.'
  };
}

export async function createTask(request: string) {
  const taskId = id('task');

  const plan = await planRequest(request);

  const approval =
    plan.steps.some(step => step.requiresApproval)
      ? 'required'
      : 'not_required';

  const status: TaskStatus =
    approval === 'required'
      ? 'WAITING_APPROVAL'
      : 'RUNNING';

  if (await hasPg()) {
    await exec(
      `INSERT INTO tasks
        (id, request, status, current_step, progress, approval_state)
       VALUES
        ($1, $2, $3, $4, $5, $6)`,
      [
        taskId,
        request,
        status,
        'understand',
        20,
        approval
      ]
    );

    await exec(
      `INSERT INTO audit_logs
        (event, entity_type, entity_id, detail)
       VALUES
        ($1, $2, $3, $4)`,
      [
        'task.created',
        'task',
        taskId,
        JSON.stringify({ plan })
      ]
    );
  }

  if (status === 'RUNNING') {
    const result = await executeTask(
      taskId,
      request,
      plan
    );

    return {
      id: taskId,
      status: 'COMPLETED',
      plan,
      result
    };
  }

  return {
    id: taskId,
    status,
    plan
  };
}

async function hasPg() {
  return Boolean(process.env.DATABASE_URL);
}

export async function executeTask(
  taskId: string,
  request: string,
  plan?: Awaited<ReturnType<typeof planRequest>>
) {
  const currentPlan =
    plan ?? await planRequest(request);

  if (await hasPg()) {
    await exec(
      `UPDATE tasks
       SET status = 'RUNNING',
           current_step = 'execute',
           progress = 60,
           updated_at = now()
       WHERE id = $1`,
      [taskId]
    );
  }

  /*
   * Local agent-management capability.
   *
   * No external side effects are performed.
   */
  const createdAgent =
    await createAgentFromRequest(request);

  const result = {
    message: createdAgent
      ? createdAgent.message
      : 'Task executed by Personal AI OS orchestration layer.',

    request,

    agent: createdAgent,

    steps: currentPlan.steps.map(step => ({
      id: step.id,
      action: step.action,
      status: 'completed'
    })),

    externalSideEffect: false,

    note: createdAgent
      ? 'The agent is stored in PostgreSQL and is ready to receive tasks through the orchestration layer.'
      : 'Connect a permitted tool or API to perform external actions.'
  };

  if (await hasPg()) {
    await exec(
      `UPDATE tasks
       SET status = 'COMPLETED',
           current_step = 'verified',
           progress = 100,
           result = $2,
           updated_at = now()
       WHERE id = $1`,
      [
        taskId,
        JSON.stringify(result)
      ]
    );

    await exec(
      `INSERT INTO audit_logs
        (event, entity_type, entity_id, detail)
       VALUES
        ($1, $2, $3, $4)`,
      [
        'task.completed',
        'task',
        taskId,
        JSON.stringify(result)
      ]
    );
  }

  return result;
}

export async function approveTask(taskId: string) {
  if (await hasPg()) {
    const rows = await query<{
      request: string;
      status: string;
    }>(
      `SELECT request, status
       FROM tasks
       WHERE id = $1`,
      [taskId]
    );

    if (!rows[0]) {
      throw new Error('Task not found');
    }

    if (rows[0].status !== 'WAITING_APPROVAL') {
      throw new Error(
        'Task is not waiting for approval'
      );
    }

    await exec(
      `UPDATE tasks
       SET approval_state = 'approved',
           status = 'RUNNING',
           updated_at = now()
       WHERE id = $1`,
      [taskId]
    );

    return executeTask(
      taskId,
      rows[0].request
    );
  }

  throw new Error(
    'Approval persistence requires DATABASE_URL in this build.'
  );
}

export async function rejectTask(taskId: string) {
  if (await hasPg()) {
    await exec(
      `UPDATE tasks
       SET approval_state = 'rejected',
           status = 'CANCELLED',
           updated_at = now()
       WHERE id = $1`,
      [taskId]
    );
  }

  return {
    id: taskId,
    status: 'CANCELLED'
  };
}
