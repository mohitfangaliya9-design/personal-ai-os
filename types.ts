/**
 * types.ts
 * -----------------------------------------------------------------------
 * Central shared TypeScript type-definition layer for the Personal AI OS.
 *
 * Pure types only — no runtime logic, no AI/database/planning/execution
 * code, no external dependencies. Other files (ai.ts, planner.ts,
 * orchestrator.ts, memory.ts, db.ts) import from here; this file does
 * not import from them, to avoid circular imports.
 * -----------------------------------------------------------------------
 */

// ---------------------------------------------------------------------
// Core finite-state types (preserved exactly as-is)
// ---------------------------------------------------------------------

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type TaskStatus =
  | 'QUEUED'
  | 'PLANNING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Approval decision state for a task/step awaiting human review.
 * Kept as its own type (rather than folded into TaskStatus) since a task
 * can be "not requiring approval" independently of its execution status.
 */
export type ApprovalState = 'not_required' | 'required' | 'approved' | 'rejected';

/** Status of an individual plan step's execution attempt. */
export type StepExecutionStatus = 'pending' | 'completed' | 'failed' | 'skipped' | 'no_executor';

/** Lifecycle status for an Agent record. */
export type AgentStatus = 'active' | 'paused' | 'disabled';

/** Lifecycle status for a Workflow definition. */
export type WorkflowStatus = 'draft' | 'active' | 'archived';

// ---------------------------------------------------------------------
// JSON-safe helpers
// -----------------------------------------------------------------------
// Used instead of `any` for arbitrary structured data (DB JSONB columns,
// AI-provided metadata, tool payloads, etc.) so callers must narrow
// before use, without every such field being untyped.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------
// Plan / PlanStep (preserved shape, named + extended)
// ---------------------------------------------------------------------

/**
 * A single step within a Plan.
 * Named and exported on its own (previously only an inline object type)
 * so other files can reference it directly instead of indexing into
 * Plan['steps'][number].
 */
export interface PlanStep {
  id: string;
  action: string;
  risk: Risk;
  requiresApproval: boolean;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  needsAI: boolean;
}

// ---------------------------------------------------------------------
// Execution results
// -----------------------------------------------------------------------
// Explicit success/failure representation so a failed operation can
// never be structurally indistinguishable from a successful one.

export interface StepResult {
  id: string;
  action: string;
  risk: Risk;
  requiresApproval: boolean;
  status: StepExecutionStatus;
  executorName?: string;
  detail?: unknown;
  error?: string;
}

/** Discriminated-union result for any execution-style operation. */
export type ExecutionResult<TData = unknown> =
  | { success: true; data: TData; error?: undefined }
  | { success: false; data?: undefined; error: string };

export interface TaskExecutionResult {
  message: string;
  request: string;
  steps: StepResult[];
  success: boolean;
  externalSideEffect: boolean;
  note?: string;
  /** Arbitrary additional data produced during execution (e.g. created agent info). */
  detail?: unknown;
}

// ---------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------

export interface Task {
  id: string;
  request: string;
  status: TaskStatus;
  agentId?: string | null;
  workflowId?: string | null;
  currentStep?: string | null;
  progress: number;
  result?: TaskExecutionResult | JsonValue | null;
  error?: string | null;
  approvalState?: ApprovalState | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  description: string;
  role: string;
  instructions: string;
  /** Tool identifiers/config this agent is permitted to use. */
  tools: JsonValue[];
  /** Permission identifiers granted to this agent. */
  permissions: JsonValue[];
  status: AgentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------

export interface Workflow {
  id: string;
  name: string;
  description: string;
  /** Structured workflow definition (steps, triggers, etc.) — shape is workflow-engine-specific. */
  definition: JsonValue;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------

export interface Schedule {
  id: string;
  workflowId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------

export type AuditEntityType = 'task' | 'agent' | 'workflow' | 'schedule' | 'memory' | 'system';

export interface AuditLogEntry {
  id?: number | string;
  event: string;
  entityType: AuditEntityType | string;
  entityId?: string | null;
  detail: JsonObject;
  createdAt: string;
}

// ---------------------------------------------------------------------
// Memory references
// -----------------------------------------------------------------------
// Lightweight type for referencing a stored memory from other subsystems
// (e.g. attaching relevant memory ids to a task or agent context) without
// this file needing to import memory.ts's runtime implementation.

export interface MemoryReference {
  id: string;
  kind: string;
  relevance?: number;
  source?: string | null;
}

// ---------------------------------------------------------------------
// Tool execution (future-ready scaffold)
// -----------------------------------------------------------------------
// Minimal shared shape for future tool-calling (web research, files,
// device/Android tools, etc.), independent of any specific tool's
// implementation.

export interface ToolCall {
  name: string;
  input: JsonObject;
}

export type ToolExecutionResult = ExecutionResult<JsonValue>;
