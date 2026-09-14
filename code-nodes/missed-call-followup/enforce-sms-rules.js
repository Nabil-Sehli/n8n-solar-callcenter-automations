// n8n Code node "Enforce SMS Rules" (Run Once for Each Item)
// The prompt asks for a compliant SMS, but compliance is enforced here in
// code: single 160-char segment, no emojis, company named, exact opt-out line.
// If the draft can't be fixed safely, a deterministic template is used instead.

const ctx = $('Build SMS Request').item.json;
const cfg = $('Config & Prompt').item.json;
const res = $json;

const MAX = Number(cfg.max_sms_chars);
const OPT_OUT = String(cfg.opt_out_line).trim();
const COMPANY = String(cfg.company_name).trim();
const CALLBACK = String(cfg.callback_number).trim();
const issues = [];

// 160 chars is the GSM-7 limit. One curly quote or emoji switches the whole
// message to UCS-2, where a segment is only 70 chars. Normalize to plain ASCII
// and drop GSM-7 extension characters, which count as two.
const toGsmSafe = (s) =>
  String(s)
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '')
    .replace(/[\[\]{}\\^~|`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Normalizes an Anthropic Messages or Gemini generateContent response into
// { text, truncated } or { failure }. Same reader as "Parse Score".
const readLlmResponse = (r) => {
  if (r?.error) {
    const msg = typeof r.error === 'string' ? r.error : r.error.message ?? JSON.stringify(r.error);
    return { failure: `api_error: ${String(msg).slice(0, 120)}` };
  }
  if (Array.isArray(r?.candidates) || r?.promptFeedback) {
    if (r.promptFeedback?.blockReason) return { failure: `model_declined (${r.promptFeedback.blockReason})` };
    const candidate = r.candidates?.[0];
    const finish = candidate?.finishReason ?? 'unknown';
    if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(finish)) {
      return { failure: `model_declined (${finish})` };
    }
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p && typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('\n')
      .trim();
    return { text, truncated: finish === 'MAX_TOKENS', stop: finish };
  }
  if (r?.stop_reason === 'refusal') return { failure: 'model_declined' };
  const text = Array.isArray(r?.content)
    ? r.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
    : '';
  return { text, truncated: r?.stop_reason === 'max_tokens', stop: r?.stop_reason };
};

let draft = '';
const read = readLlmResponse(res);
if (read.failure) {
  issues.push(read.failure);
} else if (read.truncated) {
  // A draft cut off at the token limit may end mid-sentence; don't send it.
  issues.push('truncated');
} else {
  draft = read.text;
  if (!draft) issues.push(`empty_response (${read.stop ?? 'unknown'})`);
}

// Strip markdown fences and wrapping quotes the model sometimes adds.
draft = draft.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
draft = draft.replace(/^["']+|["']+$/g, '').trim();

if (/\p{Extended_Pictographic}/u.test(draft)) issues.push('emoji_removed');
let body = toGsmSafe(draft);

// Remove whatever opt-out wording the model wrote; we append the exact line.
body = body.replace(/\s*(reply|text)\s+stop\b[^.!?]*[.!?]?/gi, '').trim();

if (body && !body.toLowerCase().includes(COMPANY.toLowerCase())) {
  issues.push('company_name_missing');
  body = `${COMPANY}: ${body}`;
}

const budget = MAX - OPT_OUT.length - 1;
let source = 'llm';

if (!body || body.length > budget) {
  if (body.length > budget) issues.push(`too_long (${body.length + OPT_OUT.length + 1} chars)`);
  source = 'fallback_template';
  const first = toGsmSafe(ctx.first_name ?? '').slice(0, 20);
  const hi = first ? `Hi ${first},` : 'Hi,';
  const candidates =
    Number(ctx.attempt) === 1
      ? [
          `${hi} this is ${COMPANY}. Sorry we missed you about your ${ctx.service_interest} quote. Call or text us at ${CALLBACK}.`,
          `${hi} ${COMPANY} tried to reach you. Call us at ${CALLBACK}.`,
        ]
      : [
          `${hi} ${COMPANY} following up on your ${ctx.service_interest} quote. We are here when you are ready: ${CALLBACK}.`,
          `${hi} ${COMPANY} here. Reach us at ${CALLBACK}.`,
        ];
  body = candidates.map(toGsmSafe).find((t) => t.length <= budget) ?? toGsmSafe(`${COMPANY} ${CALLBACK}`).slice(0, budget);
}

const smsText = `${body} ${OPT_OUT}`;

const { llm_request, ...context } = ctx;

return {
  json: {
    ...context,
    sms_text: smsText,
    sms_length: smsText.length,
    sms_source: source,
    sms_issues: issues.join('; '),
    drafted_at: new Date().toISOString(),
  },
};
