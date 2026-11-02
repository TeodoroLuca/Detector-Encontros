import { DatasetError, errorMessage, sameRecord } from './parser.js';
import { scanDataset, orderedDatasetRows } from './grouping.js';
import type { DatasetInspection, Monitorado } from './types.js';

export interface InspectionOptions { signal?: AbortSignal; maxRecords?: number; sortBatchRecords?: number }

/** Pré-validação usa o mesmo parser e a mesma semântica de duplicação do processamento. */
export async function inspectFile(filePath: string, options: InspectionOptions = {}): Promise<DatasetInspection> {
  const scan = await scanDataset(filePath, { ...options, collectErrors: true, countUniqueIds: true });
  const { count, headerPresent, firstTimestamp, lastTimestamp, uniqueIds, sample, issues } = scan;
  let errorCount = scan.errorCount;
  let duplicated = 0;
  let timestamps = 0;
  let currentTimestamp: string | null = null;
  let group = new Map<number, Monitorado>();
  for await (const { record: row, lineNumber } of orderedDatasetRows(filePath, scan.chronological, { ...options, collectErrors: true })) {
    try {
      if (row.timestamp !== currentTimestamp) {
        currentTimestamp = row.timestamp;
        timestamps++;
        group = new Map();
      }
      const old = group.get(row.id);
      if (old) {
        if (!sameRecord(old, row)) throw new DatasetError(`Linha ${lineNumber}: posições contraditórias para ID ${row.id} em ${row.timestamp}`);
        duplicated++;
      } else group.set(row.id, row);
    } catch (error) {
      if (!(error instanceof DatasetError)) throw error;
      errorCount++;
      if (issues.length < 12) issues.push(errorMessage(error));
    }
  }
  if (!headerPresent) { errorCount++; issues.unshift('Cabeçalho esperado não encontrado; confira as sete colunas do desafio.'); }
  if (!count) { errorCount++; issues.push('Nenhum registro válido encontrado.'); }
  return { valid: errorCount === 0, count, duplicated, timestamps, uniqueIds, firstTimestamp, lastTimestamp, headerPresent, errorCount, issues: issues.slice(0, 12), sample };
}
