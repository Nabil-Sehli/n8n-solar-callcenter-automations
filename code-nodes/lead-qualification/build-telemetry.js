// n8n Code node "Telemetry: Report Run" (Run Once for All Items)
// Builds one observability event per execution: what ran, how long it took,
// which model answered, how many tokens it burned, and — when the model let us
// down — which node to look at. The HTTP node after this posts it.
//
// It sits after "Respond with Score", so nothing here can delay the caller's
// response or fail the lead: by the time this runs, the lead is already in the
// Sheet and the webhook has answered.

const cfg = $('Config & Prompt').first().json;
const url = String(cfg.telemetry_url ?? '').trim();
// Opt-in. With no URL configured the node emits no items, so the HTTP node
// after it never executes and a fresh import of this workflow stays quiet.
if (!url) return [];

const started = $('Validate Lead').first().json;
const request = $('Build LLM Request').first().json;
const parsed = $('Parse Score').first().json;

const provider = request.llm_provider;
const llmNode = provider === 'gemini' ? 'Gemini: Score Lead' : 'Claude: Score Lead';
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

// The HTTP node continues on error, so a failed call arrives here as an error
// payload rather than an exception. Both providers put a numeric code in it.
const httpStatus = Number(raw.error?.code ?? raw.error?.status ?? NaN);
const scoringFailed = parsed.scoring_status === 'failed';

const now = Date.now();
const since = (from) => (Number.isFinite(from) ? Math.max(0, now - from) : null);
const between = (from, to) =>
  Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null;

const steps = [
  { node: 'Validate Lead', status: 'ok' },
  {
    node: llmNode,
    // The run as a whole survives a scoring failure - this step did not.
    status: scoringFailed ? 'failed' : 'ok',
    provider,
    model: parsed.model ?? request.llm_model,
    ...usage,
    duration_ms: between(request.t_llm_start, parsed.t_parsed),
    ...(Number.isFinite(httpStatus) ? { http_status: httpStatus } : {}),
    ...(scoringFailed ? { error: parsed.reason } : {}),
  },
  { node: 'Log Lead to Sheet', status: 'ok' },
];

return [{
  json: {
    telemetry_url: url,
    event: {
      run_id: `n8n-${$execution.id}`,
      workflow: 'AI Lead Qualification',
      // A lead the model could not score still reached a human and still cost
      // money: "partial" keeps it out of the success rate without calling the
      // pipeline broken, because the pipeline did its job.
      status: scoringFailed ? 'partial' : 'ok',
      started_at: Number.isFinite(started.t_start)
        ? Math.floor(started.t_start / 1000)
        : Math.floor(now / 1000),
      duration_ms: since(started.t_start),
      ...(scoringFailed ? { failed_node: llmNode, error: parsed.reason } : {}),
      steps,
      attrs: {
        tier: parsed.tier,
        score: parsed.score,
        scoring_status: parsed.scoring_status,
      },
    },
  },
}];
