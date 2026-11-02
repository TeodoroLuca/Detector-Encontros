import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { detectGroup } from './algorithm.js';
import { DatasetError, ResourceLimitError, errorMessage, sameRecord } from './parser.js';
import { scanDataset, orderedDatasetRows } from './grouping.js';
import type { MetricasProcessamento, Monitorado, ModoProcessamento, PoliticaEncontroGenerico, ResultadoProcessamento } from './types.js';

export interface ProcessFileOptions {
  mode: ModoProcessamento;
  genericPolicy: PoliticaEncontroGenerico;
  signal?: AbortSignal;
  maxRecords?: number;
  maxOutputBytes?: number;
  sortBatchRecords?: number;
}

interface CliOptions extends ProcessFileOptions { input: string; output: string; help: false }

function usage(): string {
  return `Uso:\n  npm run process -- --input datasets --output outputs [--generic-policy all|tornozeleiras] [--mode unordered|sorted]\n  npm run process -- --input dados/arquivo.txt --output outputs/arquivo.json\n\nPadrões: --generic-policy all; --mode unordered (aceita timestamps fora de ordem).`;
}

function optionsFromArgs(args: string[]): CliOptions | { help: true } {
  const opts: CliOptions = { input: '', output: 'outputs', genericPolicy: 'all', mode: 'unordered', help: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === undefined || !['--input', '--output', '--generic-policy', '--mode'].includes(flag)) throw new Error(`Parâmetro desconhecido: ${flag}`);
    const val = args[++i];
    if (val === undefined || val.startsWith('--')) throw new Error(`Valor ausente em ${flag}`);
    if (flag === '--input') opts.input = val;
    if (flag === '--output') opts.output = val;
    if (flag === '--generic-policy') {
      if (val !== 'all' && val !== 'tornozeleiras') throw new Error('Política inválida.');
      opts.genericPolicy = val;
    }
    if (flag === '--mode') {
      if (val !== 'unordered' && val !== 'sorted') throw new Error('Modo inválido.');
      opts.mode = val;
    }
  }
  if (!opts.input) throw new Error('Informe --input.\n' + usage());
  return opts;
}

function pushUnique(group: Map<number, Monitorado>, record: Monitorado, lineNumber: number): boolean {
  const existing = group.get(record.id);
  if (existing) {
    if (!sameRecord(existing, record)) throw new DatasetError(`Linha ${lineNumber}: Posições contraditórias do ID ${record.id} em ${record.timestamp}.`);
    return false;
  }
  group.set(record.id, record);
  return true;
}

async function addText(stream: fs.WriteStream, content: string): Promise<void> {
  if (stream.errored) throw stream.errored;
  if (stream.destroyed) throw new Error('Escrita interrompida.');
  if (!stream.write(content)) await once(stream, 'drain');
}

