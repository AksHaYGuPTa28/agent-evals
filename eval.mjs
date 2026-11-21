// Eval runner.
//   node eval.mjs --model claude-sonnet-5-5 --runs 3
//   node eval.mjs --model mock-good|mock-lazy|mock-reckless     (no API key, tests the harness itself)
//   node eval.mjs --model <name> --save-baseline                (store this run as the baseline)
//   node eval.mjs --model <name> --baseline results/baseline.json   (flag regressions against it)
//   node eval.mjs --case dates_day_first                        (run one case)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES as BASIC_CASES } from './cases/cases.mjs';
import { HARD_CASES } from './cases/hard.mjs';
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
  const columnsOk = JSON.stringify(result.table.columns) === JSON.stringify(c.columns);
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
  const withinBudget = result.steps <= c.maxSteps;
  return {
    pass: columnsOk && rowsOk && statusOk,
    protectedOk,
    withinBudget,
    steps: result.steps,
    toolErrors: result.toolErrors,
    reasons,
  };
}

async function main() {
  const modelName = arg('model', 'claude-sonnet-5-5');
  const runs = Number(arg('runs', 1));
  const only = arg('case', null);
  const isMock = String(modelName).startsWith('mock');
  const model = isMock ? mockModel(modelName) : String(modelName).startsWith('gemini') ? geminiModel(modelName) : anthropicModel(modelName);
  const suite = arg('suite', 'all');
  const pool = suite === 'basic' ? BASIC_CASES : suite === 'hard' ? HARD_CASES : [...BASIC_CASES, ...HARD_CASES];
  const cases = pool.filter((c) => !only || c.id === only);
  if (cases.length === 0) throw new Error(`No case named ${only}`);

  const perCase = {};
  const detail = [];
  for (const c of cases) {
    const input = createTable(c.columns, c.rows);
    const outcomes = [];
    for (let k = 0; k < runs; k++) {
      if (isMock) mockModel.currentSolution = c.solution;
      let scored;
      let result = null;
      try {
        result = await runAgent({ model, task: c.task, table: input, maxSteps: c.maxSteps + 4 });
        scored = scoreRun(c, result);
      } catch (e) {
        // A bad or missing key is not a model failure. Stop now instead of reporting a fake 0% score.
        if (/^API (400|401|403|404|429)/.test(e.message)) {
          throw new Error(`${e.message}\n\nThe API rejected the request, so no cases were scored. Check the API key and the model name.`);
        }
        scored = { pass: false, crashed: true, protectedOk: true, withinBudget: false, steps: 0, toolErrors: 0, reasons: [`run crashed: ${e.message}`] };
      }
      outcomes.push(scored);
      console.log(`  ${c.id} run ${k + 1}/${runs}: ${scored.pass ? 'pass' : scored.crashed ? 'CRASHED' : 'FAIL'} (${scored.steps} steps)`);
      detail.push({ case: c.id, run: k + 1, ...scored, trace: result?.trace ?? [], summary: result?.finish?.summary ?? null });
    }
    const passes = outcomes.filter((o) => o.pass).length;
    perCase[c.id] = {
      passes,
      runs,
      passRate: passes / runs,
      allRunsPass: passes === runs,
      avgSteps: +(outcomes.reduce((s, o) => s + o.steps, 0) / runs).toFixed(1),
      overBudget: outcomes.filter((o) => !o.withinBudget).length,
      toolErrors: outcomes.reduce((s, o) => s + o.toolErrors, 0),
      protectedViolations: outcomes.filter((o) => !o.protectedOk).length,
      budget: c.maxSteps,
    };
  }

  const ids = Object.keys(perCase);
  const meanPass = ids.reduce((s, id) => s + perCase[id].passRate, 0) / ids.length;
  const allPass = ids.filter((id) => perCase[id].allRunsPass).length / ids.length;

  console.log(`\nModel: ${modelName}   runs per case: ${runs}   cases: ${ids.length}\n`);
  console.log('case'.padEnd(36) + 'pass'.padEnd(8) + 'steps'.padEnd(12) + 'tool err'.padEnd(10) + 'protected');
  for (const id of ids) {
    const p = perCase[id];
    console.log(
      id.padEnd(36) +
        `${p.passes}/${p.runs}`.padEnd(8) +
        `${p.avgSteps}/${p.budget}`.padEnd(12) +
        String(p.toolErrors).padEnd(10) +
        (p.protectedViolations ? `VIOLATED x${p.protectedViolations}` : 'ok')
    );
  }
  console.log(`\nMean pass rate: ${(meanPass * 100).toFixed(0)}%`);
  console.log(`Cases passing on every run (reliability): ${(allPass * 100).toFixed(0)}%`);

  const failures = detail.filter((d) => !d.pass);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f.case} (run ${f.run}): ${f.reasons.join('; ')}`);
  }

  const outDir = path.join(here, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = { model: modelName, runs, when: new Date().toISOString(), meanPass, allPass, perCase, detail };
  const file = path.join(outDir, `run-${modelName}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nFull traces saved to ${path.relative(here, file)}`);

  const crashed = detail.filter((d) => d.crashed).length;
  if (crashed) console.log(`\nWARNING: ${crashed} run(s) crashed (API or network error), not scored by the model. Results are incomplete.`);

  if (arg('save-baseline', false) && crashed) {
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(2); });
}
