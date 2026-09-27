/**
 * mcp.ts
 * -----------------------------------------------------------------------
 * MCP gateway for the Personal AI OS.
 *
 * This file is an integration layer only. It validates external input,
 * calls into the existing subsystems (orchestrator.ts, memory.ts,
 * scheduler.ts, db.ts), and formats their results for MCP clients.
 *
 * It does NOT:
 *   - implement a second task executor, scheduler, or database layer
 *   - bypass human approval or orchestrator controls
 *   - execute arbitrary SQL, shell, or JS from external input
 *   - expose secrets, connection strings, or stack traces
 * -----------------------------------------------------------------------
 */

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import crypto from 'node:crypto';
import { createTask, approveTask, rejectTask } from './orchestrator.js';
import { exec, query } from './db.js';
import { registerSchedule } from './scheduler.js';
import { saveMemory, searchMemory } from './memory.js';

// ---------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------
// Every tool returns one of these two shapes. Success responses carry
// the real data from the underlying subsystem; error responses carry a
// short, sanitized message only — never a raw Error object, stack trace,
// or anything that could contain a secret.

type ToolContent = { content: { type: 'text'; text: string }[] };

function ok(data: unknown): ToolContent {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): ToolContent {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}

/** Patterns that must never reach the client, even inside an error message. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /postgres(?:ql)?:\/\/\S+/i,
  /:\/\/[^/\s]*:[^/\s]*@/, // user:pass@host style connection strings
  /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|authorization)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const firstLine = raw.split('\n')[0]?.trim() || 'Unknown error';

  if (SENSITIVE_PATTERNS.some((p) => p.test(firstLine))) {
    return 'An internal error occurred. Details were withheld for security reasons.';
  }

  // Cap length so a verbose driver/error message can't dump large
  // internal detail (queries, file paths, etc.) into the response.
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
}

/**
 * Wraps a tool implementation so that:
 *   - a thrown error never crashes the MCP server or reaches the client raw
 *   - a failure is always reported as an error, never disguised as success
 */
function safeTool<TInput>(fn: (input: TInput) => Promise<unknown>) {
  return async (input: TInput): Promise<ToolContent> => {
    try {
      const data = await fn(input);
      return ok(data);
    } catch (error) {
      console.error('MCP tool error:', error instanceof Error ? error.message : error);
      return fail(sanitizeError(error));
    }
  };
}

