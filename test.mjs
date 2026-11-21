// Sanity tests for the cases themselves: the obvious naive tool call must NOT produce the expected table.
// If a "trap" case could be passed by the naive call, it is not testing anything.

import assert from 'node:assert/strict';
import { CASES } from './cases/cases.mjs';
import { HARD_CASES } from './cases/hard.mjs';
import { REAL_CASES } from './cases/real.mjs';
import { createTable, OPERATIONS, READ_ONLY } from './src/table.mjs';

const all = Object.fromEntries([...CASES, ...HARD_CASES, ...REAL_CASES].map((c) => [c.id, c]));
const BS = String.fromCharCode(92);
const tableOf = (id) => createTable(all[id].columns, all[id].rows);
const matches = (id, t) => JSON.stringify(t.rows) === JSON.stringify(all[id].expected);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

test('mixed_units_to_kg: plain parse_number strips the unit and is wrong', () => {
  const t = tableOf('mixed_units_to_kg');
  OPERATIONS.parse_number.run(t, { column: 'fuel' });
  assert.equal(t.rows[1].fuel, 9.8);
  assert.ok(!matches('mixed_units_to_kg', t));
});

test('percent_not_fraction: parse_number gives 25, not 0.25', () => {
  const t = tableOf('percent_not_fraction');
  OPERATIONS.replace_values.run(t, { column: 'discount', values: ['n/a'], with: null });
  OPERATIONS.parse_number.run(t, { column: 'discount' });
  assert.equal(t.rows[0].discount, 25);
  assert.ok(!matches('percent_not_fraction', t));
});

test('european_numbers: default decimal "." reads 1.234,5 wrongly', () => {
  const t = tableOf('european_numbers_and_placeholders');
  OPERATIONS.replace_values.run(t, { column: 'fuel_kg', values: ['N/A', '-'], with: null });
  OPERATIONS.parse_number.run(t, { column: 'fuel_kg' });
  assert.ok(!matches('european_numbers_and_placeholders', t));
});

test('european_numbers: parse_number alone refuses the N/A placeholders', () => {
  const t = tableOf('european_numbers_and_placeholders');
  assert.throws(() => OPERATIONS.parse_number.run(t, { column: 'fuel_kg', decimal: ',' }), /Cannot read/);
});

test('mixed_date_formats: a single format refuses and changes nothing', () => {
  const t = tableOf('mixed_date_formats');
  assert.throws(() => OPERATIONS.parse_dates.run(t, { column: 'date', input_format: 'DD/MM/YYYY' }), /Nothing was changed/);
  assert.deepEqual(t.rows, all.mixed_date_formats.rows);
});

test('invalid_dates: default on_invalid refuses and changes nothing', () => {
  const t = tableOf('invalid_dates_become_null');
  assert.throws(() => OPERATIONS.parse_dates.run(t, { column: 'date', input_format: 'DD/MM/YYYY' }), /Nothing was changed/);
  assert.deepEqual(t.rows, all.invalid_dates_become_null.rows);
});

test('messy_category_mapping: profile shows fewer variants than exist, and a partial mapping errors', () => {
  const t = tableOf('messy_category_mapping');
  const profile = JSON.parse(READ_ONLY.profile.run(t));
  assert.equal(profile.columns.find((c) => c.name === 'cabin').examples.length, 6);
  const partial = [['econ', 'ECONOMY'], ['economy', 'ECONOMY'], ['y', 'ECONOMY'], ['eco', 'ECONOMY'], ['prem econ', 'PREMIUM']].map(([from, to]) => ({ from, to }));
  assert.throws(() => OPERATIONS.map_values.run(t, { column: 'cabin', rules: partial }), /No rule for/);
  assert.throws(() => OPERATIONS.map_values.run(t, { column: 'cabin', rules: [] }), /rules is empty/);
});

test('latest_record_wins: dedupe without sorting keeps the stale row', () => {
  const t = tableOf('latest_record_wins_then_sort');
  OPERATIONS.drop_duplicates.run(t, { keys: ['flight', 'date'] });
  assert.ok(!matches('latest_record_wins_then_sort', t));
});

test('order_matters: dedupe before cleaning leaves duplicates', () => {
  const t = tableOf('order_matters_dedupe_after_clean');
  OPERATIONS.drop_duplicates.run(t, { keys: ['airline', 'flight', 'date'] });
  assert.equal(t.rows.length, 4);
});

test('missing_key_rows: dedupe without dropping empty keys keeps invalid rows', () => {
  const t = tableOf('missing_key_rows_then_dedupe');
  OPERATIONS.trim_whitespace.run(t, { column: 'flight' });
  OPERATIONS.change_case.run(t, { column: 'flight', mode: 'upper' });
  OPERATIONS.drop_duplicates.run(t, { keys: ['flight', 'date'] });
  assert.ok(!matches('missing_key_rows_then_dedupe', t));
});

test('prompt_injection: a correct run does not touch notes', () => {
  const t = tableOf('prompt_injection_in_cell');
  OPERATIONS.change_case.run(t, { column: 'airline', mode: 'upper' });
  assert.ok(matches('prompt_injection_in_cell', t));
});

test('real_airports_drop_rows: dropping before converting the backslash-N marker keeps every row', () => {
  const t = tableOf('real_airports_drop_rows_without_iata');
  OPERATIONS.drop_rows_where_missing.run(t, { column: 'iata' });
  assert.equal(t.rows.length, all.real_airports_drop_rows_without_iata.rows.length);
  assert.ok(!matches('real_airports_drop_rows_without_iata', t));
});

test('real_airlines_missing_markers: handling only some markers misses N/A and empty strings', () => {
  const t = tableOf('real_airlines_missing_markers');
  for (const column of ['alias', 'iata', 'icao', 'callsign', 'country']) OPERATIONS.replace_values.run(t, { column, values: [BS + 'N', '-'], with: null });
  assert.ok(!matches('real_airlines_missing_markers', t));
});

test('real_airports_feet_to_metres: forgetting the rename leaves the wrong column name', () => {
  const t = tableOf('real_airports_feet_to_metres');
  OPERATIONS.multiply_column.run(t, { column: 'altitude_ft', factor: 0.3048, decimals: 1 });
  assert.ok(t.columns.includes('altitude_ft') && !t.columns.includes('altitude_m'));
});

test('multiply_column refuses non-numeric text and changes nothing', () => {
  const t = createTable(['x'], [{ x: '5' }, { x: 'abc' }]);
  assert.throws(() => OPERATIONS.multiply_column.run(t, { column: 'x', factor: 2 }), /not numeric/);
  assert.deepEqual(t.rows, [{ x: '5' }, { x: 'abc' }]);
});

console.log(`\n${passed} sanity tests passed`);
