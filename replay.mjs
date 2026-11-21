// Build a static replay page from recorded runs, so anyone can watch real agent runs with no key, no server and no cost.
//   node replay.mjs                         -> results/replay.html
//   node replay.mjs --out docs/index.html --report-href report.html
//
// For each model and case it picks one recorded run: a run the agent got wrong if there is one (the interesting ones),
// otherwise the first run. Cases without a recorded trace or table (older result files) are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMerged, safeJson } from './src/results.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fb) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fb : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };

const picked = [];
for (const m of loadMerged(path.join(here, 'results'), { includeMock: !!arg('include-mock', false) })) {
  for (const id of Object.keys(m.perCase)) {
    const info = m.caseInfo[id];
    const runs = m.detail.filter((d) => d.case === id && d.trace?.length && d.finalRows && !d.crashed);
    if (!info || runs.length === 0) continue;
    const d = runs.find((x) => !x.pass) ?? runs[0];
    picked.push({
      case: id, why: info.why, task: info.task, model: m.model, run: d.run, pass: d.pass, reasons: d.reasons ?? [],
      columns: info.columns, expectedColumns: info.expectedColumns ?? info.columns, input: info.input, expected: info.expected,
      finalColumns: Object.keys(d.finalRows[0] ?? {}).length ? Object.keys(d.finalRows[0]) : (info.expectedColumns ?? info.columns),
      finalRows: d.finalRows, trace: d.trace.map((s) => ({ step: s.step, tool: s.tool, input: s.input, error: s.error, output: s.output })),
      finish: d.finish ?? null, steps: d.steps, toolErrors: d.toolErrors, tokens: d.usage ? d.usage.input + d.usage.output : 0,
    });
  }
}
if (picked.length === 0) { console.error('No recorded runs with traces found in results/. Run an eval first.'); process.exit(2); }
picked.sort((a, b) => Number(a.pass) - Number(b.pass) || a.case.localeCompare(b.case) || a.model.localeCompare(b.model)); // wrong ones first

const data = { generated: new Date().toISOString().slice(0, 10), runs: picked, reportHref: arg('report-href', null) };
const html = fs.readFileSync(path.join(here, 'src', 'replay.template.html'), 'utf8').replace('/*DATA*/null', () => safeJson(data));
const out = path.resolve(here, arg('out', 'results/replay.html'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(here, out)} (${(html.length / 1024).toFixed(0)} KB) with ${picked.length} recorded runs (${picked.filter((p) => !p.pass).length} wrong, ${picked.filter((p) => p.pass).length} right)`);
