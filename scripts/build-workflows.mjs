// Generates workflows/*.json from code-nodes/*.js and prompts/*.txt.
// Node type strings and typeVersions were checked against n8n 2.38.7
// (dist/types/nodes.json inside the official docker image).
//
//   node scripts/build-workflows.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

// Deterministic UUIDs, so rebuilding does not churn ids in git diffs.
const uuid = (...parts) => {
  const h = createHash('sha256').update(parts.join('::')).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// n8n workflow ids are 16-char alphanumeric strings.
const workflowId = (slug) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = createHash('sha256').update(`workflow::${slug}`).digest();
  return Array.from(bytes.subarray(0, 16), (b) => alphabet[b % alphabet.length]).join('');
};

// Credentials are referenced by name with id null. On import n8n looks up a
// credential of that type and name and links it (replaceInvalidCredentials).
//
// The LLM nodes carry no credential reference at all. n8n checks every node's
// credentials when a run starts, including nodes on branches that never
// execute, and fails the run with "uses invalid credential" if an entry was
// left unlinked. With both providers referenced, whichever key you didn't
// create would block every run.
const CREDENTIALS = {
  smtp: { smtp: { id: null, name: 'SMTP account' } },
  sheets: { googleSheetsOAuth2Api: { id: null, name: 'Google Sheets account' } },
};

const SPREADSHEET_PLACEHOLDER = 'REPLACE_WITH_YOUR_SPREADSHEET_ID';

function createWorkflow(slug, name) {
  const nodes = [];
  const connections = {};
  return {
    add(node) {
      nodes.push({ id: uuid(slug, node.name), ...node });
      return node.name;
    },
    connect(from, to, outputIndex = 0) {
      connections[from] ??= { main: [] };
      const main = connections[from].main;
      while (main.length <= outputIndex) main.push([]);
      main[outputIndex].push({ node: to, type: 'main', index: 0 });
    },
    uuid: (...parts) => uuid(slug, ...parts),
    // `n8n import:workflow` (CLI) requires an id; UI import ignores it.
    toJSON: () => ({ id: workflowId(slug), name, nodes, connections, settings: { executionOrder: 'v1' }, pinData: {} }),
  };
}

// ---------- node factories ----------

const webhook = (wf, name, path, position) => ({
  name,
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2.1,
  position,
  webhookId: wf.uuid(name, 'webhookId'),
  parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: {} },
});

const code = (name, file, mode, position) => ({
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
  parameters: { mode, jsCode: read(file) },
});

const set = (wf, name, fields, position) => ({
  name,
  type: 'n8n-nodes-base.set',
  typeVersion: 3.5,
  position,
  parameters: {
    mode: 'manual',
    assignments: {
      assignments: Object.entries(fields).map(([key, value]) => ({
        id: wf.uuid(name, key),
        name: key,
        value,
        type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
      })),
    },
    includeOtherFields: false,
    options: {},
  },
});

const OPERATORS = {
  isTrue: { type: 'boolean', operation: 'true', singleValue: true },
  equals: { type: 'string', operation: 'equals' },
  lessThan: { type: 'number', operation: 'lt' },
};

const ifNode = (wf, name, conditions, combinator, position) => ({
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2.3,
  position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
      conditions: conditions.map(([leftValue, op, rightValue = ''], i) => ({
        id: wf.uuid(name, 'condition', i),
        leftValue,
        rightValue,
        operator: OPERATORS[op],
      })),
      combinator,
    },
    looseTypeValidation: false,
    options: {},
  },
});

const claudeRequest = (name, position) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.5,
  position,
  parameters: {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'anthropicApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'anthropic-version', value: '2023-06-01' },
        { name: 'anthropic-beta', value: 'server-side-fallback-2026-07-01' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.llm_request) }}',
    options: { timeout: 120000 },
  },
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  onError: 'continueRegularOutput',
});

// Generic Header Auth (x-goog-api-key). n8n's built-in Gemini credential
// sends the key as a ?key= URL query parameter, which can leak into logs.
const geminiRequest = (name, position) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.5,
  position,
  parameters: {
    method: 'POST',
    url: '=https://generativelanguage.googleapis.com/v1beta/models/{{ encodeURIComponent($json.llm_model) }}:generateContent',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.llm_request) }}',
    options: { timeout: 120000 },
  },
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
  onError: 'continueRegularOutput',
});

