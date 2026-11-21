// Demo server: upload a messy CSV, describe the cleaning in plain English, watch the agent work step by step,
// review a before/after diff, and approve or reject. Nothing is returned for download until a person approves.
//
//   node server.mjs                 -> http://localhost:3000   (needs GEMINI_API_KEY or ANTHROPIC_API_KEY in .env)
//   DEMO_SCRIPTED=1 node server.mjs -> adds a "scripted (no AI)" model for trying the UI without any key
//
// The API key stays on the server and is never sent to the browser. Safeguards for a demo that costs money:
// size limits, a per-visitor hourly run limit, a hard step limit, and no data stored (the audit log keeps hashes and counts only).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runAgent } from './src/agent.mjs';
import { parseCsv, toCsv } from './src/csv.mjs';
import { anthropicModel, geminiModel } from './src/models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 300 * 1024;
const MAX_TASK = 600;
const RUNS_PER_HOUR = Number(process.env.DEMO_RUNS_PER_HOUR || 12);
const AUDIT_FILE = process.env.AUDIT_FILE || path.join(here, 'audit.jsonl');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// A tiny rule-based stand-in so the UI can be tried and tested without any API key. It is NOT an AI and the page says so.
const scriptedModel = {
  name: 'scripted (no AI)',
  async respond({ messages, tools, meta }) {
    const turn = messages.filter((m) => m.role === 'assistant').length;
    const cols = meta?.columns ?? [];
    const plan = [{ name: 'profile', input: {} }, ...cols.map((c) => ({ name: 'trim_whitespace', input: { column: c } })), { name: 'show_rows', input: {} }];
    const step = plan[turn] ?? { name: 'finish', input: { status: 'done', summary: 'Trimmed whitespace in every column (scripted, no AI).' } };
    return { content: [{ type: 'tool_use', id: `s${turn}`, name: step.name, input: step.input }], usage: { input: 0, output: 0 } };
  },
};

function availableModels() {
  const list = [];
  if (process.env.GEMINI_API_KEY) list.push('gemini-3.5-flash-lite', 'gemini-3.5-flash');
  if (process.env.ANTHROPIC_API_KEY) list.push('claude-haiku-5-5', 'claude-sonnet-5-5');
  if (process.env.DEMO_SCRIPTED) list.push('scripted');
  return list;
}
function makeModel(name) {
  if (name === 'scripted') return scriptedModel;
  if (name.startsWith('gemini')) return geminiModel(name);
  return anthropicModel(name);
}

const hits = new Map(); // ip -> [timestamps]
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600e3);
  if (recent.length >= RUNS_PER_HOUR) { hits.set(ip, recent); return true; }
  recent.push(now); hits.set(ip, recent); return false;
}

const pending = new Map(); // runId -> proposed result awaiting a human decision
function audit(entry) { fs.appendFileSync(AUDIT_FILE, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n'); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large (max 300 KB).'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const send = (res, status, obj, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };

function diffCells(columns, before, after) {
  // Rows can be removed, so compare by position only when the counts match; otherwise report counts only.
  if (before.length !== after.length) return { comparable: false, changed: 0 };
  let changed = 0;
  for (let i = 0; i < before.length; i++) for (const c of columns) if (String(before[i][c] ?? '') !== String(after[i][c] ?? '')) changed++;
  return { comparable: true, changed };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(here, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/models') return send(res, 200, { models: availableModels(), scripted: !!process.env.DEMO_SCRIPTED });

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readBody(req);
      const models = availableModels();
      if (models.length === 0) return send(res, 503, { error: 'No model is configured on the server. Add GEMINI_API_KEY or ANTHROPIC_API_KEY to .env.' });
      const modelName = body.model && models.includes(body.model) ? body.model : models[0];
      const task = String(body.task ?? '').trim();
      if (!task || task.length > MAX_TASK) return send(res, 400, { error: `Describe the cleaning in 1 to ${MAX_TASK} characters.` });
      let table;
      try { table = parseCsv(String(body.csv ?? '')); } catch (e) { return send(res, 400, { error: e.message }); }
      if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'Run limit reached for this hour. Try again later.' });

      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const emit = (o) => res.write(JSON.stringify(o) + '\n');
      const runId = crypto.randomUUID();
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      emit({ type: 'start', runId, model: modelName, rows: table.rows.length, columns: table.columns });
      try {
        const result = await runAgent({
          model: makeModel(modelName), task, table, maxSteps: 12, signal: ac.signal,
          meta: { columns: table.columns }, onEvent: (e) => emit(e),
        });
        const cleaned = result.table;
        const d = diffCells(cleaned.columns, table.rows, cleaned.rows);
        pending.set(runId, { table: cleaned, model: modelName, taskHash: sha(task), inputHash: sha(JSON.stringify(table.rows)), rowsIn: table.rows.length, result, createdAt: Date.now() });
        emit({
          type: 'result', runId, finish: result.finish, stopReason: result.stopReason, steps: result.steps, toolErrors: result.toolErrors,
          usage: result.usage, ms: result.wallMs, before: table.rows.slice(0, 60), after: cleaned.rows.slice(0, 60), columns: cleaned.columns,
          afterRows: cleaned.rows.length, beforeRows: table.rows.length, changedCells: d.changed, comparable: d.comparable,
        });
      } catch (e) {
        emit({ type: 'error', error: /^API (400|401|403|404|429)/.test(e.message) ? 'The model API rejected the request. Check the server key, model name and quota.' : 'The run failed: ' + e.message.slice(0, 200) });
      }
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/api/decision') {
      const { runId, decision } = await readBody(req);
      const p = pending.get(runId);
      if (!p) return send(res, 404, { error: 'Unknown or expired run.' });
      if (decision !== 'approve' && decision !== 'reject') return send(res, 400, { error: 'decision must be approve or reject' });
      pending.delete(runId);
      audit({
        runId, decision, model: p.model, taskHash: p.taskHash, inputHash: p.inputHash, outputHash: sha(JSON.stringify(p.table.rows)),
        status: p.result.finish?.status ?? p.result.stopReason, steps: p.result.steps, toolErrors: p.result.toolErrors,
        tokens: p.result.usage, rowsIn: p.rowsIn, rowsOut: p.table.rows.length,
      });
      if (decision === 'reject') return send(res, 200, { ok: true });
      return send(res, 200, { ok: true, csv: toCsv(p.table.columns, p.table.rows) });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' }); else res.end();
  }
});

setInterval(() => { for (const [id, p] of pending) if (Date.now() - p.createdAt > 3600e3) pending.delete(id); }, 600e3).unref();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    const m = availableModels();
    console.log(`Demo on http://localhost:${PORT}   models: ${m.length ? m.join(', ') : 'NONE (add a key to .env, or set DEMO_SCRIPTED=1)'}`);
  });
}
export { server };
