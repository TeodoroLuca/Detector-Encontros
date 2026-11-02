import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { createAppServer } from '../dist/src/server.js';

const header = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
const dataset = [header, '1;;2024-01-01 00:00:00;0;0;false;', '2;;2024-01-01 00:00:00;0;0.00001;false;'].join('\n');

async function withServer(options, fn) {
  const server = createAppServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function upload(base, name = 'dados.txt', body = dataset) {
  return fetch(`${base}/api/process?filename=${encodeURIComponent(name)}`, { method: 'POST', body });
}
async function noJobs(base) {
  assert.deepEqual((await (await fetch(`${base}/api/jobs`)).json()).jobs, []);
}
function startChunked(base) {
  const req = http.request(`${base}/api/process?filename=stream.txt`, { method: 'POST' });
  const response = new Promise((resolve, reject) => {
    req.once('response', res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.once('error', reject);
    });
    req.once('error', reject);
  });
  // Tests intentionally destroy some requests; install a handler immediately.
  void response.catch(() => {});
  req.write(header + '\n');
  return { req, response };
}
async function waitUntilBusy(base) {
  for (let n = 0; n < 50; n++) {
    const result = await fetch(`${base}/api/inspect?filename=probe.txt`, { method: 'POST', body: dataset });
    await result.text();
    if (result.status === 429) return;
    await setTimeout(10);
  }
  assert.fail('O upload aberto não ocupou a vaga de processamento.');
}
function readZip(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    assert.equal(buffer.readUInt16LE(at + 8), 0x0808);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = buffer.readUInt32LE(at + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt16LE(local + 6), 0x0808);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const content = buffer.subarray(start, start + size);
    assert.equal(buffer.readUInt32LE(start + size), 0x08074b50);
    assert.equal(buffer.readUInt32LE(start + size + 4), buffer.readUInt32LE(at + 16));
    assert.equal(buffer.readUInt32LE(start + size + 8), size);
    assert.ok(!entries.has(name), 'Nenhum nome de entrada pode se repetir.');
    entries.set(name, JSON.parse(content.toString('utf8')));
    at += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(at, end);
  return entries;
}

test('HTTP: limites de upload com Content-Length e transferência chunked preservam resposta 413', async () => {
  await withServer({ maxUploadBytes: 200 }, async base => {
    const oversized = await upload(base, 'grande.txt', 'x'.repeat(201));
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /limite/);
    const { req, response } = startChunked(base);
    req.end('x'.repeat(201));
    const chunked = await response;
    assert.equal(chunked.status, 413, chunked.body);
    await noJobs(base);
    assert.equal((await upload(base)).status, 201, 'A vaga deve ser liberada após uma falha.');
  });
});

test('HTTP: parâmetros, vazio, timestamp impossível e gabarito sem contrato são rejeitados', async () => {
  await withServer({}, async base => {
    for (const body of ['', header, dataset.replace('2024-01-01', '2024-02-30')]) {
      const bad = await upload(base, 'ruim.txt', body);
      assert.equal(bad.status, 400, await bad.text());
    }
    for (const query of ['genericPolicy=alll', 'mode=random']) {
      const bad = await fetch(`${base}/api/process?filename=dados.txt&${query}`, { method: 'POST', body: dataset });
      assert.equal(bad.status, 400);
    }
    const { job } = await (await upload(base)).json();
    for (const query of ['offset=-1', 'offset=0x1', 'offset=1e2', 'limit=0', 'limit=101', 'limit=1.5', 'type=outro']) {
      const bad = await fetch(`${base}/api/jobs/${job.id}/results?${query}`);
      assert.equal(bad.status, 400, query);
    }
    for (const body of ['invalid', '{}', '[{}]', '[null]']) {
      const bad = await fetch(`${base}/api/jobs/${job.id}/compare`, { method: 'POST', body });
      assert.equal(bad.status, 400, body);
    }
    const output = await (await fetch(`${base}/api/jobs/${job.id}/download`)).json();
    const reference = structuredClone(output);
    reference[0].monitoradosEncontro.reverse();
    const comparison = await fetch(`${base}/api/jobs/${job.id}/compare`, { method: 'POST', body: JSON.stringify(reference) });
    assert.equal(comparison.status, 200);
    assert.equal((await comparison.json()).report.correct, 1);
  });
});

