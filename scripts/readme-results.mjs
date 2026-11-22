// Write the "Results" block of README.md straight from the saved eval runs, so no number is ever copied by hand.
//   node scripts/readme-results.mjs
// The block lives between <!--RESULTS--> and <!--/RESULTS-->. If only the opening marker exists, the closing one is added.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMerged } from '../src/results.mjs';

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = path.join(here, 'README.md');
const models = loadMerged(path.join(here, 'results'));
if (models.length === 0) { console.error('No scored runs in results/.'); process.exit(2); }

const pct = (x) => Math.round(x * 100) + '%';
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const base = (m) => m.model.replace(/ \(neutral tools\)$/, '');
const isNeutral = (m) => / \(neutral tools\)$/.test(m.model);

const lines = [];
lines.push('Latest scored result for each case, from the saved runs (a case with any crashed API call is left out, never counted as a failure). Each case runs 3 times. Small models, synthetic and a little real data: read these as signals, not rankings.');
lines.push('');
lines.push('| Model | Cases scored | Mean pass rate | Cases passing every run | Tokens per run | Time per run |');
lines.push('|---|---|---|---|---|---|');
for (const m of models) {
  const tok = avg(m.detail.map((d) => (d.usage ? d.usage.input + d.usage.output : 0)));
  const ms = avg(m.detail.map((d) => d.wallMs || 0));
  lines.push(`| ${m.model} | ${Object.keys(m.perCase).length} | ${pct(m.meanPass)} | ${pct(m.allPass)} | ${tok ? Math.round(tok).toLocaleString('en-US') : 'n/a'} | ${ms ? (ms / 1000).toFixed(1) + 's' : 'n/a'} |`);
}

// Cases that did not pass every run, per model.
const notClean = [];
for (const m of models) for (const [id, p] of Object.entries(m.perCase)) if (p.passes < p.runs) notClean.push(`| ${m.model} | \`${id}\` | ${p.passes}/${p.runs} |`);
lines.push('');
if (notClean.length) { lines.push('**Cases that did not pass every run**', '', '| Model | Case | Passes |', '|---|---|---|', ...notClean); } else lines.push('Every scored case passed every run.');

// Neutral descriptions versus normal descriptions, same underlying model, cases scored in both.
const cmp = [];
for (const n of models.filter(isNeutral)) {
  const normal = models.find((m) => !isNeutral(m) && m.model === base(n));
  if (!normal) continue;
  for (const id of Object.keys(n.perCase)) {
    if (!normal.perCase[id]) continue;
    cmp.push({ model: base(n), id, normal: normal.perCase[id], neutral: n.perCase[id] });
  }
}
if (cmp.length) {
  const worse = cmp.filter((c) => c.neutral.passes < c.normal.passes);
  const nTot = cmp.reduce((s, c) => s + c.neutral.passes, 0), nRuns = cmp.reduce((s, c) => s + c.neutral.runs, 0);
  const sTot = cmp.reduce((s, c) => s + c.normal.passes, 0), sRuns = cmp.reduce((s, c) => s + c.normal.runs, 0);
  lines.push('', '**Tool descriptions with and without hints** (`--neutral-tools`: descriptions say only what each tool does, with no warnings about traps). Same model, same cases:', '');
  lines.push(`Over the ${cmp.length} case(s) scored both ways, runs passed: ${sTot}/${sRuns} with the normal descriptions, ${nTot}/${nRuns} with neutral ones.` + (worse.length ? '' : ' No case did worse without the hints.'));
  if (worse.length) {
    lines.push('', '| Model | Case | Normal descriptions | Neutral descriptions |', '|---|---|---|---|');
    for (const c of worse) lines.push(`| ${c.model} | \`${c.id}\` | ${c.normal.passes}/${c.normal.runs} | ${c.neutral.passes}/${c.neutral.runs} |`);
  }
}
lines.push('', `Open [\`docs/index.html\`](docs/index.html) to watch recorded runs step by step, and [\`docs/report.html\`](docs/report.html) for the heatmap and every trace.`);

const block = '<!--RESULTS-->\n' + lines.join('\n') + '\n<!--/RESULTS-->';
let text = fs.readFileSync(readme, 'utf8');
if (text.includes('<!--/RESULTS-->')) text = text.replace(/<!--RESULTS-->[\s\S]*?<!--\/RESULTS-->/, () => block);
else if (text.includes('<!--RESULTS-->')) text = text.replace('<!--RESULTS-->', () => block);
else { console.error('README.md has no <!--RESULTS--> marker.'); process.exit(2); }
fs.writeFileSync(readme, text);
console.log(`Updated README results block: ${models.length} model(s), ${models.reduce((s, m) => s + Object.keys(m.perCase).length, 0)} case results.`);
