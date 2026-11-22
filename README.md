# agent-evals

A small tool-using data-cleaning agent, built from scratch, and the evaluation setup around it: 24 test cases, repeated runs, regression gates, a trace report, and a demo where a person approves the agent's work before anything is kept.

It is a learning and portfolio project, not a product. The point is to show how an agent behaves, how to measure that honestly, and what happens when it fails. No framework, no dependencies: Node 22 and `fetch`.

- **The agent:** you describe a cleaning job in plain English. A model picks tools one at a time (trim, parse dates, convert units, map values, dedupe...). Each tool is all-or-nothing, so a mistake is visible in the trace and cannot half-corrupt the table.
- **The evals:** each case has an exact expected table. A case passes only if the final table and the final status both match. Every case runs several times, because one pass can be luck.
- **The report:** a single HTML page with a leaderboard, a per-case heatmap, and click-through traces for every run.
- **The demo:** upload a CSV, watch the steps stream live, review a before/after diff, then approve or reject. Nothing can be downloaded before approval.

## Results

<!--RESULTS-->
Latest scored result for each case, from the saved runs (a case with any crashed API call is left out, never counted as a failure). Each case runs 3 times. Small models, synthetic and a little real data: read these as signals, not rankings.

| Model | Cases scored | Mean pass rate | Cases passing every run | Tokens per run | Time per run |
|---|---|---|---|---|---|
| gemini-3.1-flash-lite | 24 | 94% | 92% | 16,301 | 96.4s |
| gemini-3.5-flash | 1 | 100% | 100% | 12,715 | 81.1s |
| gemini-3.5-flash-lite | 23 | 96% | 96% | 11,170 | 82.3s |
| gemini-3.5-flash-lite (neutral tools) | 8 | 92% | 88% | 10,064 | 95.2s |

**Cases that did not pass every run**

| Model | Case | Passes |
|---|---|---|
| gemini-3.1-flash-lite | `ambiguous_dates_must_refuse` | 0/3 |
| gemini-3.1-flash-lite | `real_airlines_missing_markers` | 2/3 |
| gemini-3.5-flash-lite | `ambiguous_dates_must_refuse` | 0/3 |
| gemini-3.5-flash-lite (neutral tools) | `mixed_units_to_kg` | 1/3 |

**Tool descriptions with and without hints** (`--neutral-tools`: descriptions say only what each tool does, with no warnings about traps). Same model, same cases:

Over the 8 case(s) scored both ways, runs passed: 24/24 with the normal descriptions, 22/24 with neutral ones.

| Model | Case | Normal descriptions | Neutral descriptions |
|---|---|---|---|
| gemini-3.5-flash-lite | `mixed_units_to_kg` | 3/3 | 1/3 |

Open [`docs/index.html`](docs/index.html) to watch recorded runs step by step, and [`docs/report.html`](docs/report.html) for the heatmap and every trace.
<!--/RESULTS-->

## What the evals found

**1. A fix that did not work, and the real cause.** `messy_category_mapping` (14 spellings of cabin class) failed 0/3: the agent hit its step limit with 30 tool errors. Making the error message list the exact values to copy changed nothing. The traces showed the real cause: the tool took an object with free-form keys, and the model could not write keys containing spaces or dots (`prem_econ`, `Bus_`, then `Bus_z`, `Bus_g`). Changing the tool to take a list of `{from, to}` pairs took it from 0/3 to 3/3. Lesson: read the traces before changing the prompt, and design tool interfaces around what models can write reliably.

**2. A pass does not prove the model saw the trap.** Several traps are easy to pass because the tool description warns about them ("this does NOT convert units"). `--neutral-tools` re-runs the same cases with descriptions that only say what each tool does. On the cases scored both ways, one got clearly worse: `mixed_units_to_kg` went from 3/3 to 1/3. The trace shows why. Without the description, the model guessed what `decimal: ","` meant, turned "12,500 kg" into 12.5, and could not recover: the conversion destroyed the original text and it had no way back, so it looped on `profile` and `show_rows` until the step limit. Fixes (general, not specific to that case): parameter-level descriptions, an `undo` tool, and a rule to undo when a result looks wrong.

**3. Refuse, or proceed and disclose?** When every date could be day-first or month-first, the model picks day-first, converts the column and says so in its summary, instead of stopping to ask. The case expects a refusal, so it failed 0/3 on every run, on two different models. Two attempts to fix it:
- A clearer system prompt rule (use the order the user stated, else look for a date part above 12, else stop and ask). **Did not work**: still 0/3 on both models.
- Moving the check into the tool: `parse_dates` now refuses slash dates unless the user stated the order or a value proves it, and tells the agent to stop and ask. The safe path is the default instead of a rule the model has to remember. **Offline tests pass; the live result is still pending** (see below).

Whether disclose-and-proceed should count as a pass is a product decision. The case stays as it is.

