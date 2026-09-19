// n8n Code node "Telemetry: Report Attempt" (Run Once for All Items)
// One observability event per SMS attempt: model, tokens, latency, and whether
// the draft came from the LLM or from the fallback template. The HTTP node
// after this posts it.
//
// This workflow loops: attempt 2 runs through the same LLM nodes an hour
// later, inside the same n8n execution. The run id therefore carries the
// attempt number - without it the collector would treat the second attempt as
// a retry of the first and silently drop it, along with its tokens and cost.

const cfg = $('Config & Prompt').first().json;
const url = String(cfg.telemetry_url ?? '').trim();
// Opt-in: no URL, no items, so the HTTP node after this never executes.
if (!url) return [];

const started = $('Validate Missed Call').first().json;
const enforced = $('Enforce SMS Rules').first().json;

const provider = enforced.llm_provider;
const llmNode = provider === 'gemini' ? 'Gemini: Draft SMS' : 'Claude: Draft SMS';
const raw = $(llmNode).first().json ?? {};

// Gemini reports thinking tokens separately but bills them as output;
// Anthropic already folds them into output_tokens.
const usage = provider === 'gemini'
  ? {
      tokens_in: raw.usageMetadata?.promptTokenCount ?? 0,
      tokens_out: (raw.usageMetadata?.candidatesTokenCount ?? 0)
        + (raw.usageMetadata?.thoughtsTokenCount ?? 0),
    }
  : {
      tokens_in: raw.usage?.input_tokens ?? 0,
      tokens_out: raw.usage?.output_tokens ?? 0,
    };

const httpStatus = Number(raw.error?.code ?? raw.error?.status ?? NaN);
// The text still went out, but a template wrote it, not the model.
const usedFallback = enforced.sms_source !== 'llm';

const now = Date.now();
const between = (from, to) =>
  Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null;

return [{
  json: {
    telemetry_url: url,
    event: {
      run_id: `n8n-${$execution.id}-attempt-${enforced.attempt}`,
      workflow: 'Missed Call SMS Follow-up',
      status: usedFallback ? 'partial' : 'ok',
      started_at: Number.isFinite(started.t_start)
        ? Math.floor(started.t_start / 1000)
        : Math.floor(now / 1000),
      // Attempt 2 waits an hour before it starts, so measuring from the
      // webhook would report a 1-hour run. This is the drafting work only.
      duration_ms: between(enforced.t_llm_start, now),
      ...(usedFallback
        ? { failed_node: llmNode, error: enforced.sms_issues || 'draft rejected, template sent' }
        : {}),
      steps: [
        { node: 'Validate Missed Call', status: 'ok' },
        {
          node: llmNode,
          status: usedFallback ? 'failed' : 'ok',
          provider,
          model: enforced.llm_model,
          ...usage,
          duration_ms: between(enforced.t_llm_start, enforced.t_enforced),
          ...(Number.isFinite(httpStatus) ? { http_status: httpStatus } : {}),
          ...(usedFallback ? { error: enforced.sms_issues } : {}),
        },
        { node: 'Log SMS Attempt', status: 'ok' },
      ],
      attrs: {
        attempt: enforced.attempt,
        sms_source: enforced.sms_source,
        sms_length: enforced.sms_length,
        campaign: enforced.campaign,
      },
    },
  },
}];
