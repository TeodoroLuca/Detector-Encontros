import fs from 'node:fs';
import { createInterface } from 'node:readline';
import type { Monitorado } from './types.js';

const HEADER = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class DatasetError extends Error {
  readonly code = 'INVALID_DATASET';
  readonly status = 400;
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'DatasetError'; }
}

export class ResourceLimitError extends Error {
  readonly code = 'RESOURCE_LIMIT';
  readonly status = 413;
  constructor(message: string) { super(message); this.name = 'ResourceLimitError'; }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Erro desconhecido.';
}

function unquote(value: string, context: string): string {
  const s = value.trim();
  if (!s.includes('"')) return s;
  const match = /^"((?:[^"]|"")*)"$/.exec(s);
  if (!match || match[1] === undefined) throw new DatasetError(`${context}: aspas malformadas`);
  return match[1].replace(/""/g, '"').trim();
}

function columns(line: string, context: string): string[] {
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (line[i] === ';' && !quoted) {
      values.push(line.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) throw new DatasetError(`${context}: aspas malformadas`);
  values.push(line.slice(start));
  return values;
}

function integerId(raw: string, context: string): number {
  const val = unquote(raw, context);
  if (!/^\d+$/.test(val)) throw new DatasetError(`${context}: ID inválido (${JSON.stringify(raw)})`);
  const id = Number(val);
  if (!Number.isSafeInteger(id)) throw new DatasetError(`${context}: ID fora do intervalo seguro`);
  return id;
}

function restrictions(raw: string, context: string): ReadonlySet<number> {
  let s = unquote(raw, context);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1).trim();
  if (!s) return new Set<number>();
  return new Set(s.split(',').map(v => integerId(v, context)));
}

function parseBoolean(raw: string, context: string): boolean {
  const s = unquote(raw, context).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  throw new DatasetError(`${context}: booleano inválido (${JSON.stringify(raw)})`);
}

export function isValidTimestamp(timestamp: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) return false;
  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(5, 7));
  const day = Number(timestamp.slice(8, 10));
  const hour = Number(timestamp.slice(11, 13));
  const minute = Number(timestamp.slice(14, 16));
  const second = Number(timestamp.slice(17, 19));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && maxDay !== undefined && day >= 1 && day <= maxDay && hour <= 23 && minute <= 59 && second <= 59;
}

export function isHeader(line: string): boolean {
  return line.replace(/^\uFEFF/, '').trim().toLowerCase() === HEADER.toLowerCase();
}

export function parseLine(line: string, lineNumber = 1): Monitorado {
  const context = `Linha ${lineNumber}`;
  const values = columns(line.replace(/^\uFEFF/, ''), context);
  if (values.length !== 7) throw new DatasetError(`${context}: esperadas 7 colunas, recebidas ${values.length}`);
  // O tamanho exato foi validado acima, antes de acessar as sete colunas.
  const id = integerId(values[0]!, context);
  const faccao = unquote(values[1]!, context);
  const timestamp = unquote(values[2]!, context);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
    throw new DatasetError(`${context}: timestamp fora do formato YYYY-MM-DD HH:MM:SS`);
  }
  if (!isValidTimestamp(timestamp)) throw new DatasetError(`${context}: timestamp com data ou horário inválido`);
  const latRaw = unquote(values[3]!, context);
  const lonRaw = unquote(values[4]!, context);
  if (!latRaw || !lonRaw) throw new DatasetError(`${context}: coordenadas ausentes`);
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!DECIMAL.test(latRaw) || !DECIMAL.test(lonRaw) || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new DatasetError(`${context}: coordenadas inválidas`);
  }
  const medidaProtetiva = parseBoolean(values[5]!, context);
  const idsRestricaoMedida = restrictions(values[6]!, context);
  return { id, faccao, timestamp, lat, lon, medidaProtetiva, idsRestricaoMedida };
}

export function sameRecord(a: Monitorado, b: Monitorado): boolean {
  if (a.id !== b.id || a.faccao !== b.faccao || a.timestamp !== b.timestamp ||
      a.lat !== b.lat || a.lon !== b.lon || a.medidaProtetiva !== b.medidaProtetiva ||
      a.idsRestricaoMedida.size !== b.idsRestricaoMedida.size) return false;
  for (const id of a.idsRestricaoMedida) if (!b.idsRestricaoMedida.has(id)) return false;
  return true;
}

/** Propaga erros do arquivo de entrada e sempre encerra os dois recursos. */
export async function* readDatasetLines(file: string, signal?: AbortSignal, maxLineCharacters = 1_048_576): AsyncGenerator<string> {
  signal?.throwIfAborted();
  const input = fs.createReadStream(file, { encoding: 'utf8', ...(signal ? { signal } : {}) });
  let readError: Error | undefined;
  const reader = createInterface({ input, crlfDelay: Infinity });
  const onError = (error: Error): void => { readError = error; reader.close(); };
  input.on('error', onError);
  try {
    for await (const line of reader) {
      signal?.throwIfAborted();
      if (line.length > maxLineCharacters) throw new ResourceLimitError('Uma linha do dataset excede o limite de 1 MiB de caracteres.');
      yield line;
    }
    if (readError) throw readError;
    signal?.throwIfAborted();
  } finally {
    reader.close();
    input.destroy();
    // Mantém o listener de erro até o stream fechar, inclusive em cancelamentos.
  }
}
