import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { initDb, query, exec } from './db.js';
import { createTask, approveTask, rejectTask } from './orchestrator.js';
import { startScheduler } from './scheduler.js';
import { randomUUID } from 'node:crypto';

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);
const token = process.env.APP_TOKEN || '';

await initDb();
await startScheduler();

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

app.get('/health', async () => ({ status: 'healthy', database: Boolean(process.env.DATABASE_URL) ? 'configured' : 'memory-dev', ai: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL) ? 'configured' : 'not-configured', mcp: 'online' }));

app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api') && !request.url.startsWith('/mcp')) return;
  if (!token) return;
  const auth = request.headers.authorization;
  if (auth !== `Bearer ${token}`) return reply.code(401).send({ error: 'Unauthorized' });
});

app.get('/api/agents', async () => query(`SELECT * FROM agents ORDER BY created_at DESC`));
app.post('/api/agents', async (request, reply) => {
  const body = request.body as { name?: string; description?: string; role?: string; instructions?: string };
  if (!body.name) return reply.code(400).send({ error: 'name is required' });
  const id = `agent_${randomUUID()}`;
  await exec(`INSERT INTO agents (id,name,description,role,instructions) VALUES ($1,$2,$3,$4,$5)`, [id, body.name, body.description || '', body.role || 'general', body.instructions || '']);
  return { id, ...body };
});

app.get('/api/workflows', async () => query(`SELECT * FROM workflows ORDER BY created_at DESC`));
app.post('/api/workflows', async (request, reply) => {
  const body = request.body as { name?: string; description?: string; definition?: unknown };
  if (!body.name) return reply.code(400).send({ error: 'name is required' });
  const id = `wf_${randomUUID()}`;
  await exec(`INSERT INTO workflows (id,name,description,definition) VALUES ($1,$2,$3,$4)`, [id, body.name, body.description || '', JSON.stringify(body.definition || { steps: [] })]);
  return { id, ...body };
});

app.get('/api/tasks', async () => query(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100`));
app.post('/api/tasks', async (request, reply) => {
  const body = request.body as { request?: string };
  if (!body.request) return reply.code(400).send({ error: 'request is required' });
  return createTask(body.request);
});
app.post('/api/tasks/:id/approve', async (request) => approveTask((request.params as { id: string }).id));
app.post('/api/tasks/:id/reject', async (request) => rejectTask((request.params as { id: string }).id));
app.get('/api/health', async () => ({ status: 'ok', database: Boolean(process.env.DATABASE_URL), ai: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL), mcp: true }));

const mcpNode = toNodeHandler((await import('./mcp.js')).mcpHandler);
app.all('/mcp', async (request, reply) => mcpNode(request.raw, reply.raw, request.body));

app.get('/', async (_request, reply) => reply.sendFile('index.html'));

await app.listen({ host: '0.0.0.0', port });
console.log(`Personal AI OS running on http://localhost:${port}`);
console.log(`MCP endpoint: http://localhost:${port}/mcp`);
