import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processFile } from '../dist/src/cli.js';
import { inspectFile } from '../dist/src/inspection.js';
import { orderedDatasetRows } from '../dist/src/grouping.js';

const header = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
const row = (id, second = 0, lon = 0) => `${id};;2024-01-01 00:00:${String(second).padStart(2, '0')};0;${lon};false;`;
const opts = { mode: 'unordered', genericPolicy: 'all', sortBatchRecords: 2 };
async function workspace(operation) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'detector-large-test-'));
  try { await operation(directory); }
  finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

test('ordenação externa em múltiplas passagens preserva todos os grupos, IDs e duplicatas entre lotes', async () => {
  await workspace(async directory => {
    const rows = Array.from({ length: 40 }, (_, second) => [row(2, second, 0.00001), row(1, second)]).flat();
    const input = path.join(directory, 'input.txt');
    const sorted = path.join(directory, 'sorted.json');
    const shuffled = path.join(directory, 'unordered.json');
    await fs.promises.writeFile(input, [header, ...rows, row(1, 39)].join('\n'));
    const baseline = await processFile(input, sorted, { ...opts, mode: 'sorted' });
    await fs.promises.writeFile(input, [header, ...rows.reverse(), row(1, 39)].join('\n'));
    const result = await processFile(input, shuffled, opts);
    assert.equal(result.count, 81);
    assert.equal(result.duplicated, 1);
    assert.equal(result.timestamps, 40);
    assert.equal(result.encounters, 40);
    assert.deepEqual(result.performanceMetrics, baseline.performanceMetrics);
    assert.equal(await fs.promises.readFile(shuffled, 'utf8'), await fs.promises.readFile(sorted, 'utf8'));
    const inspection = await inspectFile(input, { sortBatchRecords: 2 });
    assert.equal(inspection.valid, true);
    assert.equal(inspection.count, 81);
    assert.equal(inspection.uniqueIds, 2);
    assert.equal(inspection.duplicated, 1);
    assert.equal(inspection.timestamps, 40);
  });
});

test('inspeção conta IDs globalmente, relata conflitos com linha original e não duplica erros de parsing', async () => {
  await workspace(async directory => {
    const input = path.join(directory, 'input.txt');
    const rows = Array.from({ length: 60 }, (_, index) => row(index % 20 + 1, 59 - index));
    await fs.promises.writeFile(input, [header, ...rows, row(1, 59, 1), 'inválido'].join('\n'));
    const result = await inspectFile(input, { sortBatchRecords: 2 });
    assert.equal(result.count, 61);
    assert.equal(result.uniqueIds, 20);
    assert.equal(result.timestamps, 60);
    assert.equal(result.errorCount, 2);
    assert.match(result.issues.join('\n'), /Linha 62.*contraditórias/);
    assert.match(result.issues.join('\n'), /Linha 63.*colunas/);
    const output = path.join(directory, 'output.json');
    await fs.promises.writeFile(output, 'anterior');
    await fs.promises.writeFile(input, [header, ...rows, row(1, 59, 1)].join('\n'));
    await assert.rejects(processFile(input, output, opts), /Linha 62.*contraditórias/);
    assert.equal(await fs.promises.readFile(output, 'utf8'), 'anterior');
  });
});

test('cancelamento durante merge remove runs temporários e encerra leitores', async t => {
  await workspace(async directory => {
    const input = path.join(directory, 'input.txt');
    await fs.promises.writeFile(input, [header, ...Array.from({ length: 60 }, (_, second) => row(1, 59 - second))].join('\n'));
    const created = [];
    const mkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    t.mock.method(fs.promises, 'mkdtemp', async (...args) => { const folder = await mkdtemp(...args); created.push(folder); return folder; });
    const controller = new AbortController();
    const reader = orderedDatasetRows(input, false, { sortBatchRecords: 2, signal: controller.signal });
    assert.equal((await reader.next()).value.record.timestamp, '2024-01-01 00:00:00');
    controller.abort();
    await assert.rejects(reader.next(), error => error.name === 'AbortError');
    assert.ok(created.length > 0);
    for (const folder of created) assert.equal(fs.existsSync(folder), false);
  });
});

test('chaves internas não reduzem o limite de comprimento da linha original', async () => {
  await workspace(async directory => {
    const input = path.join(directory, 'input.txt');
    const base = row(1);
    const padded = base.replace(';;', `;${'A'.repeat(1_048_576 - base.length)};`);
    assert.equal(padded.length, 1_048_576);
    await fs.promises.writeFile(input, [header, row(2, 1), padded].join('\n'));
    const result = await inspectFile(input, { sortBatchRecords: 1 });
    assert.equal(result.valid, true);
    assert.equal(result.count, 2);
  });
});
