/**
 * scheduler.ts
 * -----------------------------------------------------------------------
 * Scheduling service for the Personal AI OS.
 *
 * Responsibility boundary: this file schedules and triggers execution of
 * existing workflows via the orchestrator. It is NOT a second
 * orchestrator, planner, AI engine, database layer, or workflow executor.
 *
 * Every cron firing does exactly one thing: call createTask() so the
 * existing planning/approval/execution pipeline handles the work. This
 * file never claims a workflow "completed" — only that a task was
 * created for it; the orchestrator owns the truth of what happened next.
 *
 * Preserved exports: registerSchedule(...), startScheduler()
 * Additive exports: stopScheduler(), unregisterSchedule(),
 * isScheduleRegistered(), listActiveSchedules(), getSchedulerStatus()
 * -----------------------------------------------------------------------
 */

import cron, { type ScheduledTask } from 'node-cron';
import { query } from './db.js';
import { createTask } from './orchestrator.js';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

interface JobEntry {
  job: ScheduledTask;
  workflowId: string;
  expression: string;
  timezone: string;
}

interface ScheduleMetadata {
  running: boolean;
  executionCount: number;
  failureCount: number;
  lastExecutionAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

/**
 * Row shape returned by the `schedules` table SELECT in startScheduler().
 *
 * Extends Record<string, unknown> so it satisfies db.ts's `Row` type
 * constraint (which requires a string index signature) while still
 * preserving strong, explicit typing for every known column used here.
 */
interface ScheduleRow extends Record<string, unknown> {
  id: string;
  workflow_id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
}

export interface ScheduleRegistrationResult {
  id: string;
  workflowId: string;
  expression: string;
  timezone: string;
}

export interface SchedulerStatus {
  started: boolean;
  registeredCount: number;
  activeExecutionCount: number;
  scheduleIds: string[];
}

export interface ActiveScheduleInfo {
  id: string;
  workflowId: string;
  expression: string;
  timezone: string;
  metadata: ScheduleMetadata;
}

// ---------------------------------------------------------------------
// Registry state
// -----------------------------------------------------------------------
// jobs: schedule id -> active cron job + its config
// executing: schedule ids currently mid-execution (overlap guard)
// metadata: lightweight per-schedule execution history, bounded by the
// set of schedules that have ever been registered in this process and
// cleaned up whenever a schedule is unregistered/replaced.

const jobs = new Map<string, JobEntry>();
const executing = new Set<string>();
const metadata = new Map<string, ScheduleMetadata>();

let started = false;

// ---------------------------------------------------------------------
// Safe logging
// -----------------------------------------------------------------------
// Never logs env values, connection strings, or error objects wholesale —
// only short, sanitized text.

const SENSITIVE_PATTERNS: RegExp[] = [
  /postgres(?:ql)?:\/\/\S+/i,
  /:\/\/[^/\s]*:[^/\s]*@/,
  /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|authorization)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function sanitize(message: string): string {
  const firstLine = message.split('\n')[0]?.trim() || 'unknown error';
  if (SENSITIVE_PATTERNS.some((p) => p.test(firstLine))) {
    return 'internal error (details withheld)';
  }
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
}

function errorMessage(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error ?? 'unknown error'));
}

function log(event: string, detail?: Record<string, unknown>): void {
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.log(`[scheduler] ${event}${suffix}`);
}

