/** Comparador rigoroso dos campos oficiais; nenhuma tolerância é aplicada às coordenadas. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatasetError, errorMessage, isValidTimestamp } from './parser.js';
import type { ComparacaoGabarito, Encontro } from './types.js';

function usage(): string {
  return 'Uso: npm run validate -- --reference gabarito.json --actual outputs/dataset.json [--tolerance 0.000001]';
}

interface CompareOptions { reference: string; actual: string; tolerance: number; help: false }
function parseArgs(args: string[]): CompareOptions | { help: true } {
  const options: CompareOptions = { reference: '', actual: '', tolerance: 1e-6, help: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') return { help: true };
    if (flag === undefined || !['--reference', '--actual', '--tolerance'].includes(flag)) throw new Error(`Opção desconhecida: ${flag}`);
    const val = args[++i];
    if (val === undefined || val.startsWith('--')) throw new Error(`Valor ausente para ${flag}`);
    if (flag === '--reference') options.reference = val;
    if (flag === '--actual') options.actual = val;
    if (flag === '--tolerance') options.tolerance = Number(val);
  }
  if (!options.reference || !options.actual || !Number.isFinite(options.tolerance) || options.tolerance < 0) throw new Error(usage());
  return options;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validação de dados externos; os tipos estáticos não legitimam JSON não confiável. */
export function assertEncounter(value: unknown): asserts value is Encontro {
  if (!isObject(value)) throw new DatasetError('Cada encontro deve ser um objeto JSON.');
  const required = ['tipo', 'monitoradosEncontro', 'timestamp', 'posicoes', 'distanciaMetros'];
  if (Object.keys(value).length !== required.length || required.some(key => !Object.hasOwn(value, key))) {
    throw new DatasetError('Cada encontro deve conter exclusivamente os cinco campos do formato oficial.');
  }
  if (value.tipo !== 'generico' && value.tipo !== 'faccao' && value.tipo !== 'protetiva') throw new DatasetError('Tipo de encontro inválido.');
  const ids: unknown = value.monitoradosEncontro;
  if (!Array.isArray(ids) || ids.length !== 2 || !isId(ids[0]) || !isId(ids[1]) || ids[0] === ids[1]) {
    throw new DatasetError('monitoradosEncontro deve conter dois IDs inteiros seguros distintos.');
  }
  if (typeof value.timestamp !== 'string' || !isValidTimestamp(value.timestamp)) throw new DatasetError('Timestamp do encontro inválido.');
  if (typeof value.distanciaMetros !== 'number' || !Number.isFinite(value.distanciaMetros) || value.distanciaMetros < 0) {
    throw new DatasetError('Distância do encontro deve ser um número finito não negativo.');
  }
  if (!isObject(value.posicoes) || Object.keys(value.posicoes).length !== 2) throw new DatasetError('Posições devem conter exatamente os dois IDs do encontro.');
  for (const id of ids as [number, number]) {
    const position = value.posicoes[String(id)];
    if (!isObject(position) || Object.keys(position).length !== 2 || typeof position.lat !== 'number' || typeof position.lon !== 'number' ||
      !Number.isFinite(position.lat) || !Number.isFinite(position.lon) || position.lat < -90 || position.lat > 90 || position.lon < -180 || position.lon > 180) {
      throw new DatasetError('Coordenadas do encontro inválidas.');
    }
  }
}

export function pairKey(e: Pick<Encontro, 'monitoradosEncontro' | 'timestamp'>): string {
  const ids = e.monitoradosEncontro;
  if (!Array.isArray(ids) || ids.length !== 2 || !isId(ids[0]) || !isId(ids[1]) || ids[0] === ids[1]) throw new DatasetError('monitoradosEncontro deve conter dois IDs distintos');
  const [a, b] = ids;
  return `${e.timestamp}|${Math.min(a, b)}|${Math.max(a, b)}`;
}

function positionsMatch(a: Encontro, b: Encontro): boolean {
  for (const id of a.monitoradosEncontro) {
    const pa = a.posicoes[id];
    const pb = b.posicoes[id];
    if (!pa || !pb || pa.lat !== pb.lat || pa.lon !== pb.lon) return false;
  }
  return true;
}

export function compare(reference: unknown, actual: unknown, tolerance = 1e-6): ComparacaoGabarito {
  if (!Array.isArray(reference) || !Array.isArray(actual)) throw new DatasetError('Ambos os arquivos devem conter um array JSON.');
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new DatasetError('A tolerância deve ser um número finito não negativo.');
  const referenceRows: unknown[] = reference;
  const actualRows: unknown[] = actual;
  const expected = new Map<string, Encontro>();
  for (const entry of referenceRows) {
    assertEncounter(entry);
    const key = pairKey(entry);
    if (expected.has(key)) throw new DatasetError(`Gabarito com encontro duplicado: ${key}`);
    expected.set(key, entry);
  }
  const observedKeys = new Set<string>();
  const issues: ComparacaoGabarito['issues'] = { missing: [], extra: [], wrongType: [], wrongPosition: [], wrongDistance: [], duplicate: [] };
  let correct = 0;
  for (const entry of actualRows) {
    assertEncounter(entry);
    const key = pairKey(entry);
    if (observedKeys.has(key)) { issues.duplicate.push(key); continue; }
    observedKeys.add(key);
    const expectedEntry = expected.get(key);
    if (!expectedEntry) { issues.extra.push(key); continue; }
    if (expectedEntry.tipo !== entry.tipo) { issues.wrongType.push(`${key}: esperado=${expectedEntry.tipo} obtido=${entry.tipo}`); continue; }
    if (!positionsMatch(expectedEntry, entry)) { issues.wrongPosition.push(key); continue; }
    if (Math.abs(expectedEntry.distanciaMetros - entry.distanciaMetros) > tolerance) {
      issues.wrongDistance.push(`${key}: esperado=${expectedEntry.distanciaMetros} obtido=${entry.distanciaMetros}`);
      continue;
    }
    correct++;
  }
  for (const key of expected.keys()) if (!observedKeys.has(key)) issues.missing.push(key);
  const incorrect = issues.extra.length + issues.wrongType.length + issues.wrongPosition.length + issues.wrongDistance.length + issues.duplicate.length;
  return { expected: referenceRows.length, actual: actualRows.length, correct, incorrect, missing: issues.missing.length, approximateScore: correct - incorrect, issues };
}

export function runCompare(args = process.argv.slice(2)): void {
  const opts = parseArgs(args);
  if (opts.help) { console.log(usage()); return; }
  const reference: unknown = JSON.parse(fs.readFileSync(opts.reference, 'utf8').replace(/^\uFEFF/, ''));
  const actual: unknown = JSON.parse(fs.readFileSync(opts.actual, 'utf8').replace(/^\uFEFF/, ''));
  const result = compare(reference, actual, opts.tolerance);
  console.log(JSON.stringify(result, null, 2));
  if (result.incorrect || result.missing) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCompare(); } catch (error) { console.error('ERRO:', errorMessage(error)); process.exitCode = 1; }
}
