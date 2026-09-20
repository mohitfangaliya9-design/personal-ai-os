import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createTask, approveTask, rejectTask } from './orchestrator.js';
import { exec } from './db.js';
import { registerSchedule } from './scheduler.js';
import { saveMemory, searchMemory } from './memory.js';
import crypto from 'node:crypto';
import { query } from './db.js';

export const mcpHandler = createMcpHandler(() => {
  const server = new McpServer({ name: 'personal-ai-os', version: '0.1.0' });

  server.registerTool('create_task', {
    description: 'Create a personal AI task. High-risk requests are paused for approval.',
    inputSchema: z.object({ request: z.string().min(1).max(5000) })
  }, async ({ request }) => ({ content: [{ type: 'text', text: JSON.stringify(await createTask(request)) }] }));


  server.registerTool('create_agent', { description: 'Create a controlled agent definition.', inputSchema: z.object({ name: z.string().min(1), description: z.string().default(''), role: z.string().default('general'), instructions: z.string().default('') }) }, async ({ name, description, role, instructions }) => {
    const id = `agent_${crypto.randomUUID()}`;
    await exec(`INSERT INTO agents (id,name,description,role,instructions) VALUES ($1,$2,$3,$4,$5)`, [id,name,description,role,instructions]);
    return { content: [{ type: 'text', text: JSON.stringify({ id,name,description,role,instructions }) }] };
  });

  server.registerTool('create_workflow', { description: 'Create a workflow definition.', inputSchema: z.object({ name: z.string().min(1), description: z.string().default(''), definition: z.record(z.string(), z.any()).default({ steps: [] }) }) }, async ({ name, description, definition }) => {
    const id = `wf_${crypto.randomUUID()}`;
    await exec(`INSERT INTO workflows (id,name,description,definition) VALUES ($1,$2,$3,$4)`, [id,name,description,JSON.stringify(definition)]);
    return { content: [{ type: 'text', text: JSON.stringify({ id,name,description,definition }) }] };
  });

  server.registerTool('run_workflow', { description: 'Run a workflow by creating an execution task.', inputSchema: z.object({ workflowId: z.string() }) }, async ({ workflowId }) => ({ content: [{ type: 'text', text: JSON.stringify(await createTask(`Run workflow ${workflowId}`)) }] }));

  server.registerTool('schedule_workflow', { description: 'Schedule a workflow with a cron expression.', inputSchema: z.object({ workflowId: z.string(), cron: z.string(), timezone: z.string().default('Asia/Kolkata') }) }, async ({ workflowId, cron, timezone }) => {
    if (!process.env.DATABASE_URL) throw new Error('Persistent scheduling requires DATABASE_URL');
    const id = `sch_${crypto.randomUUID()}`;
    await exec(`INSERT INTO schedules (id,workflow_id,cron,timezone) VALUES ($1,$2,$3,$4)`, [id,workflowId,cron,timezone]);
    return { content: [{ type: 'text', text: JSON.stringify(await registerSchedule(id,workflowId,cron,timezone)) }] };
  });

  server.registerTool('save_memory', { description: 'Save user-approved memory.', inputSchema: z.object({ text: z.string().min(1), kind: z.string().default('long_term') }) }, async ({ text, kind }) => ({ content: [{ type: 'text', text: JSON.stringify(await saveMemory(text,kind)) }] }));
  server.registerTool('search_memory', { description: 'Search stored memory.', inputSchema: z.object({ term: z.string().min(1) }) }, async ({ term }) => ({ content: [{ type: 'text', text: JSON.stringify(await searchMemory(term)) }] }));

  server.registerTool('get_task', {
    description: 'Get a task by ID.', inputSchema: z.object({ id: z.string() })
  }, async ({ id }) => {
    const rows = await query(`SELECT * FROM tasks WHERE id=$1`, [id]);
    return { content: [{ type: 'text', text: JSON.stringify(rows[0] ?? { error: 'Task not found' }) }] };
  });

  server.registerTool('list_agents', { description: 'List registered agents.' }, async () => {
    const rows = await query(`SELECT * FROM agents ORDER BY created_at DESC`);
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  });

  server.registerTool('list_workflows', { description: 'List workflows.' }, async () => {
    const rows = await query(`SELECT * FROM workflows ORDER BY created_at DESC`);
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  });

  server.registerTool('approve_task', { description: 'Approve a task waiting for human approval.', inputSchema: z.object({ id: z.string() }) }, async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(await approveTask(id)) }] }));
  server.registerTool('reject_task', { description: 'Reject a task waiting for human approval.', inputSchema: z.object({ id: z.string() }) }, async ({ id }) => ({ content: [{ type: 'text', text: JSON.stringify(await rejectTask(id)) }] }));

  server.registerTool('diagnose_system', { description: 'Return a safe system diagnostic summary.' }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ databaseConfigured: Boolean(process.env.DATABASE_URL), aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL), mcp: 'online', note: 'No secrets are returned.' }) }] }));
  server.registerTool('system_health', { description: 'Return non-sensitive system health.' }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'ok', databaseConfigured: Boolean(process.env.DATABASE_URL), aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL), mcp: 'online' }) }] }));

  return server;
}, { responseMode: 'json' });
