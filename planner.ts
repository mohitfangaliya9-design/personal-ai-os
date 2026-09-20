import type { Plan, Risk } from './types.js';
import { generatePlanWithAI } from './ai.js';

export async function planRequest(request: string): Promise<Plan> {
  if (process.env.AI_API_KEY && process.env.AI_MODEL) {
    try { return await generatePlanWithAI(request) as Plan; } catch (error) { console.warn('AI planner failed; using deterministic fallback:', error); }
  }
  const text = request.toLowerCase();
  const highRisk = /(send|delete|payment|pay|transfer|purchase|buy|publish|post|change account|financial)/.test(text);
  const mediumRisk = /(create|update|edit|modify|schedule|write)/.test(text);
  const risk: Risk = highRisk ? 'HIGH' : mediumRisk ? 'MEDIUM' : 'LOW';
  const needsAI = request.length > 80 || /(research|analy[sz]e|summarize|understand|plan|find|compare|reason)/.test(text);
  return { summary: `Plan generated for: ${request}`, needsAI, steps: [
    { id: 'understand', action: 'Understand and validate the request', risk: 'LOW', requiresApproval: false },
    { id: 'execute', action: request, risk, requiresApproval: highRisk }
  ] };
}