function requireDatabase(operation: string): void {
  if (!process.env.DATABASE_URL) {
    throw new Error(`${operation} requires a configured database (DATABASE_URL is not set).`);
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------
// JSON-safe schema (for workflow definitions) — avoids z.any()
// ---------------------------------------------------------------------

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

type JsonValue = z.infer<typeof jsonPrimitiveSchema> | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

const workflowDefinitionSchema = z.record(z.string(), jsonValueSchema);

// ---------------------------------------------------------------------
// Shared field schemas — comprehensive validation, sensible size limits
// ---------------------------------------------------------------------

const requestTextSchema = z.string().trim().min(1, 'request must not be empty').max(5000);
const idSchema = z.string().trim().min(1, 'id must not be empty').max(200);
const nameSchema = z.string().trim().min(1, 'name must not be empty').max(200);
const descriptionSchema = z.string().trim().max(2000).default('');
const roleSchema = z.string().trim().min(1).max(100).default('general');
const instructionsSchema = z.string().trim().max(4000).default('');
const memoryTextSchema = z.string().trim().min(1, 'memory text must not be empty').max(10000);
const memoryKindSchema = z.string().trim().min(1).max(50).default('long_term');
const searchTermSchema = z.string().trim().min(1, 'search term must not be empty').max(500);

const CRON_PATTERN = /^\S+(\s+\S+){4,5}$/; // 5 or 6 whitespace-separated fields

const cronSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => CRON_PATTERN.test(value), {
    message: 'cron must be a standard 5 or 6 field cron expression',
  });

function isKnownTimeZone(tz: string): boolean {
  try {
    // Intl.supportedValuesOf is available in modern Node runtimes; fall
    // back to a lenient construction check if it's not.
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      'timeZone'
    );
    if (supported) return supported.includes(tz);
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .default('Asia/Kolkata')
  .refine((value) => isKnownTimeZone(value), { message: 'timezone is not a recognized IANA time zone' });

// ---------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------

export const mcpHandler = createMcpHandler(() => {
  const server = new McpServer({ name: 'personal-ai-os', version: '0.2.0' });

  // -- Tasks -----------------------------------------------------------

  server.registerTool(
    'create_task',
    {
      description:
        'Create a task from a natural-language request. The request is planned by the AI/deterministic ' +
        'planner and, if any step is HIGH or CRITICAL risk, the task is created in WAITING_APPROVAL state ' +
        'instead of running immediately. Returns the created task id, status, and plan.',
      inputSchema: z.object({ request: requestTextSchema }),
    },
    safeTool(async ({ request }) => createTask(request))
  );

  server.registerTool(
    'get_task',
    {
      description:
        'Look up a single task by id. Returns the task record, or {"error":"Task not found"} if no such ' +
        'task exists. Does not modify anything.',
      inputSchema: z.object({ id: idSchema }),
    },
    safeTool(async ({ id }) => {
      requireDatabase('Task lookup');
      const rows = await query(`SELECT * FROM tasks WHERE id = $1`, [id]);
      return rows[0] ?? { error: 'Task not found' };
    })
  );

  server.registerTool(
    'approve_task',
    {
      description:
        'Approve a task currently in WAITING_APPROVAL state, allowing its plan to execute. Delegates entirely ' +
        'to the orchestrator; this tool does not itself bypass or alter the approval workflow.',
      inputSchema: z.object({ id: idSchema }),
    },
    safeTool(async ({ id }) => approveTask(id))
  );

  server.registerTool(
    'reject_task',
    {
      description:
        'Reject a task currently in WAITING_APPROVAL state, cancelling it without executing its plan.',
      inputSchema: z.object({ id: idSchema }),
    },
    safeTool(async ({ id }) => rejectTask(id))
  );

  // -- Agents ------------------------------------------------------------

  server.registerTool(
    'create_agent',
    {
      description:
        'Create a new agent definition (name, description, role, instructions) and persist it to the agents ' +
        'table. Does not grant any tools or permissions beyond the defaults already defined by the existing ' +
        'architecture. Requires a configured database.',
      inputSchema: z.object({
        name: nameSchema,
        description: descriptionSchema,
        role: roleSchema,
        instructions: instructionsSchema,
      }),
    },
    safeTool(async ({ name, description, role, instructions }) => {
      requireDatabase('Agent creation');

      const existing = await query<{ id: string }>(
        `SELECT id FROM agents WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [name]
      );
      if (existing[0]) {
        return { id: existing[0].id, name, created: false, message: 'An agent with this name already exists.' };
      }

      const id = newId('agent');
      await exec(
        `INSERT INTO agents (id, name, description, role, instructions) VALUES ($1, $2, $3, $4, $5)`,
        [id, name, description, role, instructions]
      );
      return { id, name, description, role, instructions, created: true };
    })
  );

  server.registerTool(
    'list_agents',
    {
      description: 'List all registered agents, most recently created first. Requires a configured database.',
      inputSchema: z.object({}).optional(),
    },
    safeTool(async () => {
      requireDatabase('Listing agents');
      return query(`SELECT id, name, description, role, status, version, created_at, updated_at FROM agents ORDER BY created_at DESC`);
    })
  );

  // -- Workflows -----------------------------------------------------------

  server.registerTool(
    'create_workflow',
    {
      description:
        'Create a workflow definition (name, description, structured JSON definition) and persist it. The ' +
        'definition is stored as data only — it is never executed or interpreted as code by this tool.',
      inputSchema: z.object({
        name: nameSchema,
        description: descriptionSchema,
        definition: workflowDefinitionSchema.default({ steps: [] }),
      }),
    },
    safeTool(async ({ name, description, definition }) => {
      requireDatabase('Workflow creation');
      const id = newId('wf');
      await exec(
        `INSERT INTO workflows (id, name, description, definition) VALUES ($1, $2, $3, $4)`,
        [id, name, description, JSON.stringify(definition)]
      );
      return { id, name, description, definition, status: 'draft' };
    })
  );

  server.registerTool(
    'list_workflows',
    {
      description: 'List all workflows, most recently created first. Requires a configured database.',
      inputSchema: z.object({}).optional(),
    },
    safeTool(async () => {
      requireDatabase('Listing workflows');
      return query(`SELECT id, name, description, definition, status, created_at, updated_at FROM workflows ORDER BY created_at DESC`);
    })
  );

  server.registerTool(
    'run_workflow',
    {
      description:
        'Run a workflow by creating an execution task through the orchestrator\'s normal planning and ' +
        'approval pipeline. If the workflow requires approval, the returned task will be in WAITING_APPROVAL ' +
        'state, not "completed" — use approve_task to proceed. Does not implement a separate execution engine.',
      inputSchema: z.object({ workflowId: idSchema }),
    },
    safeTool(async ({ workflowId }) => {
      if (process.env.DATABASE_URL) {
        const rows = await query<{ id: string; name: string }>(
          `SELECT id, name FROM workflows WHERE id = $1`,
          [workflowId]
        );
        if (!rows[0]) {
          throw new Error(`Workflow "${workflowId}" was not found.`);
        }
        return createTask(`Run workflow "${rows[0].name}" (${workflowId})`);
      }
      // No database configured: cannot verify the workflow exists, but we
      // still route through the real orchestrator rather than fabricating
      // a result — the task itself will honestly reflect what happened.
      return createTask(`Run workflow ${workflowId}`);
    })
  );

  server.registerTool(
    'schedule_workflow',
    {
      description:
        'Register a recurring schedule (cron + timezone) for a workflow, using the existing scheduler. The ' +
        'schedule is only persisted after the scheduler confirms registration succeeded — a failed ' +
        'registration is never recorded as an active schedule. Requires a configured database.',
      inputSchema: z.object({
        workflowId: idSchema,
        cron: cronSchema,
        timezone: timezoneSchema,
      }),
    },
    safeTool(async ({ workflowId, cron, timezone }) => {
      requireDatabase('Workflow scheduling');

      const wf = await query<{ id: string }>(`SELECT id FROM workflows WHERE id = $1`, [workflowId]);
      if (!wf[0]) {
        throw new Error(`Workflow "${workflowId}" was not found.`);
      }

      const id = newId('sch');

      // Register with the real scheduler first; only persist the row if
      // that succeeds, so a failed registration can never look like an
      // active schedule.
      const registration = await registerSchedule(id, workflowId, cron, timezone);

      await exec(
        `INSERT INTO schedules (id, workflow_id, cron, timezone) VALUES ($1, $2, $3, $4)`,
        [id, workflowId, cron, timezone]
      );

      return { id, workflowId, cron, timezone, enabled: true, registration };
    })
  );

  // -- Memory --------------------------------------------------------------

  server.registerTool(
    'save_memory',
    {
      description:
        'Save a piece of text as a structured memory for later retrieval. The memory subsystem refuses to ' +
        'store content that looks like a secret or credential, and deduplicates near-identical entries — this ' +
        'tool reports whichever of those the subsystem actually did.',
      inputSchema: z.object({ text: memoryTextSchema, kind: memoryKindSchema }),
    },
    safeTool(async ({ text, kind }) => saveMemory(text, kind))
  );

  server.registerTool(
    'search_memory',
    {
      description: 'Search stored memories by substring match, most relevant/recent first.',
      inputSchema: z.object({ term: searchTermSchema }),
    },
    safeTool(async ({ term }) => searchMemory(term))
  );

  // -- Diagnostics -----------------------------------------------------------
  // Deliberately reports only booleans/status strings, never env values.

  server.registerTool(
    'diagnose_system',
    {
      description:
        'Return a safe diagnostic summary of subsystem configuration (database, AI provider, MCP). Never ' +
        'returns secret values, connection strings, or raw environment variables.',
      inputSchema: z.object({}).optional(),
    },
    safeTool(async () => ({
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL),
      aiProvider: process.env.AI_PROVIDER || 'openai',
      mcp: 'online',
      timestamp: new Date().toISOString(),
      note: 'No secrets are returned.',
    }))
  );

  server.registerTool(
    'system_health',
    {
      description: 'Return a brief, non-sensitive system health status for monitoring/dashboards.',
      inputSchema: z.object({}).optional(),
    },
    safeTool(async () => ({
      status: 'ok',
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      aiConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL),
      mcp: 'online',
      timestamp: new Date().toISOString(),
    }))
  );

  return server;
}, { responseMode: 'json' });
