// End-to-end test of the demo server using the scripted (no AI) model, so it needs no API key and no quota.
//   node test-server.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEMO_SCRIPTED = '1';
process.env.GEMINI_API_KEY = ''; // keep the test off real models even if .env has a key
process.env.ANTHROPIC_API_KEY = '';
process.env.DEMO_RUNS_PER_HOUR = '4';
const auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'audit.jsonl');
process.env.AUDIT_FILE = auditFile;

const { server } = await import('./server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function run(body) {
  const res = await post('/api/run', body);
  if (!res.ok) return { status: res.status, json: await res.json(), events: [] };
  const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: 200, events };
}
const CSV = 'name,city\n  Ann ,  Paris\nBob,Rome  \n';

await test('page and model list are served', async () => {
  assert.match(await (await fetch(base + '/')).text(), /Messy CSV cleaner/);
  assert.deepEqual((await (await fetch(base + '/api/models')).json()).models, ['scripted']);
});

let runId;
await test("health check responds", async () => {
  assert.deepEqual(await (await fetch(base + "/healthz")).json(), { ok: true });
});

await test('a run streams steps and returns a before/after result', async () => {
  const r = await run({ csv: CSV, task: 'trim everything', model: 'scripted' });
  assert.equal(r.status, 200);
  assert.equal(r.events[0].type, 'start');
  assert.ok(r.events.some((e) => e.type === 'tool' && e.tool === 'trim_whitespace'));
  const result = r.events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.finish.status, 'done');
  assert.equal(result.changedCells, 3); // "  Ann ", "  Paris" and "Rome  " change; "Bob" does not
  assert.deepEqual(result.after, [{ name: 'Ann', city: 'Paris' }, { name: 'Bob', city: 'Rome' }]);
  runId = result.runId;
});

await test('nothing is released before a decision, and the audit log is empty', async () => {
  assert.equal(fs.existsSync(auditFile), false);
});

await test('approve returns the cleaned CSV and logs hashes only, never the data', async () => {
  const res = await post('/api/decision', { runId, decision: 'approve' });
  const j = await res.json();
  assert.equal(j.csv, 'name,city\nAnn,Paris\nBob,Rome\n');
  const log = fs.readFileSync(auditFile, 'utf8');
  const entry = JSON.parse(log.trim());
  assert.equal(entry.decision, 'approve');
  assert.equal(entry.rowsIn, 2);
  assert.match(entry.inputHash, /^[0-9a-f]{16}$/);
  assert.ok(!log.includes('Ann') && !log.includes('Paris') && !log.includes('trim everything'), 'audit log must not contain the data or the task text');
});

await test('a decision can only be made once', async () => {
  assert.equal((await post('/api/decision', { runId, decision: 'approve' })).status, 404);
});

await test('reject keeps nothing and still logs the decision', async () => {
  const r = await run({ csv: CSV, task: 'trim', model: 'scripted' });
  const id = r.events.at(-1).runId;
  const j = await (await post('/api/decision', { runId: id, decision: 'reject' })).json();
  assert.equal(j.csv, undefined);
  assert.equal(fs.readFileSync(auditFile, 'utf8').trim().split('\n').length, 2);
});

await test('bad input is rejected with a clear message', async () => {
  assert.equal((await run({ csv: '', task: 'x', model: 'scripted' })).status, 400);
  assert.equal((await run({ csv: 'a,a\n1,2', task: 'x', model: 'scripted' })).status, 400);
  assert.equal((await run({ csv: CSV, task: '', model: 'scripted' })).status, 400);
  assert.equal((await run({ csv: CSV, task: 'x'.repeat(601), model: 'scripted' })).status, 400);
  assert.equal((await post('/api/decision', { runId: 'nope', decision: 'approve' })).status, 404);
});

await test('oversized requests are refused', async () => {
  const res = await post('/api/run', { csv: 'a\n' + 'x'.repeat(400 * 1024), task: 'x', model: 'scripted' }).catch(() => ({ status: 'closed' }));
  assert.ok(res.status === 413 || res.status === 'closed', `expected 413 or a closed connection, got ${res.status}`);
});

await test('the hourly run limit stops further runs', async () => {
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await run({ csv: CSV, task: 'trim', model: 'scripted' })).status);
  assert.ok(codes.includes(429), `expected a 429 after the limit, got ${codes.join(',')}`);
});

await test('formulas in downloaded files are neutralised', async () => {
  // Use a fresh server-side counter by waiting is not possible, so check the writer directly.
  const { toCsv } = await import('./src/csv.mjs');
  assert.equal(toCsv(['a'], [{ a: '=1+1' }, { a: '-5' }, { a: '@x' }]), "a\n'=1+1\n-5\n'@x\n");
});

await test('behind a proxy, the limit applies per visitor (X-Forwarded-For), and only when TRUST_PROXY=1', async () => {
  const withIp = async (ip) => (await fetch(base + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ csv: CSV, task: 'trim', model: 'scripted' }) })).status;
  // Header ignored by default: the local address bucket is already exhausted by the previous test, so everything is refused.
  assert.equal(await withIp('9.9.9.9'), 429);
  process.env.TRUST_PROXY = '1';
  try {
    assert.equal(await withIp('1.1.1.1'), 200); // a fresh visitor is allowed even though 127.0.0.1 is exhausted
    for (let i = 0; i < 3; i++) assert.equal(await withIp('1.1.1.1'), 200);
    assert.equal(await withIp('1.1.1.1'), 429); // same visitor hits the limit
    assert.equal(await withIp('2.2.2.2'), 200); // a different visitor is unaffected
    // A client cannot dodge the limit by prepending fake addresses: the last entry (added by the proxy) is used.
    assert.equal(await withIp('5.5.5.5, 1.1.1.1'), 429);
  } finally { process.env.TRUST_PROXY = ''; }
});

server.close();
console.log(`\n${passed} server tests passed`);
process.exit(0);
