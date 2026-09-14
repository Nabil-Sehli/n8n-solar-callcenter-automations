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

const extractText = (r) =>
  Array.isArray(r?.content)
    ? r.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
    : '';

let draft = '';
if (res?.error) {
  const msg = typeof res.error === 'string' ? res.error : res.error.message ?? JSON.stringify(res.error);
  issues.push(`api_error: ${String(msg).slice(0, 120)}`);
} else if (res?.stop_reason === 'refusal') {
  issues.push('model_declined');
} else {
  draft = extractText(res);
  if (!draft) issues.push(`empty_response (${res?.stop_reason ?? 'unknown'})`);
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
let source = 'claude';

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

const { claude_request, ...context } = ctx;

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
