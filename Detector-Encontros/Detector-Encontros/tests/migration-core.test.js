import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { haversine, classifyPair, detectGroup, RAIO_TERRA_METROS } from '../dist/src/algorithm.js';
import { parseLine, DatasetError, ResourceLimitError } from '../dist/src/parser.js';
import { processFile } from '../dist/src/cli.js';
import { inspectFile } from '../dist/src/inspection.js';
import { compare, assertEncounter } from '../dist/src/compare.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = '2024-01-01 00:00:00';
const header = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
const row = (id, lat = 0, lon = 0, properties = {}) => ({
  id, lat, lon, timestamp, faccao: '', medidaProtetiva: false, idsRestricaoMedida: new Set(), ...properties
});
const inputLine = (id, time = timestamp, lat = 0, lon = 0) => `${id};;${time};${lat};${lon};false;`;
const canonical = items => [...items].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.monitoradosEncontro[0] - b.monitoradosEncontro[0] || a.monitoradosEncontro[1] - b.monitoradosEncontro[1]);
const options = { mode: 'unordered', genericPolicy: 'all' };

async function withDirectory(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'detector-migration-'));
  try { await fn(directory); }
  finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

test('limite Haversine estrito, exatamente 20 m e precisão preservada', () => {
  const origin = row(1);
  const exact = row(2, 20 / RAIO_TERRA_METROS * 180 / Math.PI);
  assert.equal(haversine(origin, origin), 0);
  assert.equal(haversine(origin, exact), 20);
  for (const bruteForceThreshold of [0, 64]) {
    assert.equal([...detectGroup([origin, exact], { bruteForceThreshold })].length, 0);
    const below = row(2, exact.lat * (1 - 1e-10));
    const above = row(2, exact.lat * (1 + 1e-10));
    const detected = [...detectGroup([origin, below], { bruteForceThreshold })];
    assert.equal(detected.length, 1);
    assert.equal(detected[0].distanciaMetros, haversine(origin, below));
    assert.equal([...detectGroup([origin, above], { bruteForceThreshold })].length, 0);
  }
});

test('parser valida calendário, IDs seguros, números decimais e aspas', () => {
  const good = parseLine('\uFEFF"9007199254740991";"A;B";"2024-02-29 23:59:59";"-1.25e1";"+0.5";TRUE;"[1, 2, 2]"', 7);
  assert.equal(good.id, Number.MAX_SAFE_INTEGER);
  assert.equal(good.faccao, 'A;B');
  assert.equal(good.lat, -12.5);
  assert.deepEqual([...good.idsRestricaoMedida], [1, 2]);
  assert.equal(parseLine('1;"A""B";2024-01-01 00:00:00;0;0;0;').faccao, 'A"B');
  const invalid = [
    '9007199254740992;;2024-01-01 00:00:00;0;0;false;',
    '-1;;2024-01-01 00:00:00;0;0;false;',
    '1;;2023-02-29 00:00:00;0;0;false;',
    '1;;2024-04-31 00:00:00;0;0;false;',
    '1;;2024-00-01 00:00:00;0;0;false;',
    '1;;2024-01-01 24:00:00;0;0;false;',
    '1;;2024-01-01 00:60:00;0;0;false;',
    '1;;2024-01-01 00:00:60;0;0;false;',
    '1;;2024-01-01 00:00:00;0x10;0;false;',
    '1;;2024-01-01 00:00:00;Infinity;0;false;',
    '1;;2024-01-01 00:00:00;;0;false;',
    '1;;2024-01-01 00:00:00;91;0;false;',
    '1;;2024-01-01 00:00:00;0;-181;false;',
    '1;;2024-01-01 00:00:00;0;0;yes;',
    '1;;2024-01-01 00:00:00;0;0;true;1,x',
    '1;;2024-01-01 00:00:00;0;0;true;1,9007199254740992',
    '1;"unterminated;2024-01-01 00:00:00;0;0;false;',
    '1;bad"quote";2024-01-01 00:00:00;0;0;false;',
    '1;;2024-01-01 00:00:00;0;0;false'
  ];
  for (const line of invalid) assert.throws(() => parseLine(line, 42), error => error instanceof DatasetError && /Linha 42/.test(error.message), line);
});

