import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { haversine, classifyPair, detectGroup } from '../dist/src/algorithm.js';
import { parseLine, isHeader } from '../dist/src/parser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = '2026-10-01 00:00:00';
function rec(id, lat, lon, props = {}) {
  return { id, lat, lon, timestamp: ts, faccao: '', medidaProtetiva: false, idsRestricaoMedida: new Set(), ...props };
}
function detected(records, options) { return [...detectGroup(records, options)]; }
function pairKey(e) { return `${e.timestamp}|${e.monitoradosEncontro.join('-')}|${e.tipo}`; }

test('Haversine: 0m, 11m e acima de 20m', () => {
  assert.equal(haversine(rec(1, 0, 0), rec(2, 0, 0)), 0);
  assert.ok(Math.abs(haversine(rec(1, 0, 0), rec(2, 0.00010, 0)) - 11.119492664455874) < 1e-9);
  assert.ok(haversine(rec(1, 0, 0), rec(2, 0.00018, 0)) > 20);
  assert.equal(detected([rec(1, 0, 0), rec(2, 0.00018, 0)]).length, 0);
});

test('timestamp, ID, posição e tipo', () => {
  const a = rec(40, -10.07996, -37.08384, { faccao: '7' });
  const b = rec(44, -10.07987, -37.08389, { faccao: '7' });
  const got = detected([b, a]);
  assert.equal(got.length, 1);
  assert.equal(got[0].tipo, 'faccao');
  assert.deepEqual(got[0].monitoradosEncontro, [40, 44]);
  assert.equal(got[0].timestamp, ts);
  assert.deepEqual(got[0].posicoes[40], { lat: -10.07996, lon: -37.08384 });
  assert.ok(Math.abs(got[0].distanciaMetros - 11.406788673336607) < 1e-7);
});

test('facção vazia não é facção', () => {
  assert.equal(classifyPair(rec(1, 0, 0), rec(2, 0, 0)), 'generico');
});

test('protetiva tem prioridade e exige vínculo com agressor', () => {
  const agressor = rec(7, 0, 0, { faccao: 'ABC' });
  const vitima = rec(8, 0, 0.00001, { medidaProtetiva: true, idsRestricaoMedida: new Set([7]) });
  assert.equal(classifyPair(agressor, vitima), 'protetiva');
  assert.equal(classifyPair(vitima, agressor), 'protetiva');
  assert.equal(classifyPair(rec(9, 0, 0), vitima, 'tornozeleiras'), null);
  assert.equal(classifyPair(rec(9, 0, 0), vitima, 'all'), 'generico');
});

test('hash espacial é equivalente à força bruta em grupo denso', () => {
  const data = Array.from({ length: 145 }, (_, i) => rec(i + 1, 0.005 + i * 0.000006, 0.001 + (i % 9) * 0.000008,
    { faccao: (i % 4).toString() }));
  const brute = detected(data, { bruteForceThreshold: 1000 });
  const hash = detected(data, { bruteForceThreshold: 0 });
  assert.deepEqual(new Set(brute.map(pairKey)), new Set(hash.map(pairKey)));
  assert.equal(hash.length, new Set(hash.map(e => e.monitoradosEncontro.join('-'))).size);
  const distsA = new Map(brute.map(e => [pairKey(e), e.distanciaMetros]));
  for (const e of hash) assert.equal(e.distanciaMetros, distsA.get(pairKey(e)));
});

test('hash espacial cobre a mudança de longitude de +180 para -180', () => {
  const results = detected([rec(1, 0, 179.99995), rec(2, 0, -179.99995)], { bruteForceThreshold: 0 });
  assert.equal(results.length, 1);
  assert.ok(results[0].distanciaMetros < 20);
});

test('parser: cabeçalho BOM, restrições e booleanos', () => {
  assert.ok(isHeader('\uFEFFidMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida'));
  const r = parseLine('100;;2026-10-01 00:00:00;-10.00000;-37.00000;TRUE;"40, 44"', 2);
  assert.equal(r.id, 100);
  assert.equal(r.medidaProtetiva, true);
  assert.deepEqual([...r.idsRestricaoMedida], [40, 44]);
  assert.throws(() => parseLine('1;;2026-10-01 00:00:00;;;false;', 3), /coordenadas/);
});

test('CLI: timestamps desordenados, mesmo par em momentos distintos e duplicatas idênticas', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'spacecom-test-'));
  try {
    const input = path.join(tmp, 'sample.txt');
    const output = path.join(tmp, 'sample.json');
    writeFileSync(input, [
      'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida',
      '1;A;2026-10-01 00:00:05;0;0;false;',
      '1;A;2026-10-01 00:00:00;0;0;false;',
      '2;A;2026-10-01 00:00:00;0;0.00001;false;',
      '2;A;2026-10-01 00:00:05;0;0.00001;false;',
      '2;A;2026-10-01 00:00:05;0;0.00001;false;'
    ].join('\n'));
    const status = spawnSync(process.execPath, ['dist/src/cli.js', '--input', input, '--output', output], { cwd: root, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    const out = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(v => v.timestamp), ['2026-10-01 00:00:00', '2026-10-01 00:00:05']);
    assert.ok(out.every(v => v.tipo === 'faccao'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI: modo sorted rejeita timestamps fora de ordem sem arquivo final', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'spacecom-test-'));
  try {
    const input = path.join(tmp, 'sample.txt');
    const output = path.join(tmp, 'sample.json');
    writeFileSync(input, [
      'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida',
      '1;A;2026-10-01 00:00:05;0;0;false;',
      '2;A;2026-10-01 00:00:00;0;0;false;'
    ].join('\n'));
    const proc = spawnSync(process.execPath, ['dist/src/cli.js', '--input', input, '--output', output, '--mode', 'sorted'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(proc.status, 0);
    assert.match(proc.stderr, /não é cronológico/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('comparador: detecta faltantes, extras e tipo incorreto', async () => {
  const { compare } = await import('../dist/src/compare.js');
  const base = detected([rec(1, 0, 0, { faccao: 'F' }), rec(2, 0, 0.00001, { faccao: 'F' }), rec(3, 0, 0.00002)]);
  const wrong = structuredClone(base.slice(0, 2));
  wrong[0].tipo = 'generico';
  const r = compare(base, wrong);
  assert.equal(r.correct, 1);
  assert.equal(r.incorrect, 1);
  assert.equal(r.missing, 1);
  assert.equal(r.approximateScore, 0);
});
