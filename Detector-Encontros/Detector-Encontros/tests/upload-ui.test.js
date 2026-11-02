import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../dist/web/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replace(/\binit\(\);\s*(?=\/\/# sourceMappingURL=|$)/, '');
const limits = { maxUploadBytes: 10 * 1073741824, maxRecords: 20000000, maxConcurrentJobs: 1, requestTimeoutMs: 900000 };
function harness(fetch) {
  const elements = new Map();
  const context = vm.createContext({ fetch, document: { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { localName: ['perf-explanation', 'perf-candidate-method'].includes(id) ? 'small' : id === 'perf-bar' ? 'div' : id === 'performance-context' ? 'span' : 'strong', style: {} });
    return elements.get(id);
  } } });
  vm.runInContext(source + '\nrenderFiles = () => {}; globalThis.harness = { state, addFiles, fileKey, getJSON, isHealthResponse, updatePerformance, bytes, validateUploadSize };', context);
  return { ...context.harness, elements };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const inspection = { valid: true, count: 1, duplicated: 0, timestamps: 1, uniqueIds: 1, firstTimestamp: '2024-01-01 00:00:00', lastTimestamp: '2024-01-01 00:00:00', headerPresent: true, errorCount: 0, issues: [], sample: [] };

test('UI mostra 10 GiB e aplica o limite exato sem alocar um arquivo gigante', () => {
  const h = harness(async () => {});
  assert.equal(h.bytes(limits.maxUploadBytes), '10 GiB');
  assert.doesNotThrow(() => h.validateUploadSize({ name: 'limite.txt', size: limits.maxUploadBytes }, limits));
  assert.throws(() => h.validateUploadSize({ name: 'acima.txt', size: limits.maxUploadBytes + 1 }, limits), /excede o limite de 10 GiB/);
});

test('UI consulta limite real e aceita dataset7 sem limite fixo de 100 MB', async () => {
  const calls = [];
  const h = harness(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url === '/api/health' ? { status: 'ok', limits } : { filename: options.body.name, size: options.body.size, inspection } };
  });
  const file = { name: 'dataset7.txt', size: 638210371, lastModified: 1 };
  h.addFiles([file]);
  await tick();
  assert.equal(calls[0].url, '/api/health');
  assert.equal(calls[1].options.body, file);
  assert.equal(h.state.inspections.get(h.fileKey(file)).status, 'valid');
});

test('UI impede upload acima do limite configurado antes de enviar o corpo', async () => {
  const calls = [];
  const h = harness(async url => { calls.push(url); return { ok: true, json: async () => ({ status: 'ok', limits: { ...limits, maxUploadBytes: 100 * 1048576 } }) }; });
  const file = { name: 'dataset6.txt', size: 423411895, lastModified: 1 };
  h.addFiles([file]);
  await tick();
  assert.deepEqual(calls, ['/api/health']);
  const status = h.state.inspections.get(h.fileKey(file));
  assert.equal(status.status, 'invalid');
  assert.match(status.issues[0], /excede o limite de 100 MB.*não foi enviado/);
});

test('UI explica falha de conexão e não envia dados se não conseguiu consultar o servidor', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new TypeError('Failed to fetch'); });
  const file = { name: 'dataset7.txt', size: 638210371, lastModified: 1 };
  h.addFiles([file]);
  await tick();
  assert.equal(calls, 1);
  assert.match(h.state.inspections.get(h.fileKey(file)).issues[0], /conexão com o servidor foi interrompida/);
  assert.doesNotMatch(h.state.inspections.get(h.fileKey(file)).issues[0], /Failed to fetch/);
});

test('painel distingue todos os registros de pares candidatos e não arredonda redução parcial para 100%', () => {
  const h = harness(async () => { throw new Error('sem rede'); });
  h.state.activeId = 'dataset5';
  h.state.jobs = [{ id: 'dataset5', filename: 'dataset5.txt', count: 1000000, durationMs: 10000, performanceMetrics: { potentialPairs: 39500000, candidatePairs: 22, haversineCalculations: 22, directGroups: 0, spatialGroups: 12500 } }];
  h.updatePerformance();
  assert.equal(h.elements.get('perf-records').textContent, '1.000.000');
  assert.equal(h.elements.get('perf-candidates').textContent, '22');
  assert.equal(h.elements.get('perf-reduction').textContent, '> 99,99%');
  assert.equal(h.elements.get('perf-candidate-method').textContent, 'Após seleção espacial');
  assert.match(h.elements.get('perf-explanation').textContent, /1\.000\.000 registros lidos integralmente.*12\.500 com seleção espacial.*22 foram avaliados.*sem remover registros/);
  h.state.jobs = [{ id: 'dataset1', filename: 'dataset1.txt', count: 5000, durationMs: 20, performanceMetrics: { potentialPairs: 22500, candidatePairs: 22500, haversineCalculations: 22500, directGroups: 500, spatialGroups: 0 } }];
  h.state.activeId = 'dataset1';
  h.updatePerformance();
  assert.equal(h.elements.get('perf-candidates').textContent, '22.500');
  assert.equal(h.elements.get('perf-reduction').textContent, '0%');
  assert.equal(h.elements.get('perf-candidate-method').textContent, 'Comparação direta entre pares');
  assert.match(h.elements.get('perf-explanation').textContent, /500 horários com comparação direta e 0 com seleção espacial/);
  h.state.jobs[0].performanceMetrics.spatialGroups = 1;
  h.updatePerformance();
  assert.equal(h.elements.get('perf-candidate-method').textContent, 'Comparação direta e seleção espacial');
  h.state.activeId = null;
  h.updatePerformance();
  assert.equal(h.elements.get('perf-candidate-method').textContent, 'Conforme a estratégia do motor');
});
