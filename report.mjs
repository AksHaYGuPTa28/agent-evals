// Build a single self-contained HTML report from the saved eval runs.
//   node report.mjs                       -> results/report.html   (latest result per case for each model, mock models hidden)
//   node report.mjs --out docs/report.html -> write somewhere else (for GitHub Pages)
//   node report.mjs --include-mock        -> also show the scripted mock models

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMerged, safeJson } from './src/results.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fb) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fb : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };

const runs = loadMerged(path.join(here, 'results'), { includeMock: !!arg('include-mock', false) });
if (runs.length === 0) { console.error('No scored (non-mock) run files in results/. Run an eval first.'); process.exit(2); }

let findings = [];
try { findings = JSON.parse(fs.readFileSync(path.join(here, 'findings.json'), 'utf8')); } catch { /* optional */ }

const data = { generated: new Date().toISOString().slice(0, 10), runs, findings, replayHref: arg('replay-href', null) };
const html = fs.readFileSync(path.join(here, 'src', 'report.template.html'), 'utf8').replace('/*DATA*/null', () => safeJson(data));

const out = path.resolve(here, arg('out', 'results/report.html'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(here, out)} (${(html.length / 1024).toFixed(0)} KB) with ${runs.length} model(s): ${runs.map((r) => `${r.model} (${Object.keys(r.perCase).length} cases, ${(r.meanPass * 100).toFixed(0)}%)`).join(', ')}`);
