// Explicit full-file audit; excluded from the quick *.test.js suite.
// node --max-old-space-size=256 tests/large-datasets.mjs <dataset5.txt> <dataset6.txt> <dataset7.txt>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { createAppServer } from '../dist/src/server.js';
import { parseLine, isHeader } from '../dist/src/parser.js';

const files = process.argv.slice(2).map(file => path.resolve(file));
assert.equal(files.length, 3, 'Informe os três arquivos originais: dataset5.txt, dataset6.txt e dataset7.txt.');
const expectedCounts = { 'dataset5.txt': 1_000_000, 'dataset6.txt': 8_000_000, 'dataset7.txt': 12_000_000 };
assert.deepEqual(files.map(file => path.basename(file)).sort(), Object.keys(expectedCounts));
const root = new URL('../', import.meta.url);
const reportFile = new URL('benchmarks/large-datasets-http.json', root);
const report = { status: 'running', node: process.version, heapLimitMiB: 256, genericPolicy: 'all', mode: 'unordered',
  method: 'Arquivos completos: dois uploads HTTP com SHA-256, inspeção, processamento, download, paginação e mapa; referência independente por força bruta sobre TODOS os pares do mesmo timestamp, sem índice espacial nem amostragem; igualdade exata de todos os campos e distâncias.',
  datasets: [] };
const persist = () => fs.promises.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = items => [...items].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.monitoradosEncontro[0] - b.monitoradosEncontro[0] || a.monitoradosEncontro[1] - b.monitoradosEncontro[1]);
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

function upload(base, route, file, size) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    const hash = createHash('sha256');
    let bytes = 0;
    const request = http.request(`${base}${route}?filename=${encodeURIComponent(path.basename(file))}`, {
      method: 'POST', headers: { 'Content-Length': size, 'Content-Type': 'text/plain' }, agent: false
    });
    const fail = error => { input.destroy(); request.destroy(); reject(error); };
    request.once('error', fail);
    input.once('error', fail);
    input.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
    request.once('response', response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.once('error', fail);
      response.once('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
          assert.equal(response.statusCode, route === '/api/process' ? 201 : 200, JSON.stringify(body));
          assert.equal(bytes, size, 'upload incompleto');
          resolve({ body, sha256: hash.digest('hex') });
        } catch (error) { fail(error); }
      });
    });
    input.pipe(request);
  });
}

// Intentionally independent of detectGroup, classifyPair, haversine and grouping.
// Every same-time pair is measured, including distant pairs rejected by the index.
async function bruteForce(file) {
  const input = fs.createReadStream(file);
  const hash = createHash('sha256');
  input.on('data', chunk => hash.update(chunk));
  const reader = createInterface({ input, crlfDelay: Infinity });
  input.on('error', error => reader.emit('error', error));
  let count = 0, lines = 0, timestamps = 0, pairs = 0, maxGroup = 0;
  let current = null;
  const uniqueIds = new Set();
  let group = [];
  const encounters = [];
  const byType = { generico: 0, faccao: 0, protetiva: 0 };
  let firstTimestamp = null, lastTimestamp = null;
  function flush() {
    if (!group.length) return;
    timestamps++;
    maxGroup = Math.max(maxGroup, group.length);
    group.sort((a, b) => a.id - b.id);
    assert.equal(new Set(group.map(row => row.id)).size, group.length, 'registro duplicado na entrada original');
    const radians = Math.PI / 180;
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        pairs++;
        const phi1 = a.lat * radians, phi2 = b.lat * radians;
        const deltaPhi = (b.lat - a.lat) * radians, deltaLambda = (b.lon - a.lon) * radians;
        const sinPhi = Math.sin(deltaPhi / 2), sinLambda = Math.sin(deltaLambda / 2);
        const h = sinPhi * sinPhi + Math.cos(phi1) * Math.cos(phi2) * sinLambda * sinLambda;
        const distance = 2 * 6_371_000 * Math.atan2(Math.sqrt(Math.max(0, h)), Math.sqrt(Math.max(0, 1 - h)));
        if (distance >= 20) continue;
        let tipo = 'generico';
        if (!a.medidaProtetiva && !b.medidaProtetiva && a.faccao && a.faccao === b.faccao) tipo = 'faccao';
        if (a.medidaProtetiva !== b.medidaProtetiva) {
          const victim = a.medidaProtetiva ? a : b;
          const other = a.medidaProtetiva ? b : a;
          if (victim.idsRestricaoMedida.has(other.id)) tipo = 'protetiva';
        }
        byType[tipo]++;
        encounters.push({ tipo, monitoradosEncontro: [a.id, b.id], timestamp: a.timestamp,
          posicoes: { [a.id]: { lat: a.lat, lon: a.lon }, [b.id]: { lat: b.lat, lon: b.lon } }, distanciaMetros: distance });
      }
    }
  }
  try {
    for await (const line of reader) {
      lines++;
      if (!line.trim() || isHeader(line)) continue;
      const row = parseLine(line, lines);
      count++;
      uniqueIds.add(row.id);
      firstTimestamp ??= row.timestamp;
      lastTimestamp = row.timestamp;
      assert.ok(current === null || row.timestamp >= current, 'a auditoria completa exige os originais cronológicos');
      if (current !== row.timestamp) { flush(); group = []; current = row.timestamp; }
      group.push(row);
      if (count % 2_000_000 === 0) log(`${path.basename(file)}: força bruta, ${count} registros conferidos`);
    }
    flush();
  } finally { reader.close(); input.destroy(); }
  return { count, timestamps, maxGroup, uniqueIds: uniqueIds.size, firstTimestamp, lastTimestamp, pairs, byType, encounters, sha256: hash.digest('hex') };
}

