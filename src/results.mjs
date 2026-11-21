// Load saved eval runs and merge them: for each model, every case shows its most recent result from any saved run,
// so re-running one case after a fix updates that case without wiping the rest.
// A case with any crashed call (API error, timeout, quota) was not fully scored by the model, so that case is skipped,
// never counted as a model failure.

import fs from 'node:fs';
import path from 'node:path';

export function loadMerged(resultsDir, { includeMock = false } = {}) {
  const files = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter((f) => /^run-.*\.json$/.test(f)) : [];
  const byModel = new Map();
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
    if (!includeMock && String(r.model).startsWith('mock')) continue;
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  return [...byModel].map(([model, runs]) => merge(model, runs)).filter((m) => Object.keys(m.perCase).length > 0);
}

function merge(model, runs) {
  runs.sort((a, b) => a.when.localeCompare(b.when)); // oldest first, newer results overwrite
  const perCase = {}, caseInfo = {}, detail = [];
  let when = runs[0].when;
  for (const r of runs) {
    for (const id of Object.keys(r.perCase)) {
      if (r.detail.some((d) => d.case === id && d.crashed)) continue;
      perCase[id] = r.perCase[id];
      if (r.caseInfo?.[id]) caseInfo[id] = r.caseInfo[id];
      for (let i = detail.length - 1; i >= 0; i--) if (detail[i].case === id) detail.splice(i, 1);
      detail.push(...r.detail.filter((d) => d.case === id));
      when = r.when;
    }
  }
  const ids = Object.keys(perCase);
  const meanPass = ids.length ? ids.reduce((s, id) => s + perCase[id].passRate, 0) / ids.length : 0;
  const allPass = ids.length ? ids.filter((id) => perCase[id].allRunsPass).length / ids.length : 0;
  const runsPerCase = ids.length ? Math.round(ids.reduce((s, id) => s + perCase[id].runs, 0) / ids.length) : 0;
  const priced = detail.length > 0 && detail.every((d) => d.costUsd != null);
  const totals = { costUsd: priced ? detail.reduce((s, d) => s + d.costUsd, 0) : null };
  return { model, when, runs: runsPerCase, meanPass, allPass, totals, perCase, caseInfo, detail };
}

// "<" must never appear raw inside an inline JSON block, or model output containing a closing script tag could end it early.
export const safeJson = (data) => JSON.stringify(data).replace(/</g, String.fromCharCode(92) + 'u003c');
