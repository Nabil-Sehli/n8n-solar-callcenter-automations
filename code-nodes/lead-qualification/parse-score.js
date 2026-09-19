// n8n Code node "Parse Score" (Run Once for Each Item)
// Defensive parser for either provider. The model is told to return bare
// JSON, but we never rely on that: it may wrap JSON in ```json fences, add
// prose, get cut off at the token limit, decline, or the HTTP call may fail
// after its retries. Every failure becomes scoring_status "failed" (routed to
// a human) instead of an exception, because a dropped lead is lost revenue.

const lead = $('Validate Lead').item.json;
const cfg = $('Config & Prompt').item.json;
const llm = $('Build LLM Request').item.json;
const res = $json;

const HOT = Number(cfg.hot_threshold);
const WARM = Number(cfg.warm_threshold);
const RENTER_MAX = Number(cfg.renter_max_score);

// Normalizes an Anthropic Messages or Gemini generateContent response into
// { text, truncated, model } or { failure }.
const readLlmResponse = (r) => {
  if (r?.error) {
    const msg = typeof r.error === 'string' ? r.error : r.error.message ?? JSON.stringify(r.error);
    return { failure: `API error (${String(msg).slice(0, 200)})` };
  }
  if (Array.isArray(r?.candidates) || r?.promptFeedback) {
    // Gemini. Thought summaries are parts flagged thought: true; skip them.
    if (r.promptFeedback?.blockReason) return { failure: `model declined the request (${r.promptFeedback.blockReason})` };
    const candidate = r.candidates?.[0];
    const finish = candidate?.finishReason ?? 'unknown';
    if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(finish)) {
      return { failure: `model declined the request (${finish})` };
    }
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p && typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('\n')
      .trim();
    return { text, truncated: finish === 'MAX_TOKENS', stop: finish, model: r.modelVersion };
  }
  // Anthropic. Opus 5 thinks by default, so content[0] may be a thinking
  // block. Join every text block instead of assuming a position.
  if (r?.stop_reason === 'refusal') return { failure: 'model declined the request' };
  const text = Array.isArray(r?.content)
    ? r.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
    : '';
  return { text, truncated: r?.stop_reason === 'max_tokens', stop: r?.stop_reason, model: r?.model };
};

const extractJson = (text) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(candidate.slice(start, end + 1));
};

const read = readLlmResponse(res);

const base = {
  timestamp: new Date().toISOString(),
  // Taken as soon as the response is in hand; t_llm_start to here is the
  // model call, which is what the latency panels measure.
  t_parsed: Date.now(),
  name: lead.name,
  phone: lead.phone,
  email: lead.email,
  address: lead.address,
  monthly_electric_bill: lead.monthly_electric_bill,
  roof_age_years: lead.roof_age_years,
  homeowner: lead.homeowner,
  notes: lead.notes,
  model: read.model ?? llm.llm_model,
  execution_id: $execution.id,
};

const failed = (why) => ({
  json: {
    ...base,
    score: null,
    tier: null,
    reason: `Auto-scoring failed: ${why}. Review manually.`,
    suggested_opener: '',
    scoring_status: 'failed',
  },
});

if (read.failure) return failed(read.failure);
if (!read.text) return failed(`empty response (${read.stop ?? 'unknown'})`);

let parsed;
try {
  parsed = extractJson(read.text);
} catch (e) {
  return failed(read.truncated ? 'response truncated at the token limit' : 'response was not valid JSON');
}

let score = Number(parsed.score);
if (!Number.isFinite(score)) return failed('score missing or not a number');
score = Math.max(0, Math.min(100, Math.round(score)));

// Hard business rule enforced in code, not left to the model.
if (lead.homeowner === false) score = Math.min(score, RENTER_MAX);

// The routing tier comes from the score and the thresholds in the Set node,
// so the IF node never depends on the model being self-consistent.
const tier = score >= HOT ? 'hot' : score >= WARM ? 'warm' : 'cold';

return {
  json: {
    ...base,
    score,
    tier,
    reason: String(parsed.reason ?? '').trim().slice(0, 500),
    suggested_opener: String(parsed.suggested_opener ?? '').trim().slice(0, 500),
    scoring_status: 'ok',
    model_tier: String(parsed.tier ?? '').toLowerCase(),
  },
};
