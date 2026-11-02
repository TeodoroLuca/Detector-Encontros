import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../dist/src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');

test('importação aparece primeiro na navegação e na página', () => {
  const start = page.indexOf('<nav class="side-nav"');
  const end = page.indexOf('</nav>', start);
  const nav = page.slice(start, end);
  assert.match(nav, /class="nav-link active" href="#processamento"/);
  assert.ok(nav.indexOf('href="#processamento"') < nav.indexOf('href="#visao-geral"'));
  assert.ok(page.indexOf('id="processamento"') < page.indexOf('id="visao-geral"'));
  assert.ok(page.indexOf('id="visao-geral"') < page.indexOf('id="mapa"'));
  const ids = ['processamento', 'visao-geral', 'mapa', 'desempenho', 'resultados', 'validacao'];
  assert.deepEqual([...nav.matchAll(/<a\b[^>]*href="#([^"]+)"/g)].map(match => match[1]), ids);
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(packageInfo.version, '1.0.0');
  assert.equal(lock.version, packageInfo.version);
  assert.equal(lock.packages[''].version, packageInfo.version);
  assert.ok(page.includes(`class="version-label">v${packageInfo.version}</span>`));
});

test('marca reutiliza o favicon e remove aviso redundante do mapa', () => {
  assert.match(page, /class="brand-mark"><img src="\/favicon\.svg"/);
  assert.match(page, /class="topbar-favicon" src="\/favicon\.svg"/);
  assert.doesNotMatch(page, /Os pontos usam as coordenadas originais do dataset, inclusive no oceano/);
  assert.doesNotMatch(page, /class="map-aside-foot"/);
  assert.match(page, /https:\/\/www\.openstreetmap\.org\/copyright/);
});

test('estilo refinado e arquivo de ícone são servidos pelo Node.js', async (t) => {
  const server = createAppServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const css = await fetch(`${base}/refinement.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /--bg:#121316/);
  const icon = await fetch(`${base}/favicon.svg`);
  assert.equal(icon.status, 200);
  assert.match(await icon.text(), /<svg/);
});
