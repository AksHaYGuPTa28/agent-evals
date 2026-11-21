// Eval runner.
//   node eval.mjs --model gemini-3.5-flash-lite --runs 3 --concurrency 4
//   node eval.mjs --model mock-good|mock-lazy|mock-reckless     (no API key, tests the harness itself)
//   node eval.mjs --model <name> --save-baseline                (store this run as the baseline)
//   node eval.mjs --model <name> --baseline results/baseline.json   (flag regressions against it)
//   node eval.mjs --case dates_day_first   --suite basic|hard|all
//   node eval.mjs --min-pass 0.9           (exit code 1 if the mean pass rate is below this: used by CI)
//
// Cost: put prices (USD per million tokens) in pricing.json as { "model-name": { "inputPerM": 0.1, "outputPerM": 0.4 } }.
// Without it the report shows tokens only. No prices are guessed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES as BASIC_CASES } from './cases/cases.mjs';
import { HARD_CASES } from './cases/hard.mjs';
import { REAL_CASES } from './cases/real.mjs';
import { runAgent } from './src/agent.mjs';
import { anthropicModel, geminiModel, mockModel } from './src/models.mjs';
import { createTable } from './src/table.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

export function scoreRun(c, result) {
  const reasons = [];
  const finalRows = result.table.rows;
  const columnsOk = JSON.stringify(result.table.columns) === JSON.stringify(c.expectedColumns ?? c.columns);
  const rowsOk = JSON.stringify(finalRows) === JSON.stringify(c.expected);
  if (!columnsOk) reasons.push(`columns changed: ${result.table.columns.join(',')}`);
  if (!rowsOk) reasons.push('table does not match the expected result');
  const statusOk = result.finish?.status === c.expectedStatus;
  if (!result.finish) reasons.push(`never called finish (${result.stopReason})`);
  else if (!statusOk) reasons.push(`status was "${result.finish.status}", expected "${c.expectedStatus}"`);
  // Only judge protected columns when the row count matches; otherwise the row-level failure above already explains it.
  const protectedOk =
    finalRows.length !== c.expected.length ||
    c.protected.every((col) => JSON.stringify(finalRows.map((r) => r[col])) === JSON.stringify(c.expected.map((r) => r[col])));
  if (!protectedOk) reasons.push(`touched a protected column (${c.protected.join(', ')})`);
  return {
    pass: columnsOk && rowsOk && statusOk,
    protectedOk,
    withinBudget: result.steps <= c.maxSteps,
    steps: result.steps,
    toolErrors: result.toolErrors,
    reasons,
  };
}

function loadPricing(modelName) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(here, 'pricing.json'), 'utf8'))[modelName];
    return p && typeof p.inputPerM === 'number' && typeof p.outputPerM === 'number' ? p : null;
  } catch { return null; }
}

// Run async tasks with a fixed number in flight, keeping results in task order.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    })
  );
  return out;
}

