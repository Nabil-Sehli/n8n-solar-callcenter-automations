// Static checks on workflows/*.json. Exits non-zero on any problem.
//
//   node scripts/validate-workflows.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'workflows');

// Versions available in n8n 2.38.7 (dist/types/nodes.json in the docker image).
const KNOWN_NODE_VERSIONS = {
  'n8n-nodes-base.webhook': [1, 1.1, 2, 2.1],
  'n8n-nodes-base.code': [1, 2],
  'n8n-nodes-base.if': [1, 2, 2.1, 2.2, 2.3],
  'n8n-nodes-base.set': [1, 2, 3, 3.1, 3.2, 3.3, 3.4, 3.5],
  'n8n-nodes-base.httpRequest': [1, 2, 3, 4, 4.1, 4.2, 4.3, 4.4, 4.5],
  'n8n-nodes-base.emailSend': [1, 2, 2.1],
  'n8n-nodes-base.googleSheets': [1, 2, 3, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7],
  'n8n-nodes-base.respondToWebhook': [1, 1.1, 1.2, 1.3, 1.4, 1.5],
  'n8n-nodes-base.wait': [1, 1.1],
  'n8n-nodes-base.noOp': [1],
  'n8n-nodes-base.stickyNote': [1],
};
const TRIGGERS = new Set(['n8n-nodes-base.webhook']);
const NEEDS_WEBHOOK_ID = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.wait']);
const NODE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_PATTERNS = [/sk-ant-[a-z0-9-_]{10,}/i, /AIza[0-9A-Za-z-_]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[0-9a-z-]+/i];

let failures = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const errors = [];
  const raw = readFileSync(join(dir, file), 'utf8');
  const wf = JSON.parse(raw);

  for (const key of ['name', 'nodes', 'connections', 'settings', 'pinData']) {
    if (!(key in wf)) errors.push(`missing top-level key "${key}"`);
  }
  // Without an id, `n8n import:workflow` fails with NOT NULL constraint on workflow_entity.id.
  if (!/^[A-Za-z0-9]{16}$/.test(wf.id ?? '')) errors.push('top-level "id" must be a 16-char alphanumeric string');

  const names = new Set();
  const ids = new Set();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    if (!UUID.test(n.id)) errors.push(`node "${n.name}" id is not a UUID`);
    ids.add(n.id);
    if (names.has(n.name)) errors.push(`duplicate node name "${n.name}"`);
    names.add(n.name);

    const versions = KNOWN_NODE_VERSIONS[n.type];
    if (!versions) errors.push(`node "${n.name}" has unknown type ${n.type}`);
    else if (!versions.includes(n.typeVersion)) errors.push(`node "${n.name}" ${n.type} has unknown typeVersion ${n.typeVersion}`);

    if (!Array.isArray(n.position) || n.position.length !== 2) errors.push(`node "${n.name}" has no position`);
    if (NEEDS_WEBHOOK_ID.has(n.type) && !UUID.test(n.webhookId ?? '')) errors.push(`node "${n.name}" needs a webhookId`);

    for (const [type, cred] of Object.entries(n.credentials ?? {})) {
      const keys = Object.keys(cred).sort().join(',');
      if (keys !== 'id,name' || cred.id !== null || !cred.name) {
        errors.push(`node "${n.name}" credential ${type} must be { id: null, name } only`);
      }
    }
  }

  // Overlap: regular nodes are ~100x100, sticky notes use their own size.
  const box = (n) =>
    n.type === 'n8n-nodes-base.stickyNote'
      ? { x: n.position[0], y: n.position[1], w: n.parameters.width, h: n.parameters.height }
      : { x: n.position[0], y: n.position[1], w: NODE_SIZE, h: NODE_SIZE };
  for (let i = 0; i < wf.nodes.length; i++) {
    for (let j = i + 1; j < wf.nodes.length; j++) {
      const a = box(wf.nodes[i]);
      const b = box(wf.nodes[j]);
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        errors.push(`nodes overlap: "${wf.nodes[i].name}" and "${wf.nodes[j].name}"`);
      }
    }
  }

  // Connections point at real nodes; every non-trigger node has an input.
  const hasInput = new Set();
  for (const [from, outputs] of Object.entries(wf.connections)) {
    if (!names.has(from)) errors.push(`connection from unknown node "${from}"`);
    for (const branch of outputs.main ?? []) {
      for (const c of branch) {
        if (!names.has(c.node)) errors.push(`connection from "${from}" to unknown node "${c.node}"`);
        hasInput.add(c.node);
      }
    }
  }
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.stickyNote' || TRIGGERS.has(n.type)) continue;
    if (!hasInput.has(n.name)) errors.push(`node "${n.name}" is not connected to anything`);
  }

  // Every $('Node Name') in code or expressions must match a node in this workflow.
  for (const m of raw.matchAll(/\$\(\s*\\?['"]([^'"\\]+)\\?['"]\s*\)/g)) {
    if (!names.has(m[1])) errors.push(`reference to missing node $('${m[1]}')`);
  }

  for (const re of SECRET_PATTERNS) {
    if (re.test(raw)) errors.push(`possible secret matching ${re}`);
  }

  if (errors.length) {
    failures += errors.length;
    console.error(`FAIL ${file}`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    const count = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length;
    console.log(`ok   ${file} (${count} nodes)`);
  }
}

process.exit(failures ? 1 : 0);
