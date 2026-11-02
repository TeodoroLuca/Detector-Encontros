import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../dist/web/map.js', import.meta.url), 'utf8');
const world = JSON.parse(fs.readFileSync(new URL('../web/world.json', import.meta.url), 'utf8'));

// Exercise the production canvas controller without network requests or a browser dependency.
async function mapContext({ countries = world, contextAvailable = true } = {}) {
  class Element {
    constructor() {
      this.style = {};
      this.hidden = true;
      this.children = [];
      this.listeners = new Map();
      this.offsetWidth = 180;
      this.offsetHeight = 50;
    }
    addEventListener(name, callback) {
      const list = this.listeners.get(name) ?? [];
      list.push(callback);
      this.listeners.set(name, list);
    }
    emit(name, properties = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...properties };
      for (const callback of this.listeners.get(name) ?? []) callback(event);
      return event;
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 700, height: 420 }; }
    setPointerCapture() {}
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
  }
  const calls = [];
  const context = new Proxy({}, {
    get(target, name) {
      if (name === 'createRadialGradient') return () => ({ addColorStop() {} });
      return target[name] ?? ((...args) => calls.push([name, ...args]));
    }
  });
  const images = [];
  class Image {
    constructor() { images.push(this); }
  }
  const frames = [];
  const canvas = new Element();
  canvas.parentElement = new Element();
  canvas.getContext = () => contextAvailable ? context : null;
  const tooltip = new Element();
  const scale = new Element();
  const sandbox = vm.createContext({
    window: { devicePixelRatio: 1 }, Image,
    ResizeObserver: class { observe() {} },
    requestAnimationFrame(callback) { frames.push(callback); },
    fetch: async () => ({ ok: true, json: async () => countries }),
    document: { createElement: () => new Element(), getElementById: () => scale }
  });
  // The only runtime export is the class; its global compatibility alias is also tested.
  vm.runInContext(source.replace(/\bexport class EncounterMap/, 'class EncounterMap'), sandbox);
  const map = new sandbox.window.EncounterMap(canvas, tooltip);
  await new Promise(resolve => setImmediate(resolve));
  return { map, canvas, tooltip, scale, images, calls, flushFrames() { while (frames.length) frames.shift()(); } };
}

function encounter(tipo = 'generico', lon = -49.3, lat = -25.5, first = 1) {
  return {
    tipo, monitoradosEncontro: [first, first + 1], timestamp: '2024-01-01 00:00:00',
    posicoes: { [first]: { lat, lon }, [first + 1]: { lat, lon: lon + 0.00001 } },
    distanciaMetros: 1.003665
  };
}

test('mapa técnico carrega cartografia local, mantém coordenadas e filtra sem solicitar tiles', async () => {
  const { map, images, scale } = await mapContext();
  const rows = [encounter(), encounter('faccao', -43.2, -22.9, 3), encounter('protetiva', -47.9, -15.8, 5)];
  const before = JSON.stringify(rows);
  map.setMode('tecnico');
  map.setData(rows);
  assert.equal(map.countries.length, world.length);
  assert.equal(map.visibleData.length, 3);
  assert.equal(images.length, 0);
  assert.equal(JSON.stringify(rows), before, 'campos internos do mapa não contaminam o JSON oficial');
  assert.match(scale.textContent, /100 px/);
  map.setFilter('faccao');
  assert.equal(map.visibleData.length, 1);
  assert.equal(map.visibleData[0].monitoradosEncontro[0], 3);
  map.setFilter('');
  assert.equal(map.visibleData.length, 3);
  map.setData([]);
  assert.equal(map.hitTargets.length, 0);
  assert.equal(map.selectedItem, null);
});

test('enquadramento cruza o antimeridiano pelo menor intervalo e suporta regiões polares', async () => {
  const { map } = await mapContext();
  map.setMode('tecnico');
  const crossing = encounter();
  crossing.posicoes[1] = { lat: 0, lon: 179.99999 };
  crossing.posicoes[2] = { lat: 0, lon: -179.99999 };
  map.setData([crossing]);
  assert.ok(Math.abs(Math.abs(map.visibleData[0]._location.lon) - 180) < 1e-10);
  assert.ok(Math.min(map.camera.x, 1 - map.camera.x) < 0.001);
  // O enquadramento original reserva 105 px e uma extensão mínima de 0,00001.
  // Em um canvas de 700 × 420, isso produz ~15,91, e não zoom 16.
  assert.ok(Math.abs(map.camera.zoom - 15.90884849282409) < 1e-12);
  for (const latitude of [-90, 90]) {
    map.setData([encounter('generico', 0, latitude)]);
    assert.ok(Number.isFinite(map.camera.x));
    assert.ok(Number.isFinite(map.camera.y));
    assert.ok(Number.isFinite(map.camera.zoom));
  }
});

