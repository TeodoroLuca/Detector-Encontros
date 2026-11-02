import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../dist/src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = fs.readFileSync(path.join(root, 'exemplos', 'exemplo.txt'));

async function start() {
  const server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('API e frontend: importação TXT, resumo, filtros, exportação JSON', async () => {
  const { server, base } = await start();
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const html = await (await fetch(base)).text();
    assert.match(html, /Detector de Encontros/);
    assert.match(html, /id="file-input"/);
    const javascript = await fetch(`${base}/app.js`);
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get('content-type'), /javascript/);

    const post = await fetch(`${base}/api/process?filename=exemplo.txt&genericPolicy=all&mode=unordered`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: example
    });
    assert.equal(post.status, 201, await post.text().catch(() => ''));
  } finally { await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
});

test('API: paginação, filtros, distância e arquivo exportável', async () => {
  const { server, base } = await start();
  try {
    const response = await fetch(`${base}/api/process?filename=exemplo.txt`, { method: 'POST', body: example });
    assert.equal(response.status, 201);
    const { job } = await response.json();
    assert.equal(job.encounters, 6);
    assert.deepEqual(job.byType, { generico: 4, faccao: 1, protetiva: 1 });
    assert.equal(job.timestamps, 2);
    const list = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(list.jobs.length, 1);

    const page = await (await fetch(`${base}/api/jobs/${job.id}/results?offset=0&limit=2`)).json();
    assert.equal(page.total, 6);
    assert.equal(page.items.length, 2);
    assert.ok(page.items.every(e => e.distanciaMetros < 20));
    const protect = await (await fetch(`${base}/api/jobs/${job.id}/results?type=protetiva&search=40`)).json();
    assert.equal(protect.total, 1);
    assert.deepEqual(protect.items[0].monitoradosEncontro, [40, 100]);
    const none = await (await fetch(`${base}/api/jobs/${job.id}/results?search=nao-existe`)).json();
    assert.equal(none.total, 0);
    const exported = await fetch(`${base}/api/jobs/${job.id}/download`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /exemplo.json/);
    assert.equal((await exported.json()).length, 6);
    const missing = await fetch(`${base}/api/jobs/00000000-0000-0000-0000-000000000000/download`);
    assert.equal(missing.status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('API: recusa arquivos inválidos e modo ordenado incorreto', async () => {
  const { server, base } = await start();
  try {
    const badName = await fetch(`${base}/api/process?filename=exemplo.js`, { method: 'POST', body: example });
    assert.equal(badName.status, 400);
    const malformed = await fetch(`${base}/api/process?filename=entrada.txt`, { method: 'POST', body: 'linha inválida' });
    assert.equal(malformed.status, 400);
    const outOfOrder = ['idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida', '1;A;2026-10-01 00:00:05;0;0;false;', '2;A;2026-10-01 00:00:00;0;0;false;'].join('\n');
    const wrongMode = await fetch(`${base}/api/process?filename=entrada.txt&mode=sorted`, { method: 'POST', body: outOfOrder });
    assert.equal(wrongMode.status, 400);
    const list = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(list.jobs.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
