import crypto from 'node:crypto';
import { exec, query } from './db.js';
import { planRequest } from './planner.js';
import type { TaskStatus } from './types.js';

function id(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }

export async function createTask(request: string) {
  const taskId = id('task');
  const plan = await planRequest(request);
  const approval = plan.steps.some(s => s.requiresApproval) ? 'required' : 'not_required';
  const status: TaskStatus = approval === 'required' ? 'WAITING_APPROVAL' : 'RUNNING';
  if (await hasPg()) {
    await exec(`INSERT INTO tasks (id, request, status, current_step, progress, approval_state) VALUES ($1,$2,$3,$4,$5,$6)`, [taskId, request, status, 'understand', 20, approval]);
    await exec(`INSERT INTO audit_logs (event, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4)`, ['task.created', 'task', taskId, JSON.stringify({ plan })]);
  }
  if (status === 'RUNNING') await executeTask(taskId, request, plan);
  return { id: taskId, status, plan };
}

async function hasPg() { return Boolean(process.env.DATABASE_URL); }

export async function executeTask(taskId: string, request: string, plan?: Awaited<ReturnType<typeof planRequest>>) {
  const p = plan ?? await planRequest(request);
  if (await hasPg()) await exec(`UPDATE tasks SET status='RUNNING', current_step='execute', progress=60, updated_at=now() WHERE id=$1`, [taskId]);
  // Safe MVP execution: the system creates a verified execution record but does not invent external side effects.
  const result = {
    message: 'Task executed by Personal AI OS orchestration layer.',
    request,
    steps: p.steps.map(s => ({ id: s.id, action: s.action, status: 'completed' })),
    externalSideEffect: false,
    note: 'Connect a permitted tool/API to perform external actions.'
  };
  if (await hasPg()) {
    await exec(`UPDATE tasks SET status='COMPLETED', current_step='verified', progress=100, result=$2, updated_at=now() WHERE id=$1`, [taskId, JSON.stringify(result)]);
    await exec(`INSERT INTO audit_logs (event, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4)`, ['task.completed', 'task', taskId, JSON.stringify(result)]);
  }
  return result;
}

export async function approveTask(taskId: string) {
  if (await hasPg()) {
    const rows = await query<{ request: string; status: string }> (`SELECT request, status FROM tasks WHERE id=$1`, [taskId]);
    if (!rows[0]) throw new Error('Task not found');
    if (rows[0].status !== 'WAITING_APPROVAL') throw new Error('Task is not waiting for approval');
    await exec(`UPDATE tasks SET approval_state='approved', status='RUNNING', updated_at=now() WHERE id=$1`, [taskId]);
    return executeTask(taskId, rows[0].request);
  }
  throw new Error('Approval persistence requires DATABASE_URL in this build.');
}

export async function rejectTask(taskId: string) {
  if (await hasPg()) await exec(`UPDATE tasks SET approval_state='rejected', status='CANCELLED', updated_at=now() WHERE id=$1`, [taskId]);
  return { id: taskId, status: 'CANCELLED' };
}