const server = createAppServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  report.limits = await (await fetch(`${base}/api/health`)).json();
  await persist();
  for (const file of files) {
    const filename = path.basename(file);
    const initial = await fs.promises.stat(file);
    let peakRssBytes = process.memoryUsage().rss;
    const sampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 250);
    try {
      log(`${filename}: pré-validação HTTP completa, ${initial.size} bytes`);
      let began = performance.now();
      const inspectionResponse = await upload(base, '/api/inspect', file, initial.size);
      const inspectionMs = performance.now() - began;
      const inspection = inspectionResponse.body.inspection;
      assert.equal(inspection.valid, true, JSON.stringify(inspection.issues));
      assert.equal(inspection.count, expectedCounts[filename]);
      assert.equal(inspection.duplicated, 0);
      assert.equal(inspection.errorCount, 0);
      log(`${filename}: ${inspection.count} registros válidos; iniciando processamento HTTP completo`);
      began = performance.now();
      const processResponse = await upload(base, '/api/process', file, initial.size);
      const processingHttpMs = performance.now() - began;
      const { job } = processResponse.body;
      assert.equal(job.count, inspection.count);
      assert.equal(job.size, initial.size);
      assert.equal(job.duplicated, 0);
      assert.equal(job.timestamps, inspection.timestamps);
      const downloaded = Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer());
      const actual = JSON.parse(downloaded.toString('utf8'));
      assert.equal(actual.length, job.encounters);
      log(`${filename}: ${job.encounters} encontros; iniciando força bruta integral`);
      began = performance.now();
      const reference = await bruteForce(file);
      const bruteForceMs = performance.now() - began;
      assert.equal(reference.count, job.count);
      assert.equal(reference.timestamps, job.timestamps);
      assert.equal(reference.uniqueIds, inspection.uniqueIds);
      assert.equal(reference.firstTimestamp, inspection.firstTimestamp);
      assert.equal(reference.lastTimestamp, inspection.lastTimestamp);
      assert.equal(reference.pairs, job.performanceMetrics.potentialPairs);
      assert.deepEqual(reference.byType, job.byType);
      assert.deepEqual(canonical(actual), canonical(reference.encounters), 'encontro perdido, extra ou campo/distância divergente');
      assert.equal(reference.sha256, inspectionResponse.sha256, 'bytes da inspeção divergem do original');
      assert.equal(reference.sha256, processResponse.sha256, 'bytes do processamento divergem do original');
      const pages = [];
      for (let offset = 0; offset < job.encounters; offset += 10) {
        const page = await (await fetch(`${base}/api/jobs/${job.id}/results?offset=${offset}&limit=10`)).json();
        assert.equal(page.total, job.encounters);
        pages.push(...page.items);
      }
      assert.deepEqual(pages, actual);
      const map = await (await fetch(`${base}/api/jobs/${job.id}/map`)).json();
      assert.equal(map.total, actual.length);
      assert.equal(map.sampled, false);
      assert.deepEqual(map.items, actual);
      const finalStat = await fs.promises.stat(file);
      assert.equal(finalStat.size, initial.size);
      assert.equal(finalStat.mtimeMs, initial.mtimeMs);
      const outputFilename = filename.replace(/\.txt$/, '.json');
      await fs.promises.mkdir(new URL('outputs/', root), { recursive: true });
      await fs.promises.writeFile(new URL(`outputs/${outputFilename}`, root), downloaded);
      report.datasets.push({ filename, bytes: initial.size, inputSha256: reference.sha256,
        count: job.count, duplicated: job.duplicated, timestamps: job.timestamps, uniqueIds: reference.uniqueIds, maxRecordsPerTimestamp: reference.maxGroup,
        encounters: job.encounters, byType: job.byType, performanceMetrics: job.performanceMetrics,
        bruteForcePairs: reference.pairs, missing: 0, extra: 0, differingFieldsOrDistances: 0, exactMatch: true,
        inspectionMs, processingHttpMs, processingCoreMs: job.durationMs, bruteForceMs, peakRssBytes,
        outputFilename, outputSha256: sha(downloaded), paginationVerified: true, mapVerified: true });
      await persist();
      log(`${filename}: APROVADO — ${job.count} registros, ${reference.pairs} pares conferidos, ${job.encounters} encontros, zero divergências`);
    } finally { clearInterval(sampler); }
  }
  report.status = 'passed';
  await persist();
  log('Três arquivos completos aprovados. Relatório: benchmarks/large-datasets-http.json');
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  await persist();
  throw error;
} finally {
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
}