test('classificação exclusiva preserva as duas políticas e vários vínculos', () => {
  const attacker = row(2, 0, 0, { faccao: 'X' });
  const victim = row(1, 0, 0, { faccao: 'X', medidaProtetiva: true, idsRestricaoMedida: new Set([2, 3, 4]) });
  for (const genericPolicy of ['all', 'tornozeleiras']) {
    assert.equal(classifyPair(victim, attacker, genericPolicy), 'protetiva');
    assert.equal(classifyPair(attacker, victim, genericPolicy), 'protetiva');
    assert.equal(classifyPair(attacker, row(8, 0, 0, { faccao: 'X' }), genericPolicy), 'faccao');
    assert.equal(classifyPair(attacker, row(8, 0, 0, { faccao: 'Y' }), genericPolicy), 'generico');
    assert.equal(classifyPair(row(8), row(9), genericPolicy), 'generico');
    assert.equal(classifyPair(victim, row(9), genericPolicy), genericPolicy === 'all' ? 'generico' : null);
    assert.equal(classifyPair(victim, row(9, 0, 0, { medidaProtetiva: true }), genericPolicy), genericPolicy === 'all' ? 'generico' : null);
  }
});

test('ECEF equivale à força bruta com sementes fixas, polos, antimeridiano e células limítrofes', () => {
  let state = 0x57ace;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x100000000; };
  const groups = [];
  for (const [latitude, longitude] of [[0, 0], [-25.5, -49.3], [89.99999, 179.99999], [-89.99999, -179.99999], [0, 179.99999]]) {
    for (const spread of [0.00004, 0.01]) {
      groups.push(Array.from({ length: 130 }, (_, index) => {
        const id = index + 1;
        const lat = Math.max(-90, Math.min(90, latitude + (random() - 0.5) * spread));
        const lon = ((longitude + (random() - 0.5) * spread + 540) % 360) - 180;
        return row(id, lat, lon, { faccao: index % 3 ? 'A' : 'B', medidaProtetiva: index % 7 === 0, idsRestricaoMedida: new Set([id - 1, id + 1]) });
      }));
    }
  }
  groups.push(Array.from({ length: 100 }, (_, index) => row(index + 1, (index % 10) * 20 / RAIO_TERRA_METROS * 180 / Math.PI, Math.floor(index / 10) * 20 / RAIO_TERRA_METROS * 180 / Math.PI)));
  groups.push([row(1, 90, 0), row(2, 90, 180), row(3, 89.99999, -90)]);
  groups.push([row(1, -90, -180), row(2, -90, 0), row(3, -89.99999, 90)]);
  for (const records of groups) {
    for (const genericPolicy of ['all', 'tornozeleiras']) {
      const brute = canonical(detectGroup(records, { genericPolicy, bruteForceThreshold: Infinity }));
      const indexed = canonical(detectGroup(records, { genericPolicy, bruteForceThreshold: 0 }));
      assert.deepEqual(indexed, brute);
      assert.equal(new Set(indexed.map(e => e.monitoradosEncontro.join(','))).size, indexed.length);
    }
  }
});

