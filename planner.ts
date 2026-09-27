/**
 * planner.ts
 * -----------------------------------------------------------------------
 * Planning layer for the Personal AI OS.
 *
 * Turns a natural-language request into a `Plan`: an ordered, explicit,
 * risk-annotated list of steps that some other layer (the orchestrator /
 * executor) will later review and run.
 *
 * This file NEVER executes actions. It only:
 *   1. Asks the AI layer (ai.ts) for a plan, when configured.
 *   2. Validates whatever comes back — rejecting anything malformed.
 *   3. Enforces a safety floor: risk levels and approval requirements can
 *      only ever be raised, never silently lowered or removed.
 *   4. Falls back to a deterministic, rule-based plan if the AI is
 *      unavailable, unconfigured, or returns something invalid.
 *
 * Public API (kept stable for existing callers):
 *   planRequest(request: string): Promise<Plan>
 * -----------------------------------------------------------------------
 */

import type { Plan, Risk } from './types.js';
import { generatePlanWithAI } from './ai.js';

// A single step's shape, derived from Plan so we never redefine or drift
// from the project's canonical types.
type PlanStep = Plan['steps'][number];

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/**
 * Thrown when a plan (AI-generated or otherwise) fails validation.
 * Callers within this file treat this the same as an AI failure: fall
 * back to the deterministic planner rather than using the bad plan.
 */
export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

// ---------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------

function isRisk(value: unknown): value is Risk {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL';
}

/**
 * Risk levels that must always require approval, regardless of what the
 * AI (or anything else) says. This is a floor, not a ceiling: a step can
 * always be made *more* cautious, never less.
 */
function mustRequireApproval(risk: Risk): boolean {
  return risk === 'HIGH' || risk === 'CRITICAL';
}

function validateStep(raw: unknown, index: number): PlanStep {
  if (typeof raw !== 'object' || raw === null) {
    throw new PlanValidationError(`Plan step at index ${index} is not an object`);
  }

  const s = raw as Record<string, unknown>;

  if (typeof s.id !== 'string' || s.id.trim().length === 0) {
    throw new PlanValidationError(`Plan step at index ${index} is missing a valid "id"`);
  }
  if (typeof s.action !== 'string' || s.action.trim().length === 0) {
    throw new PlanValidationError(`Plan step at index ${index} is missing a valid "action"`);
  }
  if (!isRisk(s.risk)) {
    throw new PlanValidationError(`Plan step at index ${index} ("${s.id}") has an invalid "risk" value`);
  }
  if (typeof s.requiresApproval !== 'boolean') {
    throw new PlanValidationError(
      `Plan step at index ${index} ("${s.id}") is missing a valid "requiresApproval" flag`
    );
  }

  // Safety floor: HIGH/CRITICAL steps are approval-required no matter
  // what was reported. We only ever raise this flag, never lower it.
  const requiresApproval = s.requiresApproval || mustRequireApproval(s.risk);

  return {
    id: s.id,
    action: s.action,
    risk: s.risk,
    requiresApproval,
  } as PlanStep;
}

/**
 * Validates an unknown value (typically the output of generatePlanWithAI)
 * against the Plan shape, enforcing the approval-safety floor on every
 * step. Throws PlanValidationError on anything malformed or unsafe to
 * silently repair.
 */
function validatePlan(raw: unknown): Plan {
  if (typeof raw !== 'object' || raw === null) {
    throw new PlanValidationError('Plan is not an object');
  }

  const p = raw as Record<string, unknown>;

  if (typeof p.summary !== 'string' || p.summary.trim().length === 0) {
    throw new PlanValidationError('Plan is missing a valid "summary"');
  }
  if (typeof p.needsAI !== 'boolean') {
    throw new PlanValidationError('Plan is missing a valid "needsAI" boolean');
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    throw new PlanValidationError('Plan is missing a non-empty "steps" array');
  }

  const steps = p.steps.map(validateStep);

  const seenIds = new Set<string>();
  for (const step of steps) {
    if (seenIds.has(step.id)) {
      throw new PlanValidationError(`Plan contains duplicate step id "${step.id}"`);
    }
    seenIds.add(step.id);
  }

  return {
    summary: p.summary,
    needsAI: p.needsAI,
    steps,
  } as Plan;
}

// ---------------------------------------------------------------------
// Deterministic fallback planner
// ---------------------------------------------------------------------

const HIGH_RISK_PATTERN =
  /(send|delete|payment|pay|transfer|purchase|buy|publish|post|change account|financial)/;
const MEDIUM_RISK_PATTERN = /(create|update|edit|modify|schedule|write)/;
const NEEDS_AI_PATTERN = /(research|analy[sz]e|summarize|understand|plan|find|compare|reason)/;

/**
 * Rule-based plan used when the AI layer is unconfigured, unavailable,
 * or returns something that fails validation. Deliberately simple and
 * conservative — when in doubt, it escalates risk rather than guessing.
 */
function buildDeterministicPlan(request: string): Plan {
  const text = request.toLowerCase();

  const highRisk = HIGH_RISK_PATTERN.test(text);
  const mediumRisk = MEDIUM_RISK_PATTERN.test(text);
  const risk: Risk = highRisk ? 'HIGH' : mediumRisk ? 'MEDIUM' : 'LOW';
  const needsAI = request.length > 80 || NEEDS_AI_PATTERN.test(text);

  const plan: Plan = {
    summary: `Plan generated for: ${request}`,
    needsAI,
    steps: [
      {
        id: 'understand',
        action: 'Understand and validate the request',
        risk: 'LOW',
        requiresApproval: false,
      },
      {
        id: 'execute',
        action: request,
        risk,
        requiresApproval: mustRequireApproval(risk),
      },
    ] as Plan['steps'],
  };

  // Run through the same validator as AI plans for defense in depth —
  // this also normalizes types and guarantees the safety floor holds.
  return validatePlan(plan);
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Produces an executable/reviewable Plan for a natural-language request.
 *
 * Tries the configured AI provider first (via ai.ts). If the AI is not
 * configured, fails, or returns a plan that doesn't pass validation,
 * falls back to a deterministic, rule-based plan. Either way, the
 * returned Plan is guaranteed to have HIGH/CRITICAL steps marked as
 * approval-required.
 *
 * This function only plans — it never executes any step.
 */
export async function planRequest(request: string): Promise<Plan> {
  if (typeof request !== 'string' || request.trim().length === 0) {
    throw new PlanValidationError('planRequest requires a non-empty request string');
  }

  if (process.env.AI_API_KEY && process.env.AI_MODEL) {
    try {
      const aiResult = await generatePlanWithAI(request);
      if (aiResult) {
        return validatePlan(aiResult);
      }
      console.warn('AI planner returned no result; using deterministic fallback.');
    } catch (error) {
      console.warn('AI planner failed; using deterministic fallback:', error);
    }
  }

  return buildDeterministicPlan(request);
}
