// n8n Code node "Parse Score" (Run Once for Each Item)
// Defensive parser. The model is told to return bare JSON, but we never rely
// on that. It may wrap JSON in ```json fences, add prose, get cut off at
// max_tokens, refuse, or the HTTP call may fail after its retries.
// Every failure becomes scoring_status "failed" (routed to a human) instead
// of an exception, because a dropped lead is lost revenue.

const lead = $('Validate Lead').item.json;
const cfg = $('Config & Prompt').item.json;
const res = $json;

const HOT = Number(cfg.hot_threshold);
const WARM = Number(cfg.warm_threshold);
const RENTER_MAX = Number(cfg.renter_max_score);

const base = {
  timestamp: new Date().toISOString(),
  name: lead.name,
  phone: lead.phone,
  email: lead.email,
  address: lead.address,
  monthly_electric_bill: lead.monthly_electric_bill,
  roof_age_years: lead.roof_age_years,
  homeowner: lead.homeowner,
  notes: lead.notes,
  model: res?.model ?? cfg.model,
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

// Opus 5 thinks by default, so content[0] may be a thinking block.
// Join every text block instead of assuming a position.
const extractText = (r) =>
  Array.isArray(r?.content)
    ? r.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
    : '';

const extractJson = (text) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(candidate.slice(start, end + 1));
};

if (res?.error) {
  const msg = typeof res.error === 'string' ? res.error : res.error.message ?? JSON.stringify(res.error);
  return failed(`API error (${String(msg).slice(0, 200)})`);
}
if (res?.stop_reason === 'refusal') return failed('model declined the request');

const text = extractText(res);
if (!text) return failed(`empty response (stop_reason: ${res?.stop_reason ?? 'unknown'})`);

let parsed;
try {
  parsed = extractJson(text);
} catch (e) {
  const hint = res?.stop_reason === 'max_tokens' ? 'response truncated at max_tokens' : 'response was not valid JSON';
  return failed(hint);
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