test('mapa responde a mouse, toque, teclado, seleção e redimensionamento', async () => {
  const { map, canvas, tooltip } = await mapContext();
  map.setMode('tecnico');
  map.setData([encounter()]);
  const marker = map.hitTargets[0];
  assert.ok(marker);
  let selection;
  map.onSelect = row => { selection = row; map.focus(row); };
  canvas.emit('pointermove', { pointerId: 1, clientX: marker.x, clientY: marker.y });
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.children[0].textContent, /IDs 1 e 2/);
  const touch = { pointerId: 1, pointerType: 'touch', button: 0, clientX: marker.x, clientY: marker.y };
  canvas.emit('pointerdown', touch);
  canvas.emit('pointerup', touch);
  assert.equal(selection.monitoradosEncontro[0], 1);
  assert.equal(map.selectedItem, selection);
  const zoom = map.camera.zoom;
  const wheel = canvas.parentElement.emit('wheel', { target: canvas, deltaY: -100, clientX: 350, clientY: 210 });
  assert.equal(wheel.defaultPrevented, true);
  assert.ok(map.camera.zoom > zoom);
  const position = map.camera.x;
  canvas.parentElement.emit('keydown', { key: 'ArrowRight' });
  assert.notEqual(map.camera.x, position);
  const movedFrom = map.camera.x;
  canvas.emit('pointerdown', { ...touch, pointerId: 2 });
  canvas.emit('pointermove', { ...touch, pointerId: 2, clientX: marker.x + 30 });
  canvas.emit('pointercancel', { pointerId: 2 });
  assert.notEqual(map.camera.x, movedFrom);
  assert.equal(map.pointers.size, 0);
  assert.equal(map.drag, null);
  map.resize();
  assert.equal(canvas.width, 700);
  for (const listeners of canvas.listeners.values()) assert.equal(listeners.length, 1);
});

test('modo geográfico limita cache e mantém fallback local após falha dos tiles', async () => {
  const { map, images, flushFrames, calls } = await mapContext();
  map.setData([encounter()]);
  assert.ok(images.length > 0);
  assert.ok(images.every(image => /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(image.src)));
  assert.ok(images.every(image => image.referrerPolicy === 'strict-origin-when-cross-origin'));
  assert.equal(map.tileStatus, 'loading');
  for (const image of images) image.onerror();
  flushFrames();
  assert.equal(map.tileStatus, 'unavailable');
  assert.ok(map.countries.length > 0);
  assert.ok(map.hitTargets.length > 0);
  images[0].onload();
  flushFrames();
  assert.equal(map.tileStatus, 'ready');
  assert.ok(calls.some(([method]) => method === 'drawImage'));
  for (let index = 0; index < 25; index++) map.panBy(600, 0);
  assert.ok(map.tileCache.size <= 160);
  const requests = images.length;
  map.setMode('tecnico');
  map.panBy(100, 0);
  map.zoomBy(1);
  assert.equal(images.length, requests);
});

test('mapa ignora geometria externa malformada e trata canvas indisponível', async () => {
  const { map } = await mapContext({ countries: [{ r: [[['longitude inválida', null]]] }] });
  assert.equal(map.countries.length, 0);
  map.setMode('tecnico');
  map.setData([encounter()]);
  assert.equal(map.visibleData.length, 1);
  await assert.rejects(mapContext({ contextAvailable: false }), /inicializar o mapa/);
});

test('pré-validação enfileira sete arquivos e descarta respostas de arquivos removidos', async () => {
  const appSource = fs.readFileSync(new URL('../dist/web/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/\binit\(\);\s*(?=\/\/# sourceMappingURL=|$)/, '');
  const requests = [];
  let active = 0, peak = 0;
  const sandbox = vm.createContext({
    fetch: async (url, options) => {
      active++;
      peak = Math.max(peak, active);
      return new Promise(resolve => requests.push({ url, file: options.body, resolve: () => {
        active--;
        resolve({ ok: true, json: async () => ({ filename: options.body.name, size: options.body.size, inspection: {
          valid: true, count: 2, duplicated: 0, timestamps: 1, uniqueIds: 2,
          firstTimestamp: '2024-01-01 00:00:00', lastTimestamp: '2024-01-01 00:00:00',
          headerPresent: true, errorCount: 0, issues: [], sample: []
        } }) });
      } }));
    }
  });
  // Removemos só a inicialização visual; as funções de fila e o contrato HTTP são os de produção.
  vm.runInContext(appSource + '\nrenderFiles = () => {}; globalThis.harness = { state, addFiles, queueInspection, fileKey };', sandbox);
  const { state, addFiles, queueInspection, fileKey } = sandbox.harness;
  state.limits = { maxUploadBytes: 10 * 1073741824, maxRecords: 20000000, maxConcurrentJobs: 1, requestTimeoutMs: 900000 };
  const files = Array.from({ length: 7 }, (_, i) => ({ name: `dataset${i + 1}.txt`, size: 100, lastModified: 1 }));
  addFiles(files);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(state.inspections.size, 7);
  // Remover o primeiro (em voo) e o terceiro (pendente) antes de suas respostas.
  state.files.splice(state.files.indexOf(files[2]), 1);
  state.inspections.delete(fileKey(files[2]));
  state.files.splice(state.files.indexOf(files[0]), 1);
  state.inspections.delete(fileKey(files[0]));
  const replacement = { ...files[0] };
  addFiles([replacement]);
  queueInspection(replacement); // Repetir a ação não deve criar uma requisição duplicada.
  for (let i = 0; i < 7; i++) {
    assert.ok(requests[i], `requisição ${i + 1}`);
    requests[i].resolve();
    await new Promise(resolve => setImmediate(resolve));
    if (i === 0) assert.equal(state.inspections.get(fileKey(replacement)).status, 'pending');
  }
  assert.equal(peak, 1);
  assert.equal(requests.length, 7);
  assert.equal(requests.some(request => request.file === files[2]), false);
  assert.equal(requests.at(-1).file, replacement);
  assert.equal(state.inspections.size, 6);
  assert.equal([...state.inspections.values()].every(result => result.status === 'valid'), true);
  assert.equal(state.inspectionQueue.length, 0);
  assert.equal(state.inspecting, false);
});
