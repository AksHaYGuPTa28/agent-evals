// Minimal CSV reader and writer (RFC 4180 style: quoted fields, doubled quotes, CRLF or LF). No dependencies.
// All values are read as strings. An empty field is the empty string.

export function parseCsv(text, { maxRows = 500, maxCols = 40 } = {}) {
  const src = text.replace(/^﻿/, '');
  const records = [];
  let row = [], field = '', inQuotes = false, i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); records.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (inQuotes) throw new Error('The CSV has an unclosed quote.');
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  while (records.length && records[records.length - 1].every((c) => c === '')) records.pop();
  if (records.length === 0) throw new Error('The CSV is empty.');

  const columns = records[0].map((c) => c.trim());
  if (columns.some((c) => c === '')) throw new Error('Every column needs a header name.');
  if (new Set(columns).size !== columns.length) throw new Error('Column names must be unique.');
  if (columns.length > maxCols) throw new Error(`Too many columns (max ${maxCols}).`);
  const body = records.slice(1);
  if (body.length > maxRows) throw new Error(`Too many rows (max ${maxRows}).`);
  const rows = body.map((rec, n) => {
    if (rec.length > columns.length) throw new Error(`Row ${n + 2} has more fields than the header.`);
    const r = {};
    columns.forEach((c, k) => { r[c] = rec[k] ?? ''; });
    return r;
  });
  return { columns, rows };
}

// Spreadsheet programs run cells that start with = + @ as formulas. When writing a file for a person to open,
// neutralise those (but leave real numbers like -5 alone).
const looksDangerous = (s) => /^[=+@\t\r]/.test(s) || (/^-/.test(s) && Number.isNaN(Number(s)));

export function toCsv(columns, rows, { spreadsheetSafe = true } = {}) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (spreadsheetSafe && looksDangerous(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}
