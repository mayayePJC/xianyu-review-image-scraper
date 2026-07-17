#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
let tempSequence = 0;

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const records = [];
  let record = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (quoted) throw new Error('Malformed CSV: unclosed quoted field');
  if (cell.length || record.length) {
    record.push(cell);
    records.push(record);
  }
  if (!records.length) return [];

  const headers = records[0].map((header) => String(header || '').trim());
  if (headers.some((header) => !header)) throw new Error('Malformed CSV: empty header');
  return records
    .slice(1)
    .filter((values) => values.some((value) => String(value || '').length))
    .map((values) => {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] ?? '';
      });
      return row;
    });
}

async function readCsvRows(file, expectedHeaders = []) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  return parseCsv(raw).map((row) => {
    if (!expectedHeaders.length) return row;
    const normalized = {};
    for (const header of expectedHeaders) normalized[header] = row[header] ?? '';
    for (const [key, value] of Object.entries(row)) normalized[key] = value;
    return normalized;
  });
}

async function writeCsvRows(file, headers, rows, options = {}) {
  const newline = options.newline || '\r\n';
  const body = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] ?? '')).join(',')),
  ].join(newline);
  const prefix = options.bom === false ? '' : '\uFEFF';
  await writeFileAtomic(file, `${prefix}${body}${newline}`, 'utf8');
}

async function writeFileAtomic(file, data, encoding) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.${tempSequence += 1}.tmp`;
  try {
    await fs.writeFile(tempFile, data, encoding);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tempFile, file);
        break;
      } catch (error) {
        const retryable = error && ['EACCES', 'EBUSY', 'EPERM'].includes(error.code);
        if (!retryable || attempt >= 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } catch (error) {
    await fs.unlink(tempFile).catch(() => {});
    throw error;
  }
}

module.exports = {
  csvEscape,
  parseCsv,
  readCsvRows,
  writeCsvRows,
  writeFileAtomic,
};
