import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { DatasetError, ResourceLimitError, errorMessage, isHeader, parseLine, readDatasetLines } from './parser.js';
import type { DatasetInspection, Monitorado } from './types.js';

/** Limits sort working memory, not the number of input records or results. */
const SORT_BATCH_RECORDS = 50_000;
const SORT_BATCH_CHARACTERS = 8 * 1024 * 1024;
const MERGE_FAN_IN = 16;

interface SortHead { value: string; source: number }

/** Min heap for merging at most MERGE_FAN_IN already sorted streams. */
class MinHeap {
  private readonly values: SortHead[] = [];
  push(value: SortHead): void {
    let index = this.values.length;
    this.values.push(value);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const previous = this.values[parent]!;
      if (previous.value <= value.value) break;
      this.values[index] = previous;
      index = parent;
    }
    this.values[index] = value;
  }
  pop(): SortHead | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < this.values.length) {
      let child = index * 2 + 1;
      const right = this.values[child + 1];
      if (right && right.value < this.values[child]!.value) child++;
      const next = this.values[child]!;
      if (last.value <= next.value) break;
      this.values[index] = next;
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

/**
 * Exact external sorting. Only bounded batches are materialized, with at most 16
 * input streams per merge. The generated directory is owned by this instance.
 */
class TextSorter {
  private batch: string[] = [];
  private characters = 0;
  private runs: string[] = [];
  private folder: string | undefined;
  private sequence = 0;
  constructor(private readonly signal: AbortSignal | undefined, private readonly batchRecords: number) {
    if (!Number.isSafeInteger(batchRecords) || batchRecords < 1) throw new Error('Tamanho de lote de ordenação inválido.');
  }
  async add(value: string): Promise<void> {
    this.signal?.throwIfAborted();
    this.batch.push(value);
    this.characters += value.length;
    if (this.batch.length >= this.batchRecords || this.characters >= SORT_BATCH_CHARACTERS) await this.flush();
  }
  private async filename(): Promise<string> {
    this.folder ??= await fs.promises.mkdtemp(path.join(os.tmpdir(), 'detector-sort-'));
    return path.join(this.folder, `${this.sequence++}.txt`);
  }
  private async flush(): Promise<void> {
    if (!this.batch.length) return;
    this.signal?.throwIfAborted();
    this.batch.sort();
    const file = await this.filename();
    await fs.promises.writeFile(file, this.batch.join('\n') + '\n', this.signal ? { signal: this.signal } : {});
    this.runs.push(file);
    this.batch = [];
    this.characters = 0;
  }
  private async *merge(files: readonly string[]): AsyncGenerator<string> {
    // Internal sort keys add 54 characters; the original row was already checked.
    const inputs = files.map(file => readDatasetLines(file, this.signal, 1_048_576 + 54));
    const heap = new MinHeap();
    try {
      for (const [source, input] of inputs.entries()) {
        const next = await input.next();
        if (!next.done) heap.push({ source, value: next.value });
      }
      let head: SortHead | undefined;
      while ((head = heap.pop()) !== undefined) {
        this.signal?.throwIfAborted();
        yield head.value;
        const next = await inputs[head.source]!.next();
        if (!next.done) heap.push({ source: head.source, value: next.value });
      }
    } finally {
      await Promise.all(inputs.map(input => input.return(undefined)));
    }
  }
  private async mergeToFile(files: readonly string[]): Promise<string> {
    const destination = await this.filename();
    const writer = fs.createWriteStream(destination, { flags: 'wx', ...(this.signal ? { signal: this.signal } : {}) });
    const completion = finished(writer, { cleanup: true });
    void completion.catch(() => {});
    let buffer = '';
    try {
      for await (const value of this.merge(files)) {
        buffer += value + '\n';
        if (buffer.length >= 65_536) {
          if (writer.errored) throw writer.errored;
          if (!writer.write(buffer)) await once(writer, 'drain');
          buffer = '';
        }
      }
      writer.end(buffer);
      await completion;
      // Each input belongs to this sorter's exclusive temporary directory.
      await Promise.all(files.map(file => fs.promises.unlink(file)));
      return destination;
    } catch (error) {
      writer.destroy();
      await completion.catch(() => {});
      throw error;
    }
  }
  async *sorted(): AsyncGenerator<string> {
    if (!this.runs.length) {
      this.batch.sort();
      for (const value of this.batch) { this.signal?.throwIfAborted(); yield value; }
      return;
    }
    await this.flush();
    while (this.runs.length > MERGE_FAN_IN) {
      const nextRuns: string[] = [];
      for (let start = 0; start < this.runs.length; start += MERGE_FAN_IN) {
        nextRuns.push(await this.mergeToFile(this.runs.slice(start, start + MERGE_FAN_IN)));
      }
      this.runs = nextRuns;
    }
    yield* this.merge(this.runs);
  }
  async dispose(): Promise<void> {
    this.batch = [];
    if (this.folder) await fs.promises.rm(this.folder, { recursive: true, force: true });
  }
}

export interface DatasetScanOptions {
  signal?: AbortSignal;
  maxRecords?: number;
  collectErrors?: boolean;
  countUniqueIds?: boolean;
  requireSorted?: boolean;
  /** Primarily useful for exercising multiple external merge passes in tests. */
  sortBatchRecords?: number;
}
export interface DatasetScan {
  count: number;
  headerPresent: boolean;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  chronological: boolean;
  uniqueIds: number;
  sample: DatasetInspection['sample'];
  errorCount: number;
  issues: string[];
}

/** First pass validates every row and determines whether direct streaming is safe. */
export async function scanDataset(file: string, options: DatasetScanOptions = {}): Promise<DatasetScan> {
  if (options.maxRecords !== undefined && (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1)) throw new Error('Limite de registros inválido.');
  const result: DatasetScan = { count: 0, headerPresent: false, firstTimestamp: null, lastTimestamp: null,
    chronological: true, uniqueIds: 0, sample: [], errorCount: 0, issues: [] };
  const identifierBatch = new Set<number>();
  const batchSize = options.sortBatchRecords ?? SORT_BATCH_RECORDS;
  const ids = options.countUniqueIds ? new TextSorter(options.signal, batchSize) : undefined;
  let previous: string | null = null;
  let lineNumber = 0;
  async function flushIdentifiers(): Promise<void> {
    if (!ids) return;
    for (const id of identifierBatch) await ids.add(String(id).padStart(16, '0'));
    identifierBatch.clear();
  }
  try {
    for await (const line of readDatasetLines(file, options.signal)) {
      lineNumber++;
      if (!line.trim()) continue;
      if (isHeader(line)) { result.headerPresent = true; continue; }
      let row: Monitorado;
      try { row = parseLine(line, lineNumber); }
      catch (error) {
        if (!options.collectErrors || !(error instanceof DatasetError)) throw error;
        result.errorCount++;
        if (result.issues.length < 12) result.issues.push(errorMessage(error));
        continue;
      }
      result.count++;
      if (options.maxRecords !== undefined && result.count > options.maxRecords) throw new ResourceLimitError(`Linha ${lineNumber}: quantidade de registros excede o limite permitido.`);
      if (previous !== null && row.timestamp < previous) {
        result.chronological = false;
        if (options.requireSorted) throw new DatasetError(`O arquivo não é cronológico (linha ${lineNumber}, ${row.timestamp}). Use --mode unordered.`);
      }
      previous = row.timestamp;
      if (result.firstTimestamp === null || row.timestamp < result.firstTimestamp) result.firstTimestamp = row.timestamp;
      if (result.lastTimestamp === null || row.timestamp > result.lastTimestamp) result.lastTimestamp = row.timestamp;
      if (result.sample.length < 3) result.sample.push({ id: row.id, timestamp: row.timestamp, lat: row.lat, lon: row.lon, medidaProtetiva: row.medidaProtetiva });
      if (ids) {
        identifierBatch.add(row.id);
        if (identifierBatch.size >= batchSize) await flushIdentifiers();
      }
      if (result.count % 4096 === 0) await yieldToIO();
    }
    if (ids) {
      await flushIdentifiers();
      let previousId: string | undefined;
      for await (const id of ids.sorted()) {
        if (id !== previousId) result.uniqueIds++;
        previousId = id;
      }
    }
    return result;
  } finally { await ids?.dispose(); }
}

export interface DatasetRow { record: Monitorado; lineNumber: number }

/** Original line numbers survive sorting, including duplicates split across runs. */
export async function* orderedDatasetRows(file: string, chronological: boolean, options: DatasetScanOptions = {}): AsyncGenerator<DatasetRow> {
  const sorter = chronological ? undefined : new TextSorter(options.signal, options.sortBatchRecords ?? SORT_BATCH_RECORDS);
  let lineNumber = 0;
  let previous: string | null = null;
  try {
    for await (const line of readDatasetLines(file, options.signal)) {
      lineNumber++;
      if (!line.trim() || isHeader(line)) continue;
      let row: Monitorado;
      try { row = parseLine(line, lineNumber); }
      catch (error) {
        if (options.collectErrors && error instanceof DatasetError) continue;
        throw error;
      }
      if (!sorter) {
        // Also check the second pass, so a changed input can never silently mix times.
        if (previous !== null && row.timestamp < previous) throw new DatasetError(`O arquivo não é cronológico (linha ${lineNumber}, ${row.timestamp}). Use --mode unordered.`);
        previous = row.timestamp;
        yield { record: row, lineNumber };
      } else {
        // Fixed-width sort keys cover all safe integer IDs and line numbers.
        await sorter.add(`${row.timestamp}\t${String(row.id).padStart(16, '0')}\t${String(lineNumber).padStart(16, '0')}\t${line}`);
      }
      if (lineNumber % 4096 === 0) await yieldToIO();
    }
    if (sorter) {
      for await (const entry of sorter.sorted()) {
        const originalLine = Number(entry.slice(37, 53));
        const raw = entry.slice(54);
        yield { record: parseLine(raw, originalLine), lineNumber: originalLine };
      }
    }
  } finally { await sorter?.dispose(); }
}
