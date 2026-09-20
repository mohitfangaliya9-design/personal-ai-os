import cron, { type ScheduledTask } from 'node-cron';
import { query } from './db.js';
import { createTask } from './orchestrator.js';
const jobs = new Map<string, ScheduledTask>();

export async function registerSchedule(id: string, workflowId: string, expression: string, timezone = process.env.TIMEZONE || 'Asia/Kolkata') {
  if (!cron.validate(expression)) throw new Error('Invalid cron expression');
  jobs.get(id)?.stop();
  const job = cron.schedule(expression, async () => {
    try { await createTask(`Run scheduled workflow ${workflowId}`); } catch (e) { console.error('Scheduled workflow failed', e); }
  }, { timezone });
  jobs.set(id, job);
  return { id, workflowId, expression, timezone };
}

export async function startScheduler() {
  if (!process.env.DATABASE_URL) return;
  const rows = await query<{ id: string; workflow_id: string; cron: string; timezone: string; enabled: boolean }>(`SELECT * FROM schedules WHERE enabled=true`);
  for (const schedule of rows) await registerSchedule(schedule.id, schedule.workflow_id, schedule.cron, schedule.timezone);
}
