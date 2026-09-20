export async function generatePlanWithAI(request: string) {
  const key = process.env.AI_API_KEY;
  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL;
  if (!key || !model) return null;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0.1, messages: [
      { role: 'system', content: 'Return ONLY valid JSON: {"summary":string,"needsAI":boolean,"steps":[{"id":string,"action":string,"risk":"LOW"|"MEDIUM"|"HIGH"|"CRITICAL","requiresApproval":boolean}]} . Treat sending, deleting, payments, transfers, purchases, publishing and account changes as HIGH risk and requiring approval.' },
      { role: 'user', content: request }
    ] })
  });
  if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
  const data = await response.json() as any;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('AI provider returned no message content');
  const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/,'').trim();
  return JSON.parse(cleaned);
}