// Posts one observability event per run to a collector (see the ops-platform
// repo). Fire-and-forget: the caller has already been answered by the time
// this runs, so it retries twice and then gives up rather than turning a
// telemetry blip into a failed execution.
//
// No credential is referenced, like the LLM nodes above and for the same
// reason: n8n validates every node's credentials when a run starts. Link a
// Header Auth credential after import, and set telemetry_url to switch it on.
const telemetryRequest = (name, position) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.5,
  position,
  parameters: {
    method: 'POST',
    url: '={{ $json.telemetry_url }}',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.event) }}',
    options: { timeout: 5000 },
  },
  retryOnFail: true,
  maxTries: 2,
  waitBetweenTries: 2000,
  onError: 'continueRegularOutput',
});

// Shared config fields for the provider switch. Anthropic stays the default.
const PROVIDER_CONFIG = {
  llm_provider: 'anthropic',
  anthropic_model: 'claude-opus-5',
  anthropic_effort: 'low',
  gemini_model: 'gemini-3.5-flash',
  gemini_thinking_level: 'low',
};

const email = (name, { from, to, subject, text }, position) => ({
  name,
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2.1,
  position,
  parameters: {
    fromEmail: from,
    toEmail: to,
    subject,
    emailFormat: 'text',
    text,
    options: { appendAttribution: false },
  },
  credentials: CREDENTIALS.smtp,
});

const sheetsAppend = (name, sheetName, columns, position) => ({
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.7,
  position,
  parameters: {
    operation: 'append',
    documentId: { __rl: true, value: SPREADSHEET_PLACEHOLDER, mode: 'id' },
    sheetName: { __rl: true, value: sheetName, mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: Object.fromEntries(columns),
      matchingColumns: [],
      schema: columns.map(([id]) => ({
        id,
        displayName: id,
        required: false,
        defaultMatch: false,
        display: true,
        type: 'string',
        canBeUsedToMatch: true,
      })),
      attemptToConvertTypes: false,
      convertFieldsToString: false,
    },
    // RAW stops Sheets from turning "+16025550123" into a number and from
    // executing a notes field that starts with "=" as a formula.
    options: { cellFormat: 'RAW' },
  },
  credentials: CREDENTIALS.sheets,
});

const sheetsLookup = (name, sheetName, lookupColumn, lookupValue, position) => ({
  name,
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.7,
  position,
  parameters: {
    operation: 'read',
    documentId: { __rl: true, value: SPREADSHEET_PLACEHOLDER, mode: 'id' },
    sheetName: { __rl: true, value: sheetName, mode: 'name' },
    filtersUI: { values: [{ lookupColumn, lookupValue }] },
    combineFilters: 'AND',
    options: {},
  },
  credentials: CREDENTIALS.sheets,
  // Zero matching rows must still continue to the reply check.
  alwaysOutputData: true,
});

const respond = (name, responseBody, responseCode, position) => ({
  name,
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.5,
  position,
  parameters: { respondWith: 'json', responseBody, options: { responseCode } },
});

const wait = (wf, name, amount, unit, position) => ({
  name,
  type: 'n8n-nodes-base.wait',
  typeVersion: 1.1,
  position,
  webhookId: wf.uuid(name, 'webhookId'),
  parameters: { amount, unit },
});

const noOp = (name, position, notes) => ({
  name,
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position,
  parameters: {},
  ...(notes ? { notes, notesInFlow: true } : {}),
});

const sticky = (wf, name, content, position, width, height, color) => ({
  name,
  type: 'n8n-nodes-base.stickyNote',
  typeVersion: 1,
  position,
  parameters: { content, width, height, color },
});

// ---------- Workflow 1: AI lead qualification ----------