**4. A garbled tool call and a run that just stopped.** On `real_airlines_missing_markers` (real data where "missing" is written as `\N`, `-`, `N/A` and an empty string), one run on `gemini-3.1-flash-lite` produced a tool call whose JSON arguments had its own reasoning text leaked into them, then returned no tool call and the run ended unfinished. Fixes: an empty or malformed reply now gets a reminder and a retry (at most twice, with the API's finish reason recorded in the trace), and `replace_values` gained `include_blank`, so handling empty strings no longer means writing an empty string inside JSON.

## Validation status (read this before trusting the fixes)

The results above come from full runs made **before** these fixes: the date-order guard, the `undo` tool, parameter descriptions, `include_blank` and the empty-reply retry. They are covered by 27 sanity tests and 12 server tests, and a perfect scripted model still scores 100% on all 24 cases. On a live model, only `dates_day_first` has been re-run on the final code (3/3 on `gemini-3.5-flash`). Every other re-run was blocked by the Gemini free tier's **per-day, per-model request cap**, which the runner now detects and stops on cleanly.

**Reported by the author, not verifiable from this repository:** on 22 Nov 2026 the author ran the project separately and reported that everything ran successfully and passed (100%). The result files from that run are not in this repository, so the table above does not include it and it cannot be checked from here. Treat it as a report, not a measurement.

So what this repository itself can show is: the fixes are implemented and tested offline, and one live case confirms no regression there. A checkable live validation is a command away once a quota is available:

```powershell
node eval.mjs --model gemini-3.5-flash-lite --runs 3 --case ambiguous_dates_must_refuse,ambiguous_dates_infer_from_evidence,dates_day_first,mixed_date_formats,invalid_dates_become_null,real_airlines_missing_markers
node eval.mjs --model gemini-3.5-flash-lite --runs 3 --baseline results/baseline.json
npm run site
node scripts/readme-results.mjs
```

## The 24 cases

| Suite | Cases | What it tests |
|---|---|---|
| `basic` (9) | trim and case, day-first dates, dedupe, numbers with units, fill missing, protected column, already-clean input, missing column, ordering | The loop and the tools work; the agent does only what was asked; it refuses an impossible request; it changes nothing when nothing needs changing |
| `hard` (11) | mixed date formats, European numbers and placeholders, kg vs tonnes, percent vs fraction, 14 cabin spellings, latest record then sort, prompt injection in a cell, invalid dates, ambiguous dates (refuse), ambiguous dates with evidence (proceed), missing keys then dedupe | Silent errors that still look like valid data; calibration both ways; resistance to instructions hidden in data |
| `real` (4) | Missing markers (`\N`, `-`, `N/A`, empty) in five columns; Y/N flags; feet to metres with a rename; drop rows without an IATA code (order matters) | The same ideas on real public data, with expected results computed independently of the tools |

`node test.mjs` proves the traps are real: for each trap it applies the obvious naive tool call and checks that the result is wrong or refused. A case that the naive call could pass is not testing anything.

## Run it

```powershell
# No API key needed: scripted models test the harness and the cases themselves
node test.mjs
node test-server.mjs
node eval.mjs --model mock-good --min-pass 1        # a perfect scripted model must score 100%
node eval.mjs --model mock-lazy --min-pass 0.9      # a broken one must trip the gate (exit code 1)

# A real model: copy .env.example to .env and add a key (the file is git-ignored)
node eval.mjs --model gemini-3.5-flash-lite --runs 3 --save-baseline
node eval.mjs --model gemini-3.5-flash-lite --runs 3 --baseline results/baseline.json   # flags regressions
node eval.mjs --model gemini-3.5-flash-lite --runs 3 --neutral-tools --suite hard       # the "no hints" experiment
node eval.mjs --suite real | basic | hard | all   --case <id>   --concurrency 4

node report.mjs                                      # results/report.html
node server.mjs                                      # the demo on http://localhost:3000
```

Prices are never guessed. To see cost, add `pricing.json`: `{ "model-name": { "inputPerM": 0.1, "outputPerM": 0.4 } }` (USD per million tokens, from the provider's pricing page).

## How it is built

| Part | File | Notes |
|---|---|---|
| Agent loop | `src/agent.mjs` | Step limit, every tool error goes back to the model, full trace plus tokens and latency per call |
| Tools | `src/table.mjs` | Deterministic, all-or-nothing, typed errors that say what to do next |
| Model adapters | `src/models.mjs` | Anthropic and Gemini over plain `fetch`, request spacing, retries, per-request timeout; scripted mocks for testing |
| Cases | `cases/*.mjs`, `data/` | Exact expected tables, protected columns, step budgets |
| Runner | `eval.mjs` | Parallel runs, repeats, baseline and regression check, pass-rate gate |
| Report | `report.mjs`, `src/report.template.html` | Latest result per case per model |
| Demo | `server.mjs`, `public/index.html`, `src/csv.mjs` | Streams steps, human approval, hash-only audit log |
| CI | `.github/workflows/ci.yml` | Case tests, server tests, perfect-mock check, and a check that a broken mock trips the gate |

**Scoring.** Pass means the final table matches exactly and the final status is right. Separately reported: steps against a budget, tool errors, and whether a protected column was touched. Bad API keys and rejected requests stop the run at once instead of reporting a fake 0%, and a baseline is never saved from a run with crashed calls.

## Demo safeguards

The demo calls a paid model API, so it has limits: 300 KB request size, 500 rows, 12 agent steps, and a per-visitor hourly run limit (behind a proxy it uses the last `X-Forwarded-For` entry, and only when `TRUST_PROXY=1`). The API key stays on the server. Downloads are spreadsheet-safe (cells starting with `=`, `+` or `@` are neutralised). The audit log records the decision with hashes and counts only, never the data or the task text. See `DEPLOY.md` for deployment, including what is **not** tested yet.

## Honest limits

- Synthetic data plus a small extract of real data. It tests the loop and the tools, not every kind of mess.
- Small models and three runs per case. Read the numbers as signals, not rankings. Different tool descriptions or prompts move them.
- A pass on the normal suite can come from the tool description hinting at the trap (see the neutral-tools comparison).
- Not production: no real users, no monitoring or alerting, no cost controls beyond the demo limits. The container setup is written but not yet built or deployed.

## Next steps

Run more models; add cases from real failures as they happen; move the pending-approval state out of memory so the demo can scale past one instance; add monitoring on a rolling sample of live runs.

## Data and license

Real-data cases use a small extract of [OpenFlights](https://github.com/jpatokal/openflights) (ODbL 1.0), credited in `data/README.md`. Everything else is synthetic.
