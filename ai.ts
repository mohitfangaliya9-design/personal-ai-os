/**
 * ai.ts
 * -----------------------------------------------------------------------
 * AI engine layer for the Personal AI OS.
 *
 * Responsibilities:
 *  - Take a natural-language user request and ask a configured AI provider
 *    to turn it into a structured, reviewable plan.
 *  - Never hard-code credentials — everything comes from environment vars.
 *  - Stay provider-agnostic so a new backend can be added without touching
 *    callers of `generatePlanWithAI`.
 *  - Fail loudly and safely (throw / return null) instead of ever
 *    fabricating a "successful" AI response.
 *
 * Public API (kept stable for existing callers):
 *   generatePlanWithAI(request: string): Promise<AIPlanResult | null>
 * -----------------------------------------------------------------------
 */

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AIPlanStep {
  id: string;
  action: string;
  risk: RiskLevel;
  requiresApproval: boolean;
}

export interface AIPlanResult {
  summary: string;
  needsAI: boolean;
  steps: AIPlanStep[];
}

// ---------------------------------------------------------------------
// Provider abstraction (internal)
// ---------------------------------------------------------------------
// Kept minimal on purpose: today there's one OpenAI-compatible provider,
// but the shape below is what a second provider (Anthropic, local model,
// etc.) would implement, so `generatePlanWithAI` never has to change.

interface AIProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface AIProvider {
  complete(systemPrompt: string, userPrompt: string, config: AIProviderConfig): Promise<string>;
}

const SYSTEM_PROMPT =
  'Return ONLY valid JSON: {"summary":string,"needsAI":boolean,"steps":[{"id":string,"action":string,"risk":"LOW"|"MEDIUM"|"HIGH"|"CRITICAL","requiresApproval":boolean}]} . ' +
  'Treat sending, deleting, payments, transfers, purchases, publishing and account changes as HIGH risk and requiring approval.';

/**
 * Reads provider configuration from environment variables.
 * Returns null if the minimum required config isn't present, so callers
 * can decide how to handle "AI not configured" without a thrown error.
 */
function loadConfig(): AIProviderConfig | null {
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 30_000;

  if (!apiKey || !model) return null;

  return { apiKey, baseUrl, model, timeoutMs };
}

/**
 * OpenAI-compatible chat-completions provider.
 * Works with OpenAI itself and any OpenAI-compatible endpoint (via
 * AI_BASE_URL), e.g. self-hosted or third-party gateways.
 */
const openAICompatibleProvider: AIProvider = {
  async complete(systemPrompt, userPrompt, config) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`AI provider request timed out after ${config.timeoutMs}ms`);
      }
      throw new Error(
        `AI provider request failed: ${err instanceof Error ? err.message : 'unknown network error'}`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // Never include headers/body here — avoids leaking request details.
      throw new Error(`AI provider returned HTTP ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error('AI provider returned invalid JSON response envelope');
    }

    const content = (data as any)?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('AI provider returned no message content');
    }

    return content;
  },
};

// Provider registry — adding a new backend later means adding an entry
// here and pointing AI_PROVIDER at it. Default stays OpenAI-compatible
// so existing setups keep working with zero config changes.
const PROVIDERS: Record<string, AIProvider> = {
  openai: openAICompatibleProvider,
};

function resolveProvider(): AIProvider {
  const name = (process.env.AI_PROVIDER || 'openai').toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown AI provider "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

// ---------------------------------------------------------------------
// Response parsing / validation
// ---------------------------------------------------------------------

function stripCodeFence(raw: string): string {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL';
}

/**
 * Validates the AI's JSON output against AIPlanResult's shape.
 * We never "fill in" missing fields with guessed defaults that make a
 * malformed response look valid — that would risk silently downgrading
 * risk/approval flags. Malformed output is treated as a hard failure.
 */
function parseAndValidatePlan(raw: string): AIPlanResult {
  const cleaned = stripCodeFence(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('AI provider returned content that was not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('AI provider returned a non-object plan');
  }

  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.summary !== 'string') {
    throw new Error('AI plan is missing a valid "summary" string');
  }
  if (typeof candidate.needsAI !== 'boolean') {
    throw new Error('AI plan is missing a valid "needsAI" boolean');
  }
  if (!Array.isArray(candidate.steps)) {
    throw new Error('AI plan is missing a valid "steps" array');
  }

  const steps: AIPlanStep[] = candidate.steps.map((step, index) => {
    if (typeof step !== 'object' || step === null) {
      throw new Error(`AI plan step at index ${index} is not an object`);
    }
    const s = step as Record<string, unknown>;
    if (typeof s.id !== 'string') {
      throw new Error(`AI plan step at index ${index} is missing a valid "id"`);
    }
    if (typeof s.action !== 'string') {
      throw new Error(`AI plan step at index ${index} is missing a valid "action"`);
    }
    if (!isRiskLevel(s.risk)) {
      throw new Error(`AI plan step at index ${index} has an invalid "risk" value`);
    }
    if (typeof s.requiresApproval !== 'boolean') {
      throw new Error(`AI plan step at index ${index} is missing a valid "requiresApproval"`);
    }
    return { id: s.id, action: s.action, risk: s.risk, requiresApproval: s.requiresApproval };
  });

  return { summary: candidate.summary, needsAI: candidate.needsAI, steps };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Turns a natural-language request into a structured plan using the
 * configured AI provider.
 *
 * Returns `null` when no provider is configured (missing AI_API_KEY /
 * AI_MODEL), so callers can fall back to non-AI behavior.
 *
 * Throws on any network, provider, or malformed-response error — this
 * function never fabricates a plan to mask a failure.
 */
export async function generatePlanWithAI(request: string): Promise<AIPlanResult | null> {
  if (typeof request !== 'string' || request.trim().length === 0) {
    throw new Error('generatePlanWithAI requires a non-empty request string');
  }

  const config = loadConfig();
  if (!config) return null;

  const provider = resolveProvider();
  const content = await provider.complete(SYSTEM_PROMPT, request, config);
  return parseAndValidatePlan(content);
}