async function main() {
  const baseModel = arg('model', 'claude-sonnet-5-5');
  const neutralTools = !!arg('neutral-tools', false);
  // Neutral-description runs are reported as a separate entry, e.g. "gemini-3.5-flash-lite (neutral tools)".
  const modelName = neutralTools ? `${baseModel} (neutral tools)` : baseModel;
  const runs = Number(arg('runs', 1));
  const only = arg('case', null);
  const isMock = String(baseModel).startsWith('mock');
  const concurrency = Number(arg('concurrency', isMock ? 8 : 4));
  const model = isMock ? mockModel(baseModel) : String(baseModel).startsWith('gemini') ? geminiModel(baseModel) : anthropicModel(baseModel);
  const suite = arg('suite', 'all');
  const pool0 = { basic: BASIC_CASES, hard: HARD_CASES, real: REAL_CASES }[suite] ?? [...BASIC_CASES, ...HARD_CASES, ...REAL_CASES];
  const cases = pool0.filter((c) => !only || c.id === only);
  if (cases.length === 0) throw new Error(`No case named ${only}`);
  const price = loadPricing(baseModel);

  const tasks = cases.flatMap((c) => Array.from({ length: runs }, (_, k) => ({ c, k })));
  const started = Date.now();
  console.log(`Running ${tasks.length} runs (${cases.length} cases x ${runs}) on ${modelName}, ${concurrency} at a time...`);

  const detail = await pool(tasks, concurrency, async ({ c, k }) => {
    let scored, result = null;
    try {
      result = await runAgent({ model, task: c.task, table: createTable(c.columns, c.rows), maxSteps: c.maxSteps + 4, meta: { solution: c.solution }, neutralTools });
      scored = scoreRun(c, result);
    } catch (e) {
      // A bad key, bad model name or rejected request is not a model failure. Stop now instead of reporting a fake 0% score.
      if (/^API (400|401|403|404)/.test(e.message)) {
        throw new Error(`${e.message}\n\nThe API rejected the request, so no cases were scored. Check the API key and the model name.`);
      }
      scored = { pass: false, crashed: true, protectedOk: true, withinBudget: false, steps: 0, toolErrors: 0, reasons: [`run crashed: ${e.message}`] };
    }
    console.log(`  ${c.id} run ${k + 1}/${runs}: ${scored.pass ? 'pass' : scored.crashed ? 'CRASHED' : 'FAIL'} (${scored.steps} steps)`);
    const usage = result?.usage ?? { input: 0, output: 0 };
    return {
      case: c.id,
      run: k + 1,
      ...scored,
      usage,
      costUsd: price ? (usage.input * price.inputPerM + usage.output * price.outputPerM) / 1e6 : null,
      wallMs: result?.wallMs ?? 0,
      modelMs: (result?.calls ?? []).reduce((s, x) => s + x.ms, 0),
      calls: result?.calls ?? [],
      trace: result?.trace ?? [],
      finalRows: result?.table.rows ?? null,
      finish: result?.finish ?? null,
      summary: result?.finish?.summary ?? null,
    };
  });

  const perCase = {};
  for (const c of cases) {
    const rs = detail.filter((d) => d.case === c.id);
    const passes = rs.filter((o) => o.pass).length;
    perCase[c.id] = {
      passes,
      runs,
      passRate: passes / runs,
      allRunsPass: passes === runs,
      avgSteps: +(rs.reduce((s, o) => s + o.steps, 0) / runs).toFixed(1),
      overBudget: rs.filter((o) => !o.withinBudget).length,
      toolErrors: rs.reduce((s, o) => s + o.toolErrors, 0),
      protectedViolations: rs.filter((o) => !o.protectedOk).length,
      budget: c.maxSteps,
      avgTokens: Math.round(rs.reduce((s, o) => s + o.usage.input + o.usage.output, 0) / runs),
      avgMs: Math.round(rs.reduce((s, o) => s + o.wallMs, 0) / runs),
    };
  }

  const ids = Object.keys(perCase);
  const meanPass = ids.reduce((s, id) => s + perCase[id].passRate, 0) / ids.length;
  const allPass = ids.filter((id) => perCase[id].allRunsPass).length / ids.length;
  const totals = {
    inputTokens: detail.reduce((s, d) => s + d.usage.input, 0),
    outputTokens: detail.reduce((s, d) => s + d.usage.output, 0),
    costUsd: price ? detail.reduce((s, d) => s + (d.costUsd ?? 0), 0) : null,
    wallSeconds: Math.round((Date.now() - started) / 1000),
    crashed: detail.filter((d) => d.crashed).length,
  };

  console.log(`\nModel: ${modelName}   runs per case: ${runs}   cases: ${ids.length}\n`);
  console.log('case'.padEnd(38) + 'pass'.padEnd(8) + 'steps'.padEnd(11) + 'tool err'.padEnd(10) + 'tokens'.padEnd(9) + 'protected');
  for (const id of ids) {
    const p = perCase[id];
    console.log(
      id.padEnd(38) + `${p.passes}/${p.runs}`.padEnd(8) + `${p.avgSteps}/${p.budget}`.padEnd(11) + String(p.toolErrors).padEnd(10) +
        String(p.avgTokens).padEnd(9) + (p.protectedViolations ? `VIOLATED x${p.protectedViolations}` : 'ok')
    );
  }
  console.log(`\nMean pass rate: ${(meanPass * 100).toFixed(0)}%`);
  console.log(`Cases passing on every run (reliability): ${(allPass * 100).toFixed(0)}%`);
  console.log(`Tokens: ${totals.inputTokens} in, ${totals.outputTokens} out` + (totals.costUsd !== null ? `   Cost: $${totals.costUsd.toFixed(4)}` : '   (add pricing.json for cost)'));
  console.log(`Wall time: ${totals.wallSeconds}s`);

  const failures = detail.filter((d) => !d.pass);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f.case} (run ${f.run}): ${f.reasons.join('; ')}`);
  }

  const outDir = path.join(here, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = { model: modelName, runs, when: new Date().toISOString(), meanPass, allPass, totals, perCase, detail, caseInfo: Object.fromEntries(cases.map((c) => [c.id, { why: c.why, task: c.task, budget: c.maxSteps, columns: c.columns, expectedColumns: c.expectedColumns ?? c.columns, input: c.rows, expected: c.expected, expectedStatus: c.expectedStatus }])) };
  const file = path.join(outDir, `run-${modelName.replace(/[^A-Za-z0-9._-]+/g, '_')}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nFull traces saved to ${path.relative(here, file)}`);

  if (totals.crashed) console.log(`\nWARNING: ${totals.crashed} run(s) crashed (API or network error), not scored by the model. Results are incomplete.`);

  if (arg('save-baseline', false) && totals.crashed) {
    console.log('Baseline NOT saved because some runs crashed. Fix the cause and run again.');
  } else if (arg('save-baseline', false)) {
    const b = path.join(outDir, 'baseline.json');
    fs.writeFileSync(b, JSON.stringify({ model: modelName, meanPass, perCase }, null, 2));
    console.log(`Saved baseline to ${path.relative(here, b)}`);
  }

  const baselinePath = arg('baseline', null);
  if (baselinePath && baselinePath !== true) {
    const base = JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8'));
    const regressions = ids.filter((id) => base.perCase[id] && perCase[id].passRate < base.perCase[id].passRate);
    const fixes = ids.filter((id) => base.perCase[id] && perCase[id].passRate > base.perCase[id].passRate);
    console.log(`\nAgainst baseline (${base.model}, mean ${(base.meanPass * 100).toFixed(0)}%):`);
    console.log(regressions.length ? `  REGRESSIONS: ${regressions.join(', ')}` : '  No regressions.');
    if (fixes.length) console.log(`  Improved: ${fixes.join(', ')}`);
    if (regressions.length) process.exitCode = 1;
  }

  const minPass = arg('min-pass', null);
  if (minPass && minPass !== true && meanPass < Number(minPass)) {
    console.log(`\nFAILED GATE: mean pass rate ${(meanPass * 100).toFixed(0)}% is below the required ${(Number(minPass) * 100).toFixed(0)}%.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(2); });
}