function buildLeadQualification() {
  const wf = createWorkflow('ai-lead-qualification', 'AI Lead Qualification (Solar & Roofing)');
  const P = (field) => `$('Parse Score').item.json.${field}`;
  const C = (field) => `$('Config & Prompt').item.json.${field}`;

  wf.add(sticky(wf, 'Note: Overview', [
    '## AI Lead Qualification',
    'POST a lead, an LLM scores it 0-100 (Claude by default, Gemini optional), every lead is logged, the caller gets the score back, then hot leads alert a closer and the rest go to nurture.',
    '',
    '**Before activating**',
    '1. Credentials: `Anthropic account` (or `Gemini API key`), `SMTP account`, `Google Sheets account`',
    '2. Paste your spreadsheet ID into **Log Lead to Sheet**',
    '3. Set provider, emails and thresholds in **Config & Prompt**',
  ].join('\n'), [-60, -240], 520, 380, 7));

  wf.add(sticky(wf, 'Note: LLM scoring', [
    '### LLM scoring',
    'Prompt, provider, model and tier thresholds live in **Config & Prompt** (no code). Set `llm_provider` to `anthropic` (default) or `gemini`.',
    '',
    '**Use Gemini?** routes to one plain HTTP Request node. Both retry 3 times, then continue on error so **Parse Score** can mark the lead `failed` and send it to a human instead of dropping it.',
    '',
    '**Parse Score** reads either response shape, strips ```json fences, skips thinking parts, clamps the score and derives the tier from the thresholds.',
  ].join('\n'), [680, -240], 1220, 380, 5));

  wf.add(sticky(wf, 'Note: Log, respond, route', [
    '### Log first, respond, then notify',
    'The lead is written to the Sheet **before** the webhook responds. If the Sheet write fails the caller gets an error and can retry, so a lead is never acknowledged but lost.',
    '',
    'Hot leads, and leads the AI could not score, email a closer right away. Warm and cold leads get a cadence and go to the nurture inbox.',
  ].join('\n'), [1920, -240], 1080, 380, 4));

  const hook = wf.add(webhook(wf, 'Webhook: New Lead', 'lead-qualification', [0, 300]));
  const validate = wf.add(code('Validate Lead', 'code-nodes/lead-qualification/validate-lead.js', 'runOnceForEachItem', [240, 300]));
  const isValid = wf.add(ifNode(wf, 'Is Lead Valid?', [['={{ $json.is_valid }}', 'isTrue']], 'and', [480, 300]));
  const invalid = wf.add(respond(
    'Respond: Invalid Lead',
    "={{ JSON.stringify({ error: 'invalid_lead', details: $json.validation_errors }) }}",
    400,
    [720, 540],
  ));
  const config = wf.add(set(wf, 'Config & Prompt', {
    company_name: 'Demo Solar & Roofing',
    ...PROVIDER_CONFIG,
    max_tokens: 8000,
    hot_threshold: 70,
    warm_threshold: 40,
    renter_max_score: 15,
    from_email: 'automations@example.com',
    alert_to_email: 'closers@example.com',
    nurture_to_email: 'nurture-team@example.com',
    // Empty = telemetry off. Point it at a collector to switch it on, e.g.
    // http://llmobs:9109/v1/events
    telemetry_url: '',
    system_prompt: read('prompts/lead-scoring-system.txt').trim(),
  }, [720, 300]));
  const build = wf.add(code('Build LLM Request', 'code-nodes/lead-qualification/build-llm-request.js', 'runOnceForEachItem', [960, 300]));
  const useGemini = wf.add(ifNode(wf, 'Use Gemini?', [['={{ $json.llm_provider }}', 'equals', 'gemini']], 'and', [1200, 300]));
  const gemini = wf.add(geminiRequest('Gemini: Score Lead', [1440, 160]));
  const claude = wf.add(claudeRequest('Claude: Score Lead', [1440, 440]));
  const parse = wf.add(code('Parse Score', 'code-nodes/lead-qualification/parse-score.js', 'runOnceForEachItem', [1680, 300]));

  const leadColumns = [
    'timestamp', 'name', 'phone', 'email', 'address', 'monthly_electric_bill', 'roof_age_years',
    'homeowner', 'notes', 'score', 'tier', 'reason', 'suggested_opener', 'scoring_status', 'model', 'execution_id',
  ].map((c) => [c, `={{ $json.${c} }}`]);
  const log = wf.add(sheetsAppend('Log Lead to Sheet', 'Leads', leadColumns, [1920, 300]));

  const reply = wf.add(respond(
    'Respond with Score',
    `={{ JSON.stringify({ score: ${P('score')}, tier: ${P('tier')}, reason: ${P('reason')}, suggested_opener: ${P('suggested_opener')}, scoring_status: ${P('scoring_status')} }) }}`,
    200,
    [2160, 300],
  ));
  const isHot = wf.add(ifNode(wf, 'Hot or Needs Review?', [
    [`={{ ${P('tier')} }}`, 'equals', 'hot'],
    [`={{ ${P('scoring_status')} }}`, 'equals', 'failed'],
  ], 'or', [2400, 300]));

  const leadDetails = [
    `Name: {{ ${P('name')} }}`,
    `Phone: {{ ${P('phone')} }}`,
    `Email: {{ ${P('email')} }}`,
    `Address: {{ ${P('address')} }}`,
    `Monthly electric bill: {{ ${P('monthly_electric_bill')} }}`,
    `Roof age (years): {{ ${P('roof_age_years')} }}`,
    `Homeowner: {{ ${P('homeowner')} }}`,
    `Notes: {{ ${P('notes')} }}`,
    '',
    `Score: {{ ${P('score')} }} ({{ ${P('tier')} }})`,
    `Why: {{ ${P('reason')} }}`,
    `Suggested opener: {{ ${P('suggested_opener')} }}`,
    '',
    `n8n execution: {{ ${P('execution_id')} }}`,
  ];

  const hotEmail = wf.add(email('Email: Hot Lead Alert', {
    from: `={{ ${C('from_email')} }}`,
    to: `={{ ${C('alert_to_email')} }}`,
    subject: `={{ ${P('scoring_status')} === 'failed' ? 'LEAD NEEDS MANUAL SCORING' : 'HOT LEAD (score ' + ${P('score')} + ')' }}: {{ ${P('name')} }}`,
    text: [
      `={{ ${P('scoring_status')} === 'failed' ? 'The AI could not score this lead. Call now and qualify manually.' : 'Call this lead now.' }}`,
      '',
      ...leadDetails,
    ].join('\n'),
  }, [2640, 140]));

  const nurture = wf.add(set(wf, 'Nurture Plan', {
    cadence: `={{ ${P('tier')} === 'warm' ? 'Warm: call back within 24 hours, then two more attempts over 7 days.' : 'Cold: add to the monthly email drip and re-score if they re-engage.' }}`,
  }, [2640, 460]));
  const nurtureEmail = wf.add(email('Email: Nurture Queue', {
    from: `={{ ${C('from_email')} }}`,
    to: `={{ ${C('nurture_to_email')} }}`,
    subject: `={{ ${P('tier')}.toUpperCase() }} lead (score {{ ${P('score')} }}): {{ ${P('name')} }}`,
    text: ['=Cadence: {{ $json.cadence }}', '', ...leadDetails].join('\n'),
  }, [2880, 460]));

  const telemetry = wf.add(code('Telemetry: Report Run', 'code-nodes/lead-qualification/build-telemetry.js', 'runOnceForAllItems', [2400, 700]));
  const postTelemetry = wf.add(telemetryRequest('Telemetry: Post Run', [2640, 700]));

  wf.connect(hook, validate);
  wf.connect(validate, isValid);
  wf.connect(isValid, config, 0);
  wf.connect(isValid, invalid, 1);
  wf.connect(config, build);
  wf.connect(build, useGemini);
  wf.connect(useGemini, gemini, 0);
  wf.connect(useGemini, claude, 1);
  wf.connect(gemini, parse);
  wf.connect(claude, parse);
  wf.connect(parse, log);
  wf.connect(log, reply);
  wf.connect(reply, isHot);
  // Second branch off the response: telemetry never sits between the caller
  // and their answer.
  wf.connect(reply, telemetry);
  wf.connect(telemetry, postTelemetry);
  wf.connect(isHot, hotEmail, 0);
  wf.connect(isHot, nurture, 1);
  wf.connect(nurture, nurtureEmail);

  return wf.toJSON();
}

