// n8n Code node "Check Reply Flag" (Run Once for All Items)
// Input: every SMS Log row for this phone number (0..n rows).
// A rep, or later an inbound-SMS workflow, marks a row replied=TRUE or
// opted_out=TRUE. opted_out applies across all campaigns for that phone;
// replied only counts for this follow-up.

const ctx = $('Enforce SMS Rules').last().json;
const cfg = $('Config & Prompt').last().json;

const rows = $input
  .all()
  .map((i) => i.json)
  .filter((r) => r && Object.keys(r).length > 0);

const isTrue = (v) => ['true', 'yes', 'y', '1', 'x'].includes(String(v ?? '').trim().toLowerCase());

const replied = rows.some((r) => r.followup_id === ctx.followup_id && isTrue(r.replied));
const optedOut = rows.some((r) => isTrue(r.opted_out));
const nextAttempt = Number(ctx.attempt) + 1;

return [
  {
    json: {
      followup_id: ctx.followup_id,
      phone: ctx.phone,
      replied,
      opted_out: optedOut,
      next_attempt: nextAttempt,
      send_followup: !replied && !optedOut && nextAttempt <= Number(cfg.max_attempts),
    },
  },
];