export async function processFile(input: string, output: string, opts: ProcessFileOptions): Promise<ResultadoProcessamento> {
  if (opts.mode !== 'unordered' && opts.mode !== 'sorted') throw new DatasetError('Modo de processamento inválido.');
  if (opts.genericPolicy !== 'all' && opts.genericPolicy !== 'tornozeleiras') throw new DatasetError('Política de encontros genéricos inválida.');
  for (const value of [opts.maxRecords, opts.maxOutputBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Limite de recursos inválido.');
  }
  if (path.resolve(input) === path.resolve(output)) throw new Error('Entrada e saída devem ser arquivos diferentes.');
  const began = performance.now();
  let count = 0;
  let duplicated = 0;
  let encounters = 0;
  const byType = { generico: 0, faccao: 0, protetiva: 0 };
  let timestamps = 0;
  let first = true;
  let writer: fs.WriteStream | undefined;
  let wroteArray = false;
  let outputBytes = 0;
  const performanceMetrics: MetricasProcessamento = { potentialPairs: 0, candidatePairs: 0, haversineCalculations: 0, directGroups: 0, spatialGroups: 0 };
  let currentTimestamp: string | null = null;
  let currentGroup = new Map<number, Monitorado>();
  // Nome exclusivo evita que processamentos concorrentes compartilhem um arquivo parcial.
  const tmpOutput = `${output}.${randomUUID()}.partial`;
  let completion: Promise<void> | undefined;

  async function write(content: string): Promise<void> {
    opts.signal?.throwIfAborted();
    outputBytes += Buffer.byteLength(content);
    if (opts.maxOutputBytes !== undefined && outputBytes > opts.maxOutputBytes) throw new ResourceLimitError('O resultado excede o limite de tamanho permitido.');
    if (!writer) throw new Error('Arquivo de saída não foi aberto.');
    await addText(writer, content);
  }

  async function flushGroup(group: Map<number, Monitorado>): Promise<void> {
    opts.signal?.throwIfAborted();
    timestamps++;
    for (const e of detectGroup(group.values(), { genericPolicy: opts.genericPolicy, metrics: performanceMetrics })) {
      await write(`${first ? '' : ',\n'}${JSON.stringify(e)}`);
      first = false;
      encounters++;
      byType[e.tipo]++;
    }
  }

  try {
    opts.signal?.throwIfAborted();
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    writer = fs.createWriteStream(tmpOutput, { encoding: 'utf8', flags: 'wx', ...(opts.signal ? { signal: opts.signal } : {}) });
    completion = finished(writer, { cleanup: true });
    // O erro é aguardado na conclusão, inclusive se ocorrer durante leitura/parsing.
    void completion.catch(() => {});
    await once(writer, 'open');
    await write('[\n');
    wroteArray = true;
    // Prove ordering without retaining rows, then use one timestamp at a time.
    const scan = await scanDataset(input, { ...opts, requireSorted: opts.mode === 'sorted' });
    for await (const { record: row, lineNumber: nLine } of orderedDatasetRows(input, scan.chronological, opts)) {
      count++;
      if (opts.maxRecords !== undefined && count > opts.maxRecords) throw new ResourceLimitError(`Linha ${nLine}: quantidade de registros excede o limite permitido.`);
      if (currentTimestamp !== null && row.timestamp !== currentTimestamp) {
        await flushGroup(currentGroup);
        currentGroup = new Map();
      }
      currentTimestamp = row.timestamp;
      if (!pushUnique(currentGroup, row, nLine)) duplicated++;
    }
    if (!count) throw new DatasetError('Nenhum registro válido encontrado no dataset.');
    if (count !== scan.count) throw new DatasetError('O dataset foi modificado durante o processamento. Tente novamente com um arquivo estável.');
    if (currentTimestamp !== null) await flushGroup(currentGroup);
    await write('\n]\n');
    writer.end();
    await completion;
    opts.signal?.throwIfAborted();
    await fs.promises.rename(tmpOutput, output);
  } catch (error) {
    writer?.destroy();
    if (completion) await completion.catch(() => {});
    await fs.promises.rm(tmpOutput, { force: true });
    if (error instanceof DatasetError) throw new DatasetError(`${path.basename(input)}: ${error.message}`, { cause: error });
    throw error;
  }
  const durationMs = performance.now() - began;
  return { count, duplicated, encounters, byType, timestamps, durationMs, output, wroteArray, performanceMetrics };
}

export async function runCli(args = process.argv.slice(2), signal?: AbortSignal): Promise<void> {
  const opts = optionsFromArgs(args);
  if (opts.help) { console.log(usage()); return; }
  const input = path.resolve(opts.input);
  const output = path.resolve(opts.output);
  const stat = await fs.promises.stat(input);
  const isDirectory = stat.isDirectory();
  const inputs = isDirectory
    ? (await fs.promises.readdir(input)).filter(name => name.toLowerCase().endsWith('.txt')).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })).map(name => path.join(input, name))
    : [input];
  if (inputs.length === 0) throw new Error(`Nenhum arquivo .txt em ${input}`);
  const outputIsJson = !isDirectory && output.toLowerCase().endsWith('.json');
  for (const file of inputs) {
    const destination = outputIsJson ? output : path.join(output, `${path.parse(file).name}.json`);
    const result = await processFile(file, destination, { ...opts, ...(signal ? { signal } : {}) });
    console.log(`${path.basename(file)} -> ${destination} | linhas=${result.count}, duplicadas=${result.duplicated}, timestamps=${result.timestamps}, encontros=${result.encounters}, ms=${result.durationMs.toFixed(2)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error('Processamento interrompido.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  runCli(undefined, controller.signal).catch((error: unknown) => {
    console.error('ERRO:', errorMessage(error));
    process.exitCode = controller.signal.aborted ? 130 : 1;
  }).finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  });
}
