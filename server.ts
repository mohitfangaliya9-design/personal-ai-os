import 'dotenv/config';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { initDb, query, exec, closeDb, hasDatabase } from './db.js';
import { createTask, approveTask, rejectTask } from './orchestrator.js';
import { startScheduler, stopScheduler, getSchedulerStatus } from './scheduler.js';

/**
 * server.ts
 * -----------------------------------------------------------------------
 * HTTP transport and process-lifecycle layer for the Personal AI OS.
 *
 * This file owns: startup/shutdown sequencing, authentication, request
 * validation, HTTP error shaping, static file serving, and routing to
 * the existing modules. It contains no planning, AI, memory, scheduler,
 * or MCP tool logic of its own.
 * -----------------------------------------------------------------------
 */

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

const PORT = (() => {
  const raw = Number(process.env.PORT || 3000);
  if (!Number.isInteger(raw) || raw <= 0 || raw > 65535) {
    throw new Error(`Invalid PORT value: "${process.env.PORT}". Must be an integer between 1 and 65535.`);
  }
  return raw;
})();

const APP_TOKEN = process.env.APP_TOKEN || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION_LIKE = NODE_ENV === 'production';

// Practical body size limit: generous enough for workflow definitions /
// long instructions, but not unbounded.
const BODY_LIMIT_BYTES = 2 * 1024 * 1024; // 2 MB

const startedAt = Date.now();

// ---------------------------------------------------------------------
// Safe error sanitization
// -----------------------------------------------------------------------
// Used for both logs and client-facing messages. Never leaks connection
// strings, tokens, keys, passwords, or auth headers, and caps length.

const SENSITIVE_PATTERNS: RegExp[] = [
  /postgres(?:ql)?:\/\/\S+/i,
  /:\/\/[^/\s]*:[^/\s]*@/, // user:pass@host
  /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|authorization)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /bearer\s+\S+/i,
];

function sanitizeMessage(message: string): string {
  const firstLine = message.split('\n')[0]?.trim() || 'Unknown error';
  if (SENSITIVE_PATTERNS.some((p) => p.test(firstLine))) {
    return 'An internal error occurred. Details were withheld for security reasons.';
  }
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
}

function safeErrorMessage(error: unknown): string {
  return sanitizeMessage(error instanceof Error ? error.message : String(error ?? 'Unknown error'));
}

// ---------------------------------------------------------------------
// Lightweight runtime validation helpers (no new dependency)
// -----------------------------------------------------------------------
// Deliberately small and explicit rather than pulling in a schema
// library. Every route below validates its own input through these.

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function requireTrimmedString(value: unknown, field: string, opts: { max: number; min?: number }): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  const min = opts.min ?? 1;
  if (trimmed.length < min) {
    throw new ValidationError(`"${field}" must not be empty.`);
  }
  if (trimmed.length > opts.max) {
    throw new ValidationError(`"${field}" must be at most ${opts.max} characters.`);
  }
  return trimmed;
}

