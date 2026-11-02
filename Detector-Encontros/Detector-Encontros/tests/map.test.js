import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../dist/src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = fs.readFileSync(path.join(root, 'exemplos', 'exemplo.txt'));

async function withServer(fn) {
  const server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Frontend premium, mapa local e menu expansível são servidos sem CDN', async () => {
  await withServer(async base => {
    for (const resource of ['/', '/styles.css', '/premium.css', '/map.js', '/app.js', '/world.json', '/favicon.svg']) {
      const response = await fetch(base + resource);
      assert.equal(response.status, 200, resource);
      const content = await response.text();
      assert.ok(content.length > 100, resource);
      assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    }
    const html = await (await fetch(base)).text();
    assert.match(html, /id="mapa"/);
    assert.match(html, /id="sidebar-toggle"/);
    assert.match(html, /id="mobile-menu"/);
    const source = await (await fetch(base + '/map.js')).text();
    assert.match(source, /window\.EncounterMap/);
  });
});

test('API do mapa retorna posições reais sem alterar JSON oficial', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/process?filename=exemplo.txt`, { method: 'POST', body: example });
    assert.equal(response.status, 201);
    const { job } = await response.json();
    const payload = await (await fetch(`${base}/api/jobs/${job.id}/map`)).json();
    const official = await (await fetch(`${base}/api/jobs/${job.id}/download`)).json();
    assert.equal(payload.total, 6);
    assert.equal(payload.displayed, 6);
    assert.equal(payload.sampled, false);
    assert.deepEqual(payload.items, official);
    assert.ok(payload.items.every(e => e.distanciaMetros < 20));
    const missing = await fetch(`${base}/api/jobs/00000000-0000-0000-0000-000000000000/map`);
    assert.equal(missing.status, 404);
  });
});

test('Mapa usa amostra até 750, mas o arquivo oficial mantém todos os encontros', async () => {
  const header = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';
  const lines = [header, ...Array.from({ length: 40 }, (_, n) => `${n + 1};;"2024-01-01 00:00:00";-25.50000;-49.30000;false;`)];
  await withServer(async base => {
    const processed = await fetch(`${base}/api/process?filename=grupo.txt`, {
      method: 'POST', body: lines.join('\n'), headers: { 'Content-Type': 'text/plain' }
    });
    assert.equal(processed.status, 201);
    const { job } = await processed.json();
    assert.equal(job.encounters, 780);
    const display = await (await fetch(`${base}/api/jobs/${job.id}/map`)).json();
    assert.equal(display.total, 780);
    assert.equal(display.displayed, 750);
    assert.equal(display.sampled, true);
    const output = await (await fetch(`${base}/api/jobs/${job.id}/download`)).json();
    assert.equal(output.length, 780);
    assert.deepEqual(Object.keys(output[0]), ['tipo','monitoradosEncontro','timestamp','posicoes','distanciaMetros']);
  });
});

test('Seletor cartográfico preserva o modo técnico offline e permite OSM na área visível', async () => {
  await withServer(async base => {
    const html = await (await fetch(base)).text();
    assert.match(html, /id="map-geographic"/);
    assert.match(html, /id="map-technical"/);
    assert.match(html, /id="map-attribution"/);
    assert.match(html, /openstreetmap\.org\/copyright/);
    const source = await (await fetch(base + '/map.js')).text();
    assert.match(source, /setMode\(mode\)/);
    assert.match(source, /this\.mode === 'tecnico'/);
    assert.match(source, /https:\/\/tile\.openstreetmap\.org\/\$\{key\}\.png/);
    assert.match(source, /this\.drawSelectedPair\(c\)/);
    assert.match(source, /geoPair\(item\)/);
    assert.doesNotMatch(source, /fetch\(['"]https:\/\/tile\.openstreetmap/);
    const css = await (await fetch(base + '/premium.css')).text();
    assert.match(css, /\.map-mode-button\.active/);
  });
});

test('Política de segurança permite somente tiles OSM e encaminha referer', async () => {
  await withServer(async base => {
    const r = await fetch(base + '/');
    assert.match(r.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/tile\.openstreetmap\.org/);
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.doesNotMatch(r.headers.get('content-security-policy'), /script-src [^;]*https:/);
  });
});
