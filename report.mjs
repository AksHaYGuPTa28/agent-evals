// Build a single self-contained HTML report from the saved eval runs.
//   node report.mjs                       -> results/report.html   (latest result per case for each model, mock models hidden)
//   node report.mjs --out docs/index.html -> write somewhere else (for GitHub Pages)
//   node report.mjs --include-mock        -> also show the scripted mock models
//
// For each model, every case shows its most recent result from any saved run, so re-running one
// case after a fix updates that case without wiping the rest. Runs with crashed calls are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fb) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fb : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };

const dir = path.join(here, 'results');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f)) : [];
const byModel = new Map();
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!arg('include-mock', false) && String(r.model).startsWith('mock')) continue;
  if (r.detail?.some((d) => d.crashed) || (r.totals?.crashed ?? 0) > 0) continue; // never publish incomplete runs
  if (!byModel.has(r.model)) byModel.set(r.model, []);
  byModel.get(r.model).push(r);
}
if (byModel.size === 0) { console.error('No complete (non-mock) run files in results/. Run an eval first.'); process.exit(2); }

function merge(model, runs) {
  runs.sort((a, b) => a.when.localeCompare(b.when)); // oldest first, newer results overwrite
  const perCase = {}, caseInfo = {}, detail = [];
  let when = runs[0].when, usedRuns = 0;
  for (const r of runs) {
    for (const id of Object.keys(r.perCase)) {
      perCase[id] = r.perCase[id];
      if (r.caseInfo?.[id]) caseInfo[id] = r.caseInfo[id];
      for (let i = detail.length - 1; i >= 0; i--) if (detail[i].case === id) detail.splice(i, 1);
      detail.push(...r.detail.filter((d) => d.case === id));
      when = r.when;
    }
    usedRuns++;
  }
  const ids = Object.keys(perCase);
  const meanPass = ids.reduce((s, id) => s + perCase[id].passRate, 0) / ids.length;
  const allPass = ids.filter((id) => perCase[id].allRunsPass).length / ids.length;
  const runsPerCase = Math.round(ids.reduce((s, id) => s + perCase[id].runs, 0) / ids.length);
  const priced = detail.every((d) => d.costUsd != null);
  const totals = { costUsd: priced && detail.length ? detail.reduce((s, d) => s + d.costUsd, 0) : null };
  return { model, when, runs: runsPerCase, meanPass, allPass, totals, perCase, caseInfo, detail, mergedFrom: usedRuns };
}

let findings = [];
try { findings = JSON.parse(fs.readFileSync(path.join(here, 'findings.json'), 'utf8')); } catch { /* optional */ }

const data = { generated: new Date().toISOString().slice(0, 10), runs: [...byModel].map(([m, rs]) => merge(m, rs)), findings };
// Escape "<" so model output containing a closing script tag can never end the data block early.
const json = JSON.stringify(data).replace(/</g, String.fromCharCode(92) + 'u003c');
const html = fs.readFileSync(path.join(here, 'src', 'report.template.html'), 'utf8').replace('/*DATA*/null', () => json);

const out = path.resolve(here, arg('out', 'results/report.html'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(here, out)} (${(html.length / 1024).toFixed(0)} KB) with ${data.runs.length} model(s): ${data.runs.map((r) => `${r.model} (${Object.keys(r.perCase).length} cases, ${(r.meanPass * 100).toFixed(0)}%)`).join(', ')}`);