function logError(event: string, detail: Record<string, unknown> | undefined, error: unknown): void {
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.error(`[scheduler] ${event}${suffix} error=${errorMessage(error)}`);
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

function validateId(id: string, label: string): string {
  const trimmed = id?.trim();
  if (!trimmed) {
    throw new ScheduleValidationError(`${label} must be a non-empty string.`);
  }
  return trimmed;
}

function validateCronExpression(expression: string): string {
  const trimmed = expression?.trim();
  if (!trimmed) {
    throw new ScheduleValidationError('Cron expression must not be empty.');
  }
  if (!cron.validate(trimmed)) {
    throw new ScheduleValidationError(`Invalid cron expression: "${trimmed}"`);
  }
  return trimmed;
}

function isKnownTimeZone(tz: string): boolean {
  try {
    const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    if (supportedValuesOf) {
      return supportedValuesOf('timeZone').includes(tz);
    }
    // Fallback for runtimes without Intl.supportedValuesOf: constructing
    // a formatter throws a RangeError for an unrecognized zone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateTimezone(timezone: string): string {
  const trimmed = timezone?.trim();
  if (!trimmed) {
    throw new ScheduleValidationError('Timezone must not be empty.');
  }
  if (!isKnownTimeZone(trimmed)) {
    throw new ScheduleValidationError(`Invalid or unrecognized timezone identifier: "${trimmed}"`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------

function freshMetadata(): ScheduleMetadata {
  return {
    running: false,
    executionCount: 0,
    failureCount: 0,
    lastExecutionAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
}

function getOrCreateMetadata(id: string): ScheduleMetadata {
  let entry = metadata.get(id);
  if (!entry) {
    entry = freshMetadata();
    metadata.set(id, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------
// Execution
// -----------------------------------------------------------------------
// Fires on cron trigger. Guards against overlapping runs of the SAME
// schedule id, never throws out of the cron callback, and never reports
// a workflow as "completed" — only that a task was created for it (or
// that creation failed).

async function executeSchedule(id: string, workflowId: string): Promise<void> {
  if (executing.has(id)) {
    log('execution.skipped_overlap', { scheduleId: id, workflowId });
    return;
  }

  executing.add(id);
  const meta = getOrCreateMetadata(id);
  meta.running = true;
  meta.lastExecutionAt = new Date().toISOString();
  meta.executionCount += 1;

  log('execution.start', { scheduleId: id, workflowId });

  try {
    // Delegates entirely to the existing orchestrator pipeline. This
    // creates a task (subject to the normal planning/approval flow); it
    // does not itself execute or complete the workflow.
    const task = await createTask(`Run scheduled workflow ${workflowId} (schedule ${id})`);
    meta.lastSuccessAt = new Date().toISOString();
    meta.lastError = null;
    log('execution.task_created', {
      scheduleId: id,
      workflowId,
      taskId: (task as { id?: string } | undefined)?.id,
      status: (task as { status?: string } | undefined)?.status,
    });
  } catch (error) {
    meta.failureCount += 1;
    meta.lastFailureAt = new Date().toISOString();
    meta.lastError = errorMessage(error);
    logError('execution.task_creation_failed', { scheduleId: id, workflowId }, error);
    // Deliberately swallowed here: a cron callback must never throw or
    // produce an unhandled rejection. The failure is fully recorded in
    // metadata/logs instead.
  } finally {
    meta.running = false;
    executing.delete(id);
  }
}

// ---------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------

function stopAndRemoveJob(id: string): void {
  const entry = jobs.get(id);
  if (!entry) return;
  try {
    entry.job.stop();
  } catch (error) {
    logError('job.stop_failed', { scheduleId: id }, error);
  }
  jobs.delete(id);
}

/**
 * Registers (or re-registers) a cron job for a schedule.
 *
 * NOTE on ordering vs. persistence: mcp.ts currently calls this function
 * and then inserts the schedule row afterward. That means a job can
 * become active in this process's registry slightly before it is
 * durably persisted. Making that fully atomic would require changes
 * outside this file (e.g. persist-then-register, or a DB transaction
 * spanning both), which is out of scope here. Within this file, the
 * behavior is kept deterministic: registration either fully succeeds
 * (job created, old job for the same id cleanly stopped first) or
 * throws before any state is mutated — it never leaves a half-registered
 * job behind.
 */
export async function registerSchedule(
  id: string,
  workflowId: string,
  expression: string,
  timezone: string = process.env.TIMEZONE || 'Asia/Kolkata'
): Promise<ScheduleRegistrationResult> {
  const scheduleId = validateId(id, 'Schedule id');
  const wfId = validateId(workflowId, 'Workflow id');
  const cronExpression = validateCronExpression(expression);
  const tz = validateTimezone(timezone);

  // Validate and build the new job BEFORE touching any existing state,
  // so a bad registration can never destroy a previously working job.
  const job = cron.schedule(
    cronExpression,
    () => {
      // Fire-and-forget from cron's perspective, but every path inside
      // executeSchedule is try/caught — no unhandled rejection escapes.
      void executeSchedule(scheduleId, wfId);
    },
    { timezone: tz }
  );

  const alreadyRegistered = jobs.has(scheduleId);
  if (alreadyRegistered) {
    stopAndRemoveJob(scheduleId);
    log('schedule.replaced', { scheduleId, workflowId: wfId });
  }

  jobs.set(scheduleId, { job, workflowId: wfId, expression: cronExpression, timezone: tz });
  if (!metadata.has(scheduleId)) {
    metadata.set(scheduleId, freshMetadata());
  }

  log(alreadyRegistered ? 'schedule.reregistered' : 'schedule.registered', {
    scheduleId,
    workflowId: wfId,
    cron: cronExpression,
    timezone: tz,
  });

  return { id: scheduleId, workflowId: wfId, expression: cronExpression, timezone: tz };
}

/**
 * Stops and removes a single schedule's cron job and all associated
 * in-memory state (execution guard, metadata). Safe to call for an id
 * that isn't registered.
 */
export function unregisterSchedule(id: string): boolean {
  const scheduleId = id?.trim();
  if (!scheduleId) return false;

  const existed = jobs.has(scheduleId);
  stopAndRemoveJob(scheduleId);
  executing.delete(scheduleId);
  metadata.delete(scheduleId);

  if (existed) {
    log('schedule.unregistered', { scheduleId });
  }
  return existed;
}

export function isScheduleRegistered(id: string): boolean {
  return jobs.has(id?.trim());
}

export function listActiveSchedules(): ActiveScheduleInfo[] {
  return Array.from(jobs.entries()).map(([id, entry]) => ({
    id,
    workflowId: entry.workflowId,
    expression: entry.expression,
    timezone: entry.timezone,
    metadata: { ...getOrCreateMetadata(id) },
  }));
}

export function getSchedulerStatus(): SchedulerStatus {
  return {
    started,
    registeredCount: jobs.size,
    activeExecutionCount: executing.size,
    scheduleIds: Array.from(jobs.keys()),
  };
}

// ---------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------

/**
 * Restores enabled schedules from the database and marks the scheduler
 * as started. Idempotent: calling this more than once will not create
 * duplicate jobs (registerSchedule cleanly replaces any existing job for
 * the same id), and will simply re-sync against the current DB state.
 *
 * Never crashes the process: a missing DATABASE_URL, a query failure, or
 * an individual malformed row are all handled and logged; healthy
 * schedules are still restored.
 */
export async function startScheduler(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    log('startup.skipped_no_database');
    started = true;
    return;
  }

  let rows: ScheduleRow[];
  try {
    rows = await query<ScheduleRow>(
      `SELECT id, workflow_id, cron, timezone, enabled FROM schedules WHERE enabled = true`
    );
  } catch (error) {
    logError('startup.restore_query_failed', undefined, error);
    started = true;
    return;
  }

  let restored = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (!row.enabled) continue; // defensive; query already filters this
      await registerSchedule(row.id, row.workflow_id, row.cron, row.timezone);
      restored += 1;
    } catch (error) {
      failed += 1;
      logError('startup.restore_schedule_failed', { scheduleId: row?.id, workflowId: row?.workflow_id }, error);
      // Continue with the remaining rows — one bad schedule must not
      // block restoration of the others.
    }
  }

  log('startup.complete', { restored, failed, total: rows.length });
  started = true;
}

/**
 * Stops every active cron job and clears all in-memory scheduler state.
 * Safe to call multiple times, including when nothing is registered.
 */
export function stopScheduler(): void {
  for (const id of Array.from(jobs.keys())) {
    stopAndRemoveJob(id);
  }
  executing.clear();
  metadata.clear();
  started = false;
  log('shutdown.complete');
}