// ---------- Workflow 2: missed call follow-up ----------

function buildMissedCallFollowup() {
  const wf = createWorkflow('missed-call-followup', 'Missed Call SMS Follow-up (Solar & Roofing)');
  const E = (field) => `$('Enforce SMS Rules').item.json.${field}`;
  const C = (field) => `$('Config & Prompt').item.json.${field}`;

  wf.add(sticky(wf, 'Note: Overview', [
    '## Missed Call SMS Follow-up',
    'The dialer POSTs a missed call. We wait 2 minutes (the homeowner often calls straight back), an LLM drafts a compliant SMS (Claude by default, Gemini optional), it is sent and logged, and after 1 hour one follow-up goes out unless the contact replied or opted out.',
    '',
    '**Before activating**',
    '1. Credentials: `Anthropic account` (or `Gemini API key`), `SMTP account`, `Google Sheets account`',
    '2. Paste your spreadsheet ID into **Log SMS Attempt** and **Read Reply Flag**',
    '3. Set provider, company, callback number and emails in **Config & Prompt**',
  ].join('\n'), [-60, -240], 1000, 380, 7));

  wf.add(sticky(wf, 'Note: Draft and enforce', [
    '### Draft, then enforce in code',
    '`llm_provider` in **Config & Prompt** picks Claude (default) or Gemini. The LLM writes the text; **Enforce SMS Rules** guarantees it: 160 GSM-7 chars, no emojis, company named, exact opt-out line. If the draft cannot be fixed, a fixed template is sent instead.',
  ].join('\n'), [1400, -240], 940, 380, 5));

  wf.add(sticky(wf, 'Note: SMS provider slot', [
    '## SMS PROVIDER SLOTS IN HERE',
    'Replace **SMS Provider (placeholder)** with a Twilio / Telnyx / Vonage "Send SMS" node:',
    '- To: `{{ $json.phone }}`',
    '- Message: `{{ $json.sms_text }}`',
    '',
    'Then delete **Email: SMS Preview** and connect the SMS node to **Log SMS Attempt**.',
  ].join('\n'), [2360, -240], 520, 380, 3));

  wf.add(sticky(wf, 'Note: Follow-up loop', [
    '### One follow-up after 1 hour',
    'Reads every SMS Log row for this phone. A rep (or a future inbound-SMS workflow) sets `replied` or `opted_out` to TRUE on the row.',
    '`opted_out` blocks all future texts to that number. If neither is set, the loop sends attempt 2 through the same draft and enforce nodes. `max_attempts` in **Config & Prompt** caps it.',
  ].join('\n'), [2360, 940], 900, 300, 4));

  const hook = wf.add(webhook(wf, 'Webhook: Missed Call', 'missed-call', [0, 300]));
  const validate = wf.add(code('Validate Missed Call', 'code-nodes/missed-call-followup/validate-missed-call.js', 'runOnceForEachItem', [240, 300]));
  const isValid = wf.add(ifNode(wf, 'Is Payload Valid?', [['={{ $json.is_valid }}', 'isTrue']], 'and', [480, 300]));
  const invalid = wf.add(respond(
    'Respond: Invalid Payload',
    "={{ JSON.stringify({ error: 'invalid_payload', details: $json.validation_errors }) }}",
    400,
    [720, 540],
  ));
  const accepted = wf.add(respond(
    'Respond: Accepted',
    "={{ JSON.stringify({ status: 'accepted', followup_id: $json.followup_id }) }}",
    202,
    [720, 300],
  ));
  const config = wf.add(set(wf, 'Config & Prompt', {
    company_name: 'Demo Solar & Roofing',
    callback_number: '(555) 010-0100',
    opt_out_line: 'Reply STOP to opt out.',
    max_sms_chars: 160,
    max_attempts: 2,
    ...PROVIDER_CONFIG,
    max_tokens: 4000,
    from_email: 'automations@example.com',
    sms_preview_to_email: 'sms-preview@example.com',
    telemetry_url: '',
    system_prompt: read('prompts/sms-followup-system.txt').trim(),
    attempt_1_guidance: 'First text. Friendly and brief: sorry we missed them, invite them to call or text back.',
    attempt_2_guidance: 'Final follow-up. The first text got no reply. Shorter than a first text, different wording, low pressure, and make it clear this is the last message for now.',
  }, [960, 300]));
  const wait2m = wf.add(wait(wf, 'Wait 2 Minutes', 2, 'minutes', [1200, 300]));
  const build = wf.add(code('Build SMS Request', 'code-nodes/missed-call-followup/build-sms-request.js', 'runOnceForEachItem', [1440, 300]));
  const useGemini = wf.add(ifNode(wf, 'Use Gemini?', [['={{ $json.llm_provider }}', 'equals', 'gemini']], 'and', [1680, 300]));
  const gemini = wf.add(geminiRequest('Gemini: Draft SMS', [1920, 160]));
  const claude = wf.add(claudeRequest('Claude: Draft SMS', [1920, 440]));
  const enforce = wf.add(code('Enforce SMS Rules', 'code-nodes/missed-call-followup/enforce-sms-rules.js', 'runOnceForEachItem', [2160, 300]));
  const provider = wf.add(noOp('SMS Provider (placeholder)', [2400, 300], 'PLACEHOLDER: replace with your SMS provider node'));
  const preview = wf.add(email('Email: SMS Preview', {
    from: `={{ ${C('from_email')} }}`,
    to: `={{ ${C('sms_preview_to_email')} }}`,
    subject: `=[SMS PREVIEW] Attempt {{ ${E('attempt')} }} to {{ ${E('phone')} }} ({{ ${E('contact_name')} }})`,
    text: [
      '=This email stands in for a real SMS until a provider is connected.',
      '',
      `To: {{ ${E('phone')} }}`,
      `Message ({{ ${E('sms_length')} }} chars):`,
      `{{ ${E('sms_text')} }}`,
      '',
      `Source: {{ ${E('sms_source')} }}`,
      `Issues fixed: {{ ${E('sms_issues')} || 'none' }}`,
      `Campaign: {{ ${E('campaign')} }}`,
      `Follow-up ID: {{ ${E('followup_id')} }}`,
    ].join('\n'),
  }, [2640, 300]));

  const logColumns = [
    ['timestamp', `={{ ${E('drafted_at')} }}`],
    ['followup_id', `={{ ${E('followup_id')} }}`],
    ['contact_name', `={{ ${E('contact_name')} }}`],
    ['phone', `={{ ${E('phone')} }}`],
    ['campaign', `={{ ${E('campaign')} }}`],
    ['missed_at', `={{ ${E('missed_at')} }}`],
    ['attempt', `={{ ${E('attempt')} }}`],
    ['message', `={{ ${E('sms_text')} }}`],
    ['sms_length', `={{ ${E('sms_length')} }}`],
    ['sms_source', `={{ ${E('sms_source')} }}`],
    ['sms_issues', `={{ ${E('sms_issues')} }}`],
    ['replied', ''],
    ['opted_out', ''],
  ];
  const log = wf.add(sheetsAppend('Log SMS Attempt', 'SMS Log', logColumns, [2880, 300]));
  const more = wf.add(ifNode(wf, 'More Attempts Allowed?', [
    [`={{ ${E('attempt')} }}`, 'lessThan', `={{ ${C('max_attempts')} }}`],
  ], 'and', [3120, 300]));
  const doneMax = wf.add(noOp('Done: Max Attempts Reached', [3360, 460]));
  const wait1h = wf.add(wait(wf, 'Wait 1 Hour', 1, 'hours', [3120, 700]));
  const lookup = wf.add(sheetsLookup('Read Reply Flag', 'SMS Log', 'phone', `={{ ${E('phone')} }}`, [2880, 700]));
  const check = wf.add(code('Check Reply Flag', 'code-nodes/missed-call-followup/check-reply-flag.js', 'runOnceForAllItems', [2640, 700]));
  const sendAgain = wf.add(ifNode(wf, 'Send Follow-up?', [['={{ $json.send_followup }}', 'isTrue']], 'and', [2400, 700]));
  const doneReplied = wf.add(noOp('Done: Replied or Opted Out', [2160, 880]));

  const telemetry = wf.add(code('Telemetry: Report Attempt', 'code-nodes/missed-call-followup/build-telemetry.js', 'runOnceForAllItems', [3360, 700]));
  const postTelemetry = wf.add(telemetryRequest('Telemetry: Post Attempt', [3600, 700]));

  wf.connect(hook, validate);
  wf.connect(validate, isValid);
  wf.connect(isValid, accepted, 0);
  wf.connect(isValid, invalid, 1);
  wf.connect(accepted, config);
  wf.connect(config, wait2m);
  wf.connect(wait2m, build);
  wf.connect(build, useGemini);
  wf.connect(useGemini, gemini, 0);
  wf.connect(useGemini, claude, 1);
  wf.connect(gemini, enforce);
  wf.connect(claude, enforce);
  wf.connect(enforce, provider);
  wf.connect(provider, preview);
  wf.connect(preview, log);
  // Telemetry first, and the order matters: the other branch runs into
  // "Wait 1 Hour", and a Wait node suspends the whole execution, queueing
  // every sibling branch behind it. Connected the other way round, attempt
  // 1's tokens and latency would not be reported until an hour later.
  wf.connect(log, telemetry);
  wf.connect(telemetry, postTelemetry);
  wf.connect(log, more);
  wf.connect(more, wait1h, 0);
  wf.connect(more, doneMax, 1);
  wf.connect(wait1h, lookup);
  wf.connect(lookup, check);
  wf.connect(check, sendAgain);
  wf.connect(sendAgain, build, 0);
  wf.connect(sendAgain, doneReplied, 1);

  return wf.toJSON();
}

mkdirSync(join(root, 'workflows'), { recursive: true });
for (const [file, build] of [
  ['ai-lead-qualification.json', buildLeadQualification],
  ['missed-call-followup.json', buildMissedCallFollowup],
]) {
  writeFileSync(join(root, 'workflows', file), JSON.stringify(build(), null, 2) + '\n');
  console.log(`wrote workflows/${file}`);
}
