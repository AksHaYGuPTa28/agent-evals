// Table type and the operations the agent is allowed to use.
// Every operation is deterministic and either fully applies or throws without changing the table.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export const isMissing = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function createTable(columns, rows) {
  return { columns: [...columns], rows: rows.map((r) => ({ ...r })) };
}
export const cloneTable = (t) => createTable(t.columns, t.rows);

function needColumn(t, c) {
  if (!t.columns.includes(c)) {
    throw new Error(`Column "${c}" does not exist. Columns are: ${t.columns.join(', ')}`);
  }
}

const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parseDate(value, fmt) {
  const v = String(value).trim();
  let y, m, d, mm;
  if (fmt === 'DD/MM/YYYY' || fmt === 'MM/DD/YYYY') {
    mm = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!mm) return null;
    y = +mm[3];
    if (fmt === 'DD/MM/YYYY') { d = +mm[1]; m = +mm[2]; } else { m = +mm[1]; d = +mm[2]; }
  } else if (fmt === 'YYYY-MM-DD') {
    mm = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!mm) return null;
    y = +mm[1]; m = +mm[2]; d = +mm[3];
  } else if (fmt === 'D Mon YYYY') {
    mm = v.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
    if (!mm) return null;
    d = +mm[1]; m = MONTHS[mm[2].toLowerCase()]; y = +mm[3];
    if (!m) return null;
  } else {
    throw new Error(`Unknown input_format "${fmt}". Use one of: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, D Mon YYYY`);
  }
  if (m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Read a number from text. decimal "." means commas are thousands separators; decimal "," means dots are.
function readNumber(text, decimal) {
  let s = text.trim();
  s = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  s = s.replace(/[^0-9.\-]/g, '');
  if (s === '' || !/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export const OPERATIONS = {
  trim_whitespace: {
    description: 'Remove leading and trailing whitespace from every text value in one column.',
    input_schema: { type: 'object', properties: { column: { type: 'string' } }, required: ['column'] },
    run(t, { column }) {
      needColumn(t, column);
      let changed = 0;
      for (const r of t.rows) {
        if (typeof r[column] === 'string' && r[column] !== r[column].trim()) { r[column] = r[column].trim(); changed++; }
      }
      return `Trimmed ${changed} value(s) in "${column}".`;
    },
  },
  change_case: {
    description: 'Change the letter case of every text value in one column. mode is upper, lower or title.',
    input_schema: {
      type: 'object',
      properties: { column: { type: 'string' }, mode: { type: 'string', enum: ['upper', 'lower', 'title'] } },
      required: ['column', 'mode'],
    },
    run(t, { column, mode }) {
      needColumn(t, column);
      const fn = { upper: (s) => s.toUpperCase(), lower: (s) => s.toLowerCase(), title: titleCase }[mode];
      if (!fn) throw new Error(`Unknown mode "${mode}"`);
      let changed = 0;
      for (const r of t.rows) {
        if (typeof r[column] === 'string') { const n = fn(r[column]); if (n !== r[column]) changed++; r[column] = n; }
      }
      return `Changed case of ${changed} value(s) in "${column}" to ${mode}.`;
    },
  },
  parse_dates: {
    description:
      'Convert a column of date strings to ISO YYYY-MM-DD. Say which format the values use with input_format, ' +
      'or give input_formats (a list tried in order, for a column that mixes formats). ' +
      'Formats: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, "D Mon YYYY" (for example "3 Nov 2026"). ' +
      'on_invalid is "error" (default: if any value does not match, nothing is changed and the bad values are listed) ' +
      'or "null" (values that are not real dates become null). Empty values are left as they are.',
    input_schema: {
      type: 'object',
      properties: {
        column: { type: 'string' },
        input_format: { type: 'string', enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D Mon YYYY'] },
        input_formats: { type: 'array', items: { type: 'string', enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'D Mon YYYY'] } },
        on_invalid: { type: 'string', enum: ['error', 'null'] },
      },
      required: ['column'],
    },
    run(t, { column, input_format, input_formats, on_invalid = 'error' }) {
      needColumn(t, column);
      const formats = input_formats?.length ? input_formats : input_format ? [input_format] : null;
      if (!formats) throw new Error('Give input_format or input_formats');
      const out = [];
      const bad = [];
      for (const r of t.rows) {
        if (isMissing(r[column])) { out.push(r[column]); continue; }
        let iso = null;
        for (const f of formats) { iso = parseDate(r[column], f); if (iso !== null) break; }
        if (iso === null) { bad.push(r[column]); out.push(null); } else out.push(iso);
      }
      if (bad.length && on_invalid !== 'null') {
        throw new Error(`These values do not match ${formats.join(' or ')}: ${JSON.stringify(bad)}. Nothing was changed.`);
      }
      t.rows.forEach((r, i) => { r[column] = out[i]; });
      return `Converted "${column}" to YYYY-MM-DD.` + (bad.length ? ` ${bad.length} value(s) were not valid dates and became null: ${JSON.stringify(bad)}.` : '');
    },
  },
  parse_number: {
    description:
      'Convert a column of text like "12,500", "9,800.5" or "1,200 kg" to numbers by removing thousands separators and any unit text. ' +
      'This does NOT convert units: "9.8 t" becomes 9.8. Use parse_quantity when units differ. ' +
      'decimal is "." (default; commas are thousands separators) or "," (European: dots are thousands separators, comma is the decimal mark). ' +
      'Empty values become null. If any value cannot be read, nothing is changed.',
    input_schema: { type: 'object', properties: { column: { type: 'string' }, decimal: { type: 'string', enum: ['.', ','] } }, required: ['column'] },
    run(t, { column, decimal = '.' }) {
      needColumn(t, column);
      const out = [];
      const bad = [];
      for (const r of t.rows) {
        const v = r[column];
        if (isMissing(v)) { out.push(null); continue; }
        if (typeof v === 'number') { out.push(v); continue; }
        const n = readNumber(String(v), decimal);
        if (n === null) bad.push(v); else out.push(n);
      }
      if (bad.length) throw new Error(`Cannot read these as numbers: ${JSON.stringify(bad)}. Nothing was changed.`);
      t.rows.forEach((r, i) => { r[column] = out[i]; });
      return `Converted "${column}" to numbers.`;
    },
  },
  parse_quantity: {
    description:
      'Convert text like "12,500 kg" or "9.8 t" to one numeric unit. unit_factors maps each unit suffix to its multiplier into the target unit, ' +
      'for example {"kg": 1, "t": 1000} gives kilograms. Units are matched ignoring case. decimal works as in parse_number. ' +
      'A value with an unknown or missing unit is an error and nothing is changed. Empty values become null.',
    input_schema: {
      type: 'object',
      properties: { column: { type: 'string' }, unit_factors: { type: 'object', additionalProperties: { type: 'number' } }, decimal: { type: 'string', enum: ['.', ','] } },
      required: ['column', 'unit_factors'],
    },
    run(t, { column, unit_factors, decimal = '.' }) {
      needColumn(t, column);
      const factors = Object.fromEntries(Object.entries(unit_factors).map(([k, v]) => [k.toLowerCase(), v]));
      const out = [];
      const bad = [];
      for (const r of t.rows) {
        const v = r[column];
        if (isMissing(v)) { out.push(null); continue; }
        const m = String(v).trim().match(/^(.*?)\s*([A-Za-z]+)$/);
        const factor = m ? factors[m[2].toLowerCase()] : undefined;
        const n = m ? readNumber(m[1], decimal) : null;
        if (factor === undefined || n === null) bad.push(v); else out.push(Number((n * factor).toPrecision(12)));
      }
      if (bad.length) throw new Error(`Cannot read these with units ${Object.keys(factors).join('/')}: ${JSON.stringify(bad)}. Nothing was changed.`);
      t.rows.forEach((r, i) => { r[column] = out[i]; });
      return `Converted "${column}" to numbers in the target unit.`;
    },
  },
  parse_percent: {
    description:
      'Convert text like "25%" or "12.5 %" to a fraction (0.25, 0.125). Every non-empty value must carry a % sign; ' +
      'a value without one is an error and nothing is changed, because it could already be a fraction. Empty values become null.',
    input_schema: { type: 'object', properties: { column: { type: 'string' } }, required: ['column'] },
    run(t, { column }) {
      needColumn(t, column);
      const out = [];
      const bad = [];
      for (const r of t.rows) {
        const v = r[column];
        if (isMissing(v)) { out.push(null); continue; }
        const m = String(v).trim().match(/^(-?[0-9]+(?:\.[0-9]+)?)\s*%$/);
        if (!m) bad.push(v); else out.push(Number((Number(m[1]) / 100).toPrecision(12)));
      }
      if (bad.length) throw new Error(`These values have no % sign or cannot be read: ${JSON.stringify(bad)}. Nothing was changed.`);
      t.rows.forEach((r, i) => { r[column] = out[i]; });
      return `Converted "${column}" from percent to fractions.`;
    },
  },
  replace_values: {
    description:
      'Replace specific placeholder values in one column (matched ignoring case and surrounding spaces) with a new value, ' +
      'for example turn "N/A" and "-" into null. with may be null.',
    input_schema: {
      type: 'object',
      properties: { column: { type: 'string' }, values: { type: 'array', items: { type: 'string' } }, with: { type: ['string', 'number', 'null'] } },
      required: ['column', 'values', 'with'],
    },
    run(t, { column, values, with: replacement }) {
      needColumn(t, column);
      const targets = new Set(values.map((v) => String(v).trim().toLowerCase()));
      let changed = 0;
      for (const r of t.rows) {
        if (typeof r[column] === 'string' && targets.has(r[column].trim().toLowerCase())) { r[column] = replacement; changed++; }
      }
      return `Replaced ${changed} value(s) in "${column}".`;
    },
  },
  map_values: {
    description:
      'Map the values of one column to new values. rules is a list of {from, to} pairs; "from" is matched ignoring case and surrounding spaces ' +
      'and must be copied exactly as it appears in the data (for example "prem econ" or "Bus."). ' +
      'If any non-empty value has no rule, nothing is changed and the unmapped values are listed, unless keep_unmapped is true.',
    input_schema: {
      type: 'object',
      properties: {
        column: { type: 'string' },
        rules: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
        keep_unmapped: { type: 'boolean' },
      },
      required: ['column', 'rules'],
    },
    run(t, { column, rules, keep_unmapped = false }) {
      needColumn(t, column);
      if (!Array.isArray(rules) || rules.length === 0) {
        const distinct = [...new Set(t.rows.map((r) => r[column]).filter((v) => !isMissing(v)))];
        throw new Error(`rules is empty. Provide one {from, to} pair for every value you want to change. The column contains these distinct values: ${JSON.stringify(distinct)}. Nothing was changed.`);
      }
      const map = Object.fromEntries(rules.map((r) => [String(r.from).trim().toLowerCase(), r.to]));
      const unmapped = new Set();
      const out = t.rows.map((r) => {
        const v = r[column];
        if (isMissing(v)) return v;
        const hit = map[String(v).trim().toLowerCase()];
        if (hit === undefined) { unmapped.add(v); return v; }
        return hit;
      });
      if (unmapped.size && !keep_unmapped) {
        const missing = [...unmapped];
        const template = missing.map((v) => ({ from: String(v).trim(), to: '<target value>' }));
        throw new Error(
          `No rule for: ${JSON.stringify(missing)}. Add these pairs to rules (copy each "from" character for character): ` +
            `${JSON.stringify(template)}. Nothing was changed.`
        );
      }
      t.rows.forEach((r, i) => { r[column] = out[i]; });
      return `Mapped "${column}".` + (unmapped.size ? ` Left ${unmapped.size} distinct value(s) unmapped.` : '');
    },
  },
  sort_rows: {
    description: 'Sort the rows by one or more columns, in the order given. direction is asc or desc. The sort is stable and missing values go last.',
    input_schema: {
      type: 'object',
      properties: {
        sort: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column', 'direction'] } },
      },
      required: ['sort'],
    },
    run(t, { sort }) {
      if (!Array.isArray(sort) || sort.length === 0) throw new Error('sort must be a non-empty list');
      sort.forEach((s) => needColumn(t, s.column));
      const indexed = t.rows.map((r, i) => ({ r, i }));
      indexed.sort((a, b) => {
        for (const { column, direction } of sort) {
          const x = a.r[column], y = b.r[column];
          const mx = isMissing(x), my = isMissing(y);
          if (mx !== my) return mx ? 1 : -1;
          if (mx && my) continue;
          if (x < y) return direction === 'asc' ? -1 : 1;
          if (x > y) return direction === 'asc' ? 1 : -1;
        }
        return a.i - b.i;
      });
      t.rows = indexed.map((x) => x.r);
      return `Sorted by ${sort.map((s) => `${s.column} ${s.direction}`).join(', ')}.`;
    },
  },
  drop_duplicates: {
    description: 'Remove rows that repeat the same values in all of the key columns. The first row is kept.',
    input_schema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } }, required: ['keys'] },
    run(t, { keys }) {
      if (!Array.isArray(keys) || keys.length === 0) throw new Error('keys must be a non-empty list of columns');
      keys.forEach((k) => needColumn(t, k));
      const seen = new Set();
      const before = t.rows.length;
      t.rows = t.rows.filter((r) => {
        const k = JSON.stringify(keys.map((c) => r[c]));
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return `Removed ${before - t.rows.length} duplicate row(s). ${t.rows.length} row(s) remain.`;
    },
  },
  fill_nulls: {
    description:
      'Replace missing values (null or empty text) in one column with a value. ' +
      'A value that looks like a number (for example "0") is stored as a number.',
    input_schema: { type: 'object', properties: { column: { type: 'string' }, value: { type: ['string', 'number'] } }, required: ['column', 'value'] },
    run(t, { column, value }) {
      needColumn(t, column);
      const v = typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
      let changed = 0;
      for (const r of t.rows) if (isMissing(r[column])) { r[column] = v; changed++; }
      return `Filled ${changed} missing value(s) in "${column}".`;
    },
  },
  drop_rows_where_missing: {
    description: 'Remove every row where the given column is missing (null or empty text).',
    input_schema: { type: 'object', properties: { column: { type: 'string' } }, required: ['column'] },
    run(t, { column }) {
      needColumn(t, column);
      const before = t.rows.length;
      t.rows = t.rows.filter((r) => !isMissing(r[column]));
      return `Removed ${before - t.rows.length} row(s). ${t.rows.length} remain.`;
    },
  },
  rename_column: {
    description: 'Rename a column.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    run(t, { from, to }) {
      needColumn(t, from);
      if (t.columns.includes(to)) throw new Error(`Column "${to}" already exists`);
      t.columns = t.columns.map((c) => (c === from ? to : c));
      t.rows = t.rows.map((r) => {
        const n = {};
        for (const c of Object.keys(r)) n[c === from ? to : c] = r[c];
        return n;
      });
      return `Renamed "${from}" to "${to}".`;
    },
  },
};

export const READ_ONLY = {
  profile: {
    description: 'Show the table shape: row count, and for each column the number of missing values and up to 6 distinct example values. Use this first.',
    input_schema: { type: 'object', properties: {} },
    run(t) {
      return JSON.stringify({
        rows: t.rows.length,
        columns: t.columns.map((c) => ({
          name: c,
          missing: t.rows.filter((r) => isMissing(r[c])).length,
          examples: [...new Set(t.rows.map((r) => JSON.stringify(r[c])))].slice(0, 6).map((s) => JSON.parse(s)),
        })),
      });
    },
  },
  show_rows: {
    description: 'Show the current rows as JSON (up to limit, default 20). Use it to check your work before finishing.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
    run(t, { limit } = {}) {
      return JSON.stringify(t.rows.slice(0, limit ?? 20));
    },
  },
};

export const FINISH = {
  description:
    'Call this once when you are done. status is "done" if you completed the request, or "cannot_complete" if the request cannot be done with this table (for example a column does not exist). Explain briefly in summary.',
  input_schema: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['done', 'cannot_complete'] }, summary: { type: 'string' } },
    required: ['status', 'summary'],
  },
};

export function toolDefinitions() {
  const defs = [];
  for (const [name, o] of Object.entries(READ_ONLY)) defs.push({ name, description: o.description, input_schema: o.input_schema });
  for (const [name, o] of Object.entries(OPERATIONS)) defs.push({ name, description: o.description, input_schema: o.input_schema });
  defs.push({ name: 'finish', description: FINISH.description, input_schema: FINISH.input_schema });
  return defs;
}