test('dataset1 preserva os quatro encontros esperados nas duas políticas, sem tolerância', async () => {
  // Expectativas fixas independentes do motor, sem depender de outputs ou relatórios externos.
  const expected = [
    { tipo: 'generico', monitoradosEncontro: [4, 6], timestamp: '2024-01-01 00:05:15',
      posicoes: { 4: { lat: -31.93195, lon: -40.61438 }, 6: { lat: -31.93187, lon: -40.61435 } }, distanciaMetros: 9.33522817789823 },
    { tipo: 'generico', monitoradosEncontro: [3, 5], timestamp: '2024-01-01 00:10:20',
      posicoes: { 3: { lat: -28.28206, lon: -44.63511 }, 5: { lat: -28.28207, lon: -44.6352 } }, distanciaMetros: 8.882771981092958 },
    { tipo: 'protetiva', monitoradosEncontro: [9, 10], timestamp: '2024-01-01 00:16:45',
      posicoes: { 9: { lat: 1.83355, lon: -69.5461 }, 10: { lat: 1.83351, lon: -69.54618 } }, distanciaMetros: 9.941503149375345 },
    { tipo: 'faccao', monitoradosEncontro: [7, 8], timestamp: '2024-01-01 00:36:00',
      posicoes: { 7: { lat: -13.02054, lon: -46.40609 }, 8: { lat: -13.02046, lon: -46.40609 } }, distanciaMetros: 8.895594131622975 }
  ];
  await withDirectory(async directory => {
    for (const genericPolicy of ['all', 'tornozeleiras']) {
      const output = path.join(directory, `${genericPolicy}.json`);
      const metrics = await processFile(path.join(root, 'datasets/dataset1.txt'), output, { ...options, genericPolicy });
      const actual = JSON.parse(await fs.promises.readFile(output, 'utf8'));
      assert.deepEqual(actual, expected);
      assert.equal(compare(expected, actual, 0).correct, 4);
      assert.equal(metrics.count, 5000);
      assert.deepEqual(metrics.byType, { generico: 2, faccao: 1, protetiva: 1 });
      for (const encounter of actual) assertEncounter(encounter);
    }
  });
});

test('sorted e unordered preservam timestamps exatos, duplicatas e lotes de sete datasets', async () => {
  await withDirectory(async directory => {
    const datasets = path.join(directory, 'datasets');
    await fs.promises.mkdir(datasets);
    const rows = [inputLine(1), inputLine(2, timestamp, 0, 0.00001), inputLine(2, timestamp, 0, 0.00001), inputLine(1, '2024-01-01 00:00:01'), inputLine(2, '2024-01-01 00:00:01', 0, 0.00001)];
    const source = [header, ...rows].join('\n');
    for (let id = 1; id <= 7; id++) await fs.promises.writeFile(path.join(datasets, `dataset${id}.txt`), source);
    const results = [];
    for (const mode of ['sorted', 'unordered']) {
      const input = path.join(directory, `${mode}.txt`);
      await fs.promises.writeFile(input, [header, ...(mode === 'sorted' ? rows : [...rows].reverse())].join('\n'));
      const output = path.join(directory, `${mode}.json`);
      const metrics = await processFile(input, output, { ...options, mode });
      assert.equal(metrics.duplicated, 1);
      assert.equal(metrics.encounters, 2);
      results.push(JSON.parse(await fs.promises.readFile(output, 'utf8')));
    }
    assert.deepEqual(results[0], results[1]);
    const batch = path.join(directory, 'batch');
    const run = spawnSync(process.execPath, ['dist/src/cli.js', '--input', datasets, '--output', batch, '--mode', 'sorted'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal((await fs.promises.readdir(batch)).length, 7);
    for (const filename of await fs.promises.readdir(batch)) assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(batch, filename), 'utf8')), results[0]);
  });
});

