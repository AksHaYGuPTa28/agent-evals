// Build the committed real-data sample from the public OpenFlights files (see data/README.md for source and license).
//   node scripts/build-real-sample.mjs <folder containing airlines.dat and airports.dat>
// The input files are treated as untrusted data: they are only parsed as CSV text, never executed or evaluated.
// Selection is deterministic (first 30 airlines; every 256th airport) so anyone can reproduce the sample.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/csv.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-real-sample.mjs <folder with airlines.dat and airports.dat>'); process.exit(2); }

const AIRLINE_COLS = ['id', 'name', 'alias', 'iata', 'icao', 'callsign', 'country', 'active'];
const AIRPORT_COLS = ['id', 'name', 'city', 'country', 'iata', 'icao', 'lat', 'lon', 'altitude_ft', 'tz_offset', 'dst', 'tz', 'type', 'source'];

function load(file, cols, pick) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean);
  const text = cols.join(',') + '\n' + lines.filter(pick).join('\n');
  return parseCsv(text, { maxRows: 100000, maxCols: 40 });
}

const airlines = load('airlines.dat', AIRLINE_COLS, (_, i) => i < 30);
const airports = load('airports.dat', AIRPORT_COLS, (_, i) => i % 256 === 0);

// Keep only the columns the cases use, to keep prompts small.
const keep = (t, cols) => ({ columns: cols, rows: t.rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))) });
const out = {
  source: 'OpenFlights (https://github.com/jpatokal/openflights), data/airlines.dat and data/airports.dat',
  license: 'Open Database License (ODbL) 1.0; attribution to OpenFlights. This file is a small extract.',
  selection: 'airlines: first 30 rows. airports: every 256th row (0-based index % 256 === 0).',
  airlines: keep(airlines, AIRLINE_COLS),
  airports: keep(airports, ['id', 'name', 'city', 'country', 'iata', 'icao', 'altitude_ft', 'type']),
};
fs.writeFileSync(path.join(here, '..', 'data', 'openflights-sample.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`airlines: ${out.airlines.rows.length} rows, airports: ${out.airports.rows.length} rows`);
