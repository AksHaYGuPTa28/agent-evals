// Cases built from REAL public data: a small extract of OpenFlights (see data/README.md for source and license).
// Real data is messier than anything we would invent: "missing" is written as \N, "-", "N/A" or an empty string, sometimes in the same column.
// Expected results are computed here in plain JavaScript from the raw rows, independently of the agent's tools.

import fs from 'node:fs';

const sample = JSON.parse(fs.readFileSync(new URL('../data/openflights-sample.json', import.meta.url), 'utf8'));
const BS = String.fromCharCode(92); // a backslash, written this way so no tool or editor can mangle the \N marker
const NULL_MARK = BS + 'N';

const A = sample.airlines;
const P = sample.airports;
const done = { status: 'done', summary: 'Completed.' };
const MISSING = new Set([NULL_MARK.toLowerCase(), '-', 'n/a', '']);
const isMarker = (v) => MISSING.has(String(v).trim().toLowerCase());

const MARKER_COLS = ['alias', 'iata', 'icao', 'callsign', 'country'];

export const REAL_CASES = [
  {
    id: 'real_airlines_missing_markers',
    why: `Real data: "missing" is written as ${NULL_MARK}, "-", "N/A" and "" in different columns. Five columns need the same cleanup.`,
    columns: A.columns,
    rows: A.rows,
    task: `In the alias, iata, icao, callsign and country columns, treat ${NULL_MARK}, -, N/A and empty values as missing and make them null. Do not change any other column.`,
    expected: A.rows.map((r) => Object.fromEntries(A.columns.map((c) => [c, MARKER_COLS.includes(c) && isMarker(r[c]) ? null : r[c]]))),
    expectedStatus: 'done',
    protected: ['id', 'name', 'active'],
    maxSteps: 10,
    solution: {
      ops: MARKER_COLS.map((column) => ({ name: 'replace_values', input: { column, values: [NULL_MARK, '-', 'N/A', ''], with: null } })),
      finish: done,
    },
  },
  {
    id: 'real_airlines_active_flags',
    why: 'Real column with Y/N flags. A small, exact change in a table with many look-alike values that must stay untouched.',
    columns: A.columns,
    rows: A.rows,
    task: 'In the active column, change Y to yes and N to no. Do not change anything else.',
    expected: A.rows.map((r) => ({ ...r, active: r.active === 'Y' ? 'yes' : 'no' })),
    expectedStatus: 'done',
    protected: ['id', 'name', 'iata', 'country'],
    maxSteps: 7,
    solution: { ops: [{ name: 'map_values', input: { column: 'active', rules: [{ from: 'Y', to: 'yes' }, { from: 'N', to: 'no' }] } }], finish: done },
  },
  {
    id: 'real_airports_feet_to_metres',
    why: 'Unit conversion on a real column that arrives as text, with a rename. Rounding is part of the spec, so a wrong factor or decimals shows up.',
    columns: P.columns,
    expectedColumns: P.columns.map((c) => (c === 'altitude_ft' ? 'altitude_m' : c)),
    rows: P.rows,
    task: 'Convert altitude_ft to metres (1 ft = 0.3048 m), rounded to 1 decimal place, and rename the column to altitude_m.',
    expected: P.rows.map((r) => {
      const { altitude_ft, ...rest } = r;
      const out = {};
      for (const c of P.columns) out[c === 'altitude_ft' ? 'altitude_m' : c] = c === 'altitude_ft' ? Number((Number(altitude_ft) * 0.3048).toFixed(1)) : rest[c];
      return out;
    }),
    expectedStatus: 'done',
    protected: ['id', 'name', 'iata'],
    maxSteps: 8,
    solution: {
      ops: [
        { name: 'multiply_column', input: { column: 'altitude_ft', factor: 0.3048, decimals: 1 } },
        { name: 'rename_column', input: { from: 'altitude_ft', to: 'altitude_m' } },
      ],
      finish: done,
    },
  },
  {
    id: 'real_airports_drop_rows_without_iata',
    why: `Order matters on real data: ${NULL_MARK} is not "missing" to a tool until it is converted, so dropping rows first keeps every bad row.`,
    columns: P.columns,
    rows: P.rows,
    task: `In the iata column, treat ${NULL_MARK} as missing. Then remove every airport that has no iata code. Do not change any other column.`,
    expected: P.rows.filter((r) => r.iata !== NULL_MARK),
    expectedStatus: 'done',
    protected: ['id', 'name'],
    maxSteps: 8,
    solution: {
      ops: [
        { name: 'replace_values', input: { column: 'iata', values: [NULL_MARK], with: null } },
        { name: 'drop_rows_where_missing', input: { column: 'iata' } },
      ],
      finish: done,
    },
  },
];