test('falhas de dataset, leitura, limites e cancelamento preservam saída anterior e limpam parciais', async () => {
  await withDirectory(async directory => {
    const input = path.join(directory, 'input.txt');
    const output = path.join(directory, 'output.json');
    await fs.promises.writeFile(output, 'anterior');
    const scenarios = [
      { text: '', settings: options, error: DatasetError },
      { text: `${header}\n`, settings: options, error: DatasetError },
      { text: [header, inputLine(1), inputLine(1, timestamp, 1)].join('\n'), settings: options, error: DatasetError },
      { text: [header, inputLine(1, '2024-01-01 00:00:01'), inputLine(2)].join('\n'), settings: { ...options, mode: 'sorted' }, error: DatasetError },
      { text: [header, inputLine(1), inputLine(2)].join('\n'), settings: { ...options, maxRecords: 1 }, error: ResourceLimitError },
      { text: [header, inputLine(1), inputLine(2)].join('\n'), settings: { ...options, maxOutputBytes: 4 }, error: ResourceLimitError },
      { text: 'x'.repeat(1_048_577), settings: options, error: ResourceLimitError }
    ];
    for (const { text, settings, error } of scenarios) {
      await fs.promises.writeFile(input, text);
      await assert.rejects(processFile(input, output, settings), error);
      assert.equal(await fs.promises.readFile(output, 'utf8'), 'anterior');
      assert.deepEqual((await fs.promises.readdir(directory)).filter(name => name.endsWith('.partial')), []);
    }
    const missing = path.join(directory, 'missing.txt');
    await assert.rejects(processFile(missing, output, options), /ENOENT/);
    await assert.rejects(inspectFile(missing), /ENOENT/);
    const controller = new AbortController();
    await fs.promises.writeFile(input, [header, ...Array.from({ length: 10000 }, (_, n) => inputLine(n + 1))].join('\n'));
    const pending = processFile(input, output, { ...options, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(await fs.promises.readFile(output, 'utf8'), 'anterior');
    assert.deepEqual((await fs.promises.readdir(directory)).filter(name => name.endsWith('.partial')), []);
  });
});

test('erro assíncrono de escrita é propagado sem publicar JSON incompleto', async t => {
  await withDirectory(async directory => {
    const input = path.join(directory, 'input.txt');
    const output = path.join(directory, 'output.json');
    await fs.promises.writeFile(input, [header, inputLine(1), inputLine(2)].join('\n'));
    await fs.promises.writeFile(output, 'anterior');
    const createWriteStream = fs.createWriteStream;
    // Injeção de falha I/O reproduz disco cheio sem esgotar o disco da máquina.
    t.mock.method(fs, 'createWriteStream', (file, settings) => {
      const writer = createWriteStream(file, settings);
      writer.once('open', () => writer.destroy(new Error('ENOSPC: disco cheio')));
      return writer;
    });
    await assert.rejects(processFile(input, output, options), /ENOSPC|Escrita interrompida/);
    assert.equal(await fs.promises.readFile(output, 'utf8'), 'anterior');
    assert.deepEqual((await fs.promises.readdir(directory)).filter(name => name.endsWith('.partial')), []);
  });
});

test('comparação rigorosa rejeita JSON malformado e identifica diferenças em cada campo', () => {
  const original = [...detectGroup([row(1), row(2, 0, 0.00001)])];
  const reversed = structuredClone(original);
  reversed[0].monitoradosEncontro.reverse();
  assert.equal(compare(original, reversed, 0).correct, 1);
  for (const [field, mutate] of [
    ['wrongType', e => { e.tipo = 'faccao'; }],
    ['wrongPosition', e => { e.posicoes['1'].lat = 1e-10; }],
    ['wrongDistance', e => { e.distanciaMetros += 1e-10; }]
  ]) {
    const changed = structuredClone(original);
    mutate(changed[0]);
    assert.equal(compare(original, changed, 0).issues[field].length, 1);
  }
  const time = structuredClone(original);
  time[0].timestamp = '2024-01-01 00:00:01';
  const timeReport = compare(original, time, 0);
  assert.equal(timeReport.missing, 1);
  assert.equal(timeReport.issues.extra.length, 1);
  assert.throws(() => compare(original, [{ ...original[0], debug: true }]));
  assert.throws(() => compare(original, [{ ...original[0], distanciaMetros: null }]));
  assert.throws(() => compare([null], original));
  assert.equal(compare(original, [...original, ...original]).issues.duplicate.length, 1);
});