test('HTTP: nomes Unicode e traversal não controlam caminhos internos nem cabeçalhos', async () => {
  await withServer({}, async base => {
    const response = await upload(base, '../../pasta\\posição東京.txt');
    assert.equal(response.status, 201);
    const { job } = await response.json();
    assert.equal(job.filename, 'posição東京.txt');
    assert.equal('output' in job, false);
    assert.equal('wroteArray' in job, false);
    const download = await fetch(`${base}/api/jobs/${job.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''posi%C3%A7%C3%A3o%E6%9D%B1%E4%BA%AC\.json/);
    assert.equal((await download.json()).length, 1);
    for (const route of ['/src/server.ts', '/package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
      const bad = await fetch(base + route);
      assert.equal(bad.status, 404, route);
      const result = await bad.text();
      assert.doesNotMatch(result, /AppData|Documents|[A-Z]:\\|stack|node_modules/);
    }
  });
});

test('HTTP: requisição interrompida libera a vaga e não publica resultado incompleto', async () => {
  await withServer({ maxConcurrentJobs: 1 }, async base => {
    const { req, response } = startChunked(base);
    await waitUntilBusy(base);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    req.destroy(new Error('interrupção de teste'));
    await assert.rejects(response, /interrupção de teste/);
    await noJobs(base);
    let recovered;
    for (let n = 0; n < 50; n++) {
      recovered = await upload(base);
      if (recovered.status !== 429) break;
      await recovered.text();
      await setTimeout(10);
    }
    assert.equal(recovered.status, 201, await recovered.text());
    assert.equal((await (await fetch(`${base}/api/jobs`)).json()).jobs.length, 1);
  });
});

test('HTTP: limites de registros, output e armazenamento recusam sem publicar jobs', async () => {
  for (const options of [{ maxRecords: 1 }, { maxOutputBytes: 16 }, { maxStoredOutputBytes: 16 }]) {
    await withServer(options, async base => {
      const result = await upload(base);
      assert.equal(result.status, 413, await result.text());
      await noJobs(base);
    });
  }
  await withServer({ maxRecords: 1 }, async base => {
    const result = await fetch(`${base}/api/inspect?filename=dados.txt`, { method: 'POST', body: dataset });
    assert.equal(result.status, 413);
    await noJobs(base);
  });
  await withServer({ maxJobs: 1 }, async base => {
    const first = await upload(base);
    const { job } = await first.json();
    assert.equal(first.status, 201);
    const second = await upload(base);
    assert.equal(second.status, 413);
    assert.equal((await (await fetch(`${base}/api/jobs/${job.id}/download`)).json()).length, 1);
  });
});

test('HTTP: ZIP mantém JSONs e distingue nomes repetidos, sufixos existentes e Unicode', async () => {
  await withServer({}, async base => {
    let reference;
    for (const filename of ['caso.txt', 'caso_2.txt', 'caso.txt', 'posição東京.txt']) {
      const processed = await upload(base, filename);
      assert.equal(processed.status, 201);
      const { job } = await processed.json();
      reference = await (await fetch(`${base}/api/jobs/${job.id}/download`)).json();
    }
    const response = await fetch(`${base}/api/download-all`);
    assert.equal(response.status, 200);
    const entries = readZip(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual([...entries.keys()], ['caso.json', 'caso_2.json', 'caso_3.json', 'posição東京.json']);
    for (const value of entries.values()) assert.deepEqual(value, reference);
  });
});

test('HTTP: configurações de limite inválidas falham antes de iniciar o servidor', () => {
  for (const options of [{ maxUploadBytes: NaN }, { maxConcurrentJobs: 0 }, { maxRecords: -1 }, { maxOutputBytes: Infinity }, { maxJobs: 1.5 }]) {
    assert.throws(() => createAppServer(options), /inteiro positivo/);
  }
});

test('HTTP: pré-validações sequenciais liberam a vaga antes de responder', async () => {
  await withServer({ maxConcurrentJobs: 1 }, async base => {
    for (let n = 0; n < 7; n++) {
      const response = await fetch(`${base}/api/inspect?filename=dataset${n + 1}.txt`, { method: 'POST', body: dataset });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).inspection.valid, true);
    }
    assert.equal((await upload(base)).status, 201);
  });
});

test('HTTP: leitura parcial e cancelamento de consultas não derrubam o servidor', async () => {
  await withServer({}, async base => {
    const body = [header, ...Array.from({ length: 100 }, (_, i) => `${i + 1};;2024-01-01 00:00:00;0;0;false;`)].join('\n');
    const posted = await upload(base, 'denso.txt', body);
    assert.equal(posted.status, 201);
    const { job } = await posted.json();
    assert.equal(job.encounters, 4950);
    for (const route of ['results?limit=1', 'map']) {
      const request = http.get(`${base}/api/jobs/${job.id}/${route}`);
      request.on('error', () => {});
      request.once('response', response => { response.on('error', () => {}); response.destroy(); });
      await once(request, 'close');
      const page = await fetch(`${base}/api/jobs/${job.id}/results?limit=1`);
      assert.equal(page.status, 200);
      assert.equal((await page.json()).items.length, 1);
    }
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });
});
