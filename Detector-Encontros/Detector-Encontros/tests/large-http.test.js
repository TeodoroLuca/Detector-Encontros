import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createAppServer } from '../dist/src/server.js';

const MIB = 1024 * 1024;
const dataset = Buffer.from([
  'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida',
  '1;;2024-01-01 00:00:00;0;0;false;',
  '2;;2024-01-01 00:00:00;0;0.00001;false;', ''
].join('\n'));

async function withServer(options, operation) {
  const server = createAppServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await operation(`http://127.0.0.1:${server.address().port}`, server); }
  finally {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('HTTP: health anuncia limites suficientes para datasets 6 e 7 e permite configuração', async () => {
  await withServer({}, async (base, server) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.limits.maxUploadBytes, 10_240 * MIB);
    assert.equal(health.limits.maxRecords, 20_000_000);
    assert.equal(health.limits.maxConcurrentJobs, 1);
    assert.equal(health.limits.requestTimeoutMs, 900_000);
    assert.equal(server.requestTimeout, health.limits.requestTimeoutMs);
    assert.equal(server.timeout, 0, 'recebimento e processamento têm controles distintos');
  });
  const limits = { maxUploadBytes: 200, maxRecords: 123, maxConcurrentJobs: 2, requestTimeoutMs: 60_000 };
  await withServer(limits, async base => {
    assert.deepEqual((await (await fetch(`${base}/api/health`)).json()).limits, limits);
  });
  for (const requestTimeoutMs of [0, -1, Infinity, NaN, 1.5]) {
    assert.throws(() => createAppServer({ requestTimeoutMs }), /inteiro positivo/);
  }
});

test('HTTP: rejeição antecipada retorna JSON sem reset durante upload ainda incompleto', async () => {
  await withServer({ maxUploadBytes: 1024 }, async base => {
    const result = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/api/inspect?filename=grande.txt`, {
        method: 'POST', headers: { 'Content-Length': 2 * MIB }
      });
      request.once('error', reject);
      request.once('response', response => {
        const parts = [];
        response.on('data', part => parts.push(part));
        response.once('error', reject);
        response.once('end', () => {
          resolve({ status: response.statusCode, connection: response.headers.connection, body: JSON.parse(Buffer.concat(parts).toString('utf8')) });
          request.destroy();
        });
      });
      // Não finaliza o corpo: o cliente deve conseguir ler o erro antes do envio completo.
      request.write(Buffer.alloc(256, 32));
    });
    assert.equal(result.status, 413);
    assert.notEqual(result.connection, 'close');
    assert.match(result.body.error, /limite/);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
  });
});

test('HTTP: upload real acima do antigo limite de 100 MiB é recebido em streaming', { timeout: 120_000 }, async () => {
  await withServer({}, async base => {
    // Um bloco reutilizado: não aloca nem guarda o upload inteiro no cliente.
    // Linhas em branco são permitidas e não alteram a contagem dos dois registros.
    const padding = Buffer.from(`${' '.repeat(1023)}\n`.repeat(64));
    const chunks = 102 * MIB / padding.length;
    async function* body() {
      yield dataset;
      for (let i = 0; i < chunks; i++) yield padding;
    }
    const response = await fetch(`${base}/api/process?filename=grande.txt`, {
      method: 'POST', headers: { 'Content-Length': dataset.length + chunks * padding.length },
      body: Readable.from(body()), duplex: 'half'
    });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.job.size, dataset.length + 102 * MIB);
    assert.equal(payload.job.count, 2);
    assert.equal(payload.job.encounters, 1);
    const result = await (await fetch(`${base}/api/jobs/${payload.job.id}/download`)).json();
    assert.deepEqual(result[0].monitoradosEncontro, [1, 2]);
    assert.ok(result[0].distanciaMetros < 20);
  });
});