function optionalTrimmedString(value: unknown, field: string, opts: { max: number }, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new ValidationError(`"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > opts.max) {
    throw new ValidationError(`"${field}" must be at most ${opts.max} characters.`);
  }
  return trimmed;
}

/** Ensures a value is JSON-compatible (no functions, no circular refs beyond what JSON.stringify would reject). */
function requireJsonCompatible(value: unknown, field: string, maxBytes: number): unknown {
  if (value === undefined || value === null) return { steps: [] };
  if (typeof value !== 'object') {
    throw new ValidationError(`"${field}" must be a JSON object.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ValidationError(`"${field}" must be JSON-serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new ValidationError(`"${field}" is too large.`);
  }
  return value;
}

function requireIdParam(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`"${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) {
    throw new ValidationError(`"${field}" is invalid.`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------
// Constant-time comparison to avoid timing side channels. Malformed
// headers are rejected the same way as wrong tokens (no extra detail
// about "how close" a guess was).

function timingSafeTokenMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    // Compare against a same-length buffer anyway to keep timing uniform,
    // then always return false.
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function isAuthorized(request: FastifyRequest): boolean {
  if (!APP_TOKEN) return true; // no token configured: dev-mode passthrough

  const auth = request.headers.authorization;
  if (typeof auth !== 'string') return false;

  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) return false;

  const provided = auth.slice(prefix.length);
  if (!provided) return false;

  return timingSafeTokenMatch(provided, APP_TOKEN);
}

// ---------------------------------------------------------------------
// App
// ---------------------------------------------------------------------

const app = Fastify({
  logger: true,
  bodyLimit: BODY_LIMIT_BYTES,
});

if (!APP_TOKEN) {
  if (IS_PRODUCTION_LIKE) {
    app.log.warn('APP_TOKEN is not set while NODE_ENV=production. API and MCP endpoints are unauthenticated.');
  } else {
    app.log.info('APP_TOKEN is not set. API and MCP endpoints are open (development mode).');
  }
}

// ---- Security headers (no new dependency) ------------------------------

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  // Deliberately no restrictive CSP here: the existing dashboard is
  // served as static assets with inline-friendly assumptions we cannot
  // verify from server.ts alone, and an overly strict policy could break
  // it. X-Content-Type-Options + Referrer-Policy are safe universally.
  return payload;
});

// ---- Authentication ------------------------------------------------------

app.addHook('preHandler', async (request, reply) => {
  const isProtected = request.url.startsWith('/api') || request.url.startsWith('/mcp');
  if (!isProtected) return;

  if (!isAuthorized(request)) {
    request.log.warn({ path: request.url }, 'Unauthorized request rejected');
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

// ---- Global error handler --------------------------------------------

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ValidationError) {
    return reply.code(400).send({ error: error.message });
  }

  // Fastify's own payload-too-large / malformed-JSON errors carry a
  // statusCode we can trust for client-facing status; message is still
  // sanitized before it ever reaches the client.
  const statusCode = typeof (error as { statusCode?: number }).statusCode === 'number'
    ? (error as { statusCode: number }).statusCode
    : 500;

  const safeMessage = statusCode >= 500 ? 'Internal server error.' : safeErrorMessage(error);

  request.log.error({ path: request.url, statusCode, err: safeErrorMessage(error) }, 'Request failed');
  return reply.code(statusCode).send({ error: safeMessage });
});

app.setNotFoundHandler((request, reply) => {
  reply.code(404).send({ error: 'Not found' });
});

// ---------------------------------------------------------------------
// Health / readiness
// -----------------------------------------------------------------------
// "configured" only ever reflects environment presence, never live
// connectivity — health checks never perform expensive AI calls.

let dbReady = false;
let schedulerReady = false;

function buildHealthPayload() {
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const aiConfigured = Boolean(process.env.AI_API_KEY && process.env.AI_MODEL);

  let schedulerStatus: ReturnType<typeof getSchedulerStatus> | { started: boolean } = { started: schedulerReady };
  try {
    schedulerStatus = getSchedulerStatus();
  } catch {
    // Keep health reporting resilient even if scheduler status can't be read.
  }

  return {
    status: dbReady || !databaseConfigured ? 'healthy' : 'degraded',
    database: databaseConfigured ? 'configured' : 'memory-dev',
    databaseReady: dbReady,
    ai: aiConfigured ? 'configured' : 'not-configured',
    mcp: 'online',
    scheduler: schedulerStatus,
    authRequired: Boolean(APP_TOKEN),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

app.get('/health', async () => buildHealthPayload());

// Preserved for backward compatibility with existing dashboard/clients;
// now consistent with /health rather than a separately-maintained shape.
app.get('/api/health', async () => buildHealthPayload());

app.get('/ready', async (_request, reply) => {
  const ready = dbReady && schedulerReady;
  if (!ready) {
    reply.code(503);
  }
  return { ready, database: dbReady, scheduler: schedulerReady };
});

// ---------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

app.get('/', async (_request, reply) => reply.sendFile('index.html'));

// ---------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------

app.get('/api/agents', async (_request, reply) => {
  try {
    return await query(`SELECT * FROM agents ORDER BY created_at DESC`);
  } catch (error) {
    _request.log.error({ err: safeErrorMessage(error) }, 'Failed to list agents');
    return reply.code(500).send({ error: 'Failed to load agents.' });
  }
});

app.post('/api/agents', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;

  const name = requireTrimmedString(body.name, 'name', { max: 200 });
  const description = optionalTrimmedString(body.description, 'description', { max: 2000 });
  const role = optionalTrimmedString(body.role, 'role', { max: 100 }, 'general');
  const instructions = optionalTrimmedString(body.instructions, 'instructions', { max: 4000 });

  const id = `agent_${randomUUID()}`;

  try {
    await exec(
      `INSERT INTO agents (id, name, description, role, instructions) VALUES ($1, $2, $3, $4, $5)`,
      [id, name, description, role, instructions]
    );
  } catch (error) {
    request.log.error({ err: safeErrorMessage(error) }, 'Failed to create agent');
    return reply.code(500).send({ error: 'Failed to create agent.' });
  }

  return { id, name, description, role, instructions };
});

// ---------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------

app.get('/api/workflows', async (request, reply) => {
  try {
    return await query(`SELECT * FROM workflows ORDER BY created_at DESC`);
  } catch (error) {
    request.log.error({ err: safeErrorMessage(error) }, 'Failed to list workflows');
    return reply.code(500).send({ error: 'Failed to load workflows.' });
  }
});

app.post('/api/workflows', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;

  const name = requireTrimmedString(body.name, 'name', { max: 200 });
  const description = optionalTrimmedString(body.description, 'description', { max: 2000 });
  const definition = requireJsonCompatible(body.definition, 'definition', 512 * 1024);

  const id = `wf_${randomUUID()}`;

  try {
    await exec(
      `INSERT INTO workflows (id, name, description, definition) VALUES ($1, $2, $3, $4)`,
      [id, name, description, JSON.stringify(definition)]
    );
  } catch (error) {
    request.log.error({ err: safeErrorMessage(error) }, 'Failed to create workflow');
    return reply.code(500).send({ error: 'Failed to create workflow.' });
  }

  return { id, name, description, definition };
});

// ---------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------

app.get('/api/tasks', async (request, reply) => {
  try {
    return await query(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100`);
  } catch (error) {
    request.log.error({ err: safeErrorMessage(error) }, 'Failed to list tasks');
    return reply.code(500).send({ error: 'Failed to load tasks.' });
  }
});

app.post('/api/tasks', async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const taskRequest = requireTrimmedString(body.request, 'request', { max: 5000 });

  try {
    return await createTask(taskRequest);
  } catch (error) {
    request.log.error({ err: safeErrorMessage(error) }, 'Task creation failed');
    return reply.code(500).send({ error: 'Failed to create task.' });
  }
});

app.post('/api/tasks/:id/approve', async (request, reply) => {
  const { id } = request.params as { id: string };
  const taskId = requireIdParam(id, 'id');

  try {
    return await approveTask(taskId);
  } catch (error) {
    const message = safeErrorMessage(error);
    request.log.warn({ taskId, err: message }, 'Task approval failed');
    if (/not found/i.test(message)) return reply.code(404).send({ error: message });
    if (/not waiting for approval/i.test(message)) return reply.code(409).send({ error: message });
    return reply.code(500).send({ error: 'Failed to approve task.' });
  }
});

app.post('/api/tasks/:id/reject', async (request, reply) => {
  const { id } = request.params as { id: string };
  const taskId = requireIdParam(id, 'id');

  try {
    return await rejectTask(taskId);
  } catch (error) {
    const message = safeErrorMessage(error);
    request.log.warn({ taskId, err: message }, 'Task rejection failed');
    return reply.code(500).send({ error: 'Failed to reject task.' });
  }
});

// ---------------------------------------------------------------------
// MCP
// -----------------------------------------------------------------------
// Authentication is already enforced by the shared preHandler hook above
// for any path starting with /mcp — no separate auth logic is duplicated
// here. Reuses the existing handler from mcp.ts without modification.

const { mcpHandler } = await import('./mcp.js');
const mcpNode = toNodeHandler(mcpHandler);

app.all('/mcp', async (request, reply) => {
  try {
    await mcpNode(request.raw, reply.raw, request.body);
  } catch (error) {
    request.log.error({ err: safeErrorMessage(error) }, 'MCP request handling failed');
    if (!reply.raw.headersSent) {
      reply.code(500).send({ error: 'MCP request failed.' });
    }
  }
});

// ---------------------------------------------------------------------
// Startup sequence
// -----------------------------------------------------------------------
// DB init -> scheduler start -> listen. Nothing accepts traffic until
// all of this has completed; a failure anywhere aborts startup cleanly.

async function start(): Promise<void> {
  try {
    await initDb();
    dbReady = true;
    app.log.info(hasDatabase() ? 'Database initialized.' : 'Running with in-memory development database fallback.');
  } catch (error) {
    app.log.error({ err: safeErrorMessage(error) }, 'Database initialization failed');
    // The application's architecture relies on persistence for tasks,
    // agents, workflows, etc.; a failed DB init is treated as fatal
    // rather than silently continuing in a half-working state.
    throw error;
  }

  try {
    await startScheduler();
    schedulerReady = true;
    app.log.info('Scheduler started.');
  } catch (error) {
    // Scheduler failures should not be fatal to the whole application —
    // scheduling is an enhancement, not a hard dependency for serving
    // API traffic — but must be visible in logs and health/readiness.
    schedulerReady = false;
    app.log.error({ err: safeErrorMessage(error) }, 'Scheduler startup failed; continuing without active schedules.');
  }

  try {
    await app.listen({ host: '0.0.0.0', port: PORT });
  } catch (error) {
    app.log.error({ err: safeErrorMessage(error) }, 'Failed to start HTTP server');
    await shutdown('startup-failure').catch(() => {});
    process.exit(1);
  }

  // Only ever logged after listen() has actually succeeded.
  console.log(`Personal AI OS running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
}

// ---------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------
// Idempotent: repeated signals or repeated calls are safe. Order:
// stop accepting new requests -> stop scheduler -> close Fastify ->
// close DB. Each step is isolated so one failure doesn't skip the rest.

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ reason }, 'Shutting down');

  try {
    stopScheduler();
    app.log.info('Scheduler stopped.');
  } catch (error) {
    app.log.error({ err: safeErrorMessage(error) }, 'Error stopping scheduler during shutdown');
  }

  try {
    await app.close();
    app.log.info('HTTP server closed.');
  } catch (error) {
    app.log.error({ err: safeErrorMessage(error) }, 'Error closing HTTP server during shutdown');
  }

  try {
    await closeDb();
    app.log.info('Database connections closed.');
  } catch (error) {
    app.log.error({ err: safeErrorMessage(error) }, 'Error closing database during shutdown');
  }
}

let signalCount = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signalCount += 1;
    void shutdown(signal).finally(() => {
      process.exit(0);
    });
    // A second signal while shutdown is in progress forces an immediate exit
    // instead of hanging forever on a stuck cleanup step.
    if (signalCount > 1) {
      process.exit(1);
    }
  });
}

process.on('unhandledRejection', (reason) => {
  app.log.error({ err: safeErrorMessage(reason) }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  app.log.error({ err: safeErrorMessage(error) }, 'Uncaught exception');
  void shutdown('uncaughtException').finally(() => {
    process.exit(1);
  });
});

await start();
