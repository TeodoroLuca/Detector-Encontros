import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../dist/web/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace(/\binit\(\);\s*(?=\/\/# sourceMappingURL=|$)/, '');

function harness() {
  const ids = ['processamento', 'visao-geral', 'mapa', 'desempenho', 'resultados', 'validacao'];
  const positions = [250, 950, 1140, 1800, 2180, 2700];
  const frames = [], observers = [];
  const listeners = new Map();
  let mobile = false;
  const win = { scrollY: 0, innerHeight: 800, matchMedia: () => ({ matches: mobile }),
    addEventListener(name, callback) { const list = listeners.get(name) ?? []; list.push(callback); listeners.set(name, list); } };
  function element(localName) {
    const attributes = new Map(), events = new Map(), classes = new Set();
    return { localName, attributes, hidden: true, textContent: '',
      classList: { contains: key => classes.has(key), toggle(key, value = !classes.has(key)) { value ? classes.add(key) : classes.delete(key); } },
      setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key), getAttribute: key => attributes.get(key),
      addEventListener: (name, callback) => events.set(name, callback), click() { events.get('click')?.(); } };
  }
  const links = ids.map((id, index) => {
    const link = element('a'); link.setAttribute('href', `#${id}`); link.querySelector = () => ({ textContent: id });
    return { link, section: { getBoundingClientRect: () => ({ top: positions[index] - win.scrollY }) } };
  });
  const nodes = new Map([['sidebar-overlay', element('div')], ['sidebar-toggle', element('button')], ['mobile-menu', element('button')], ['current-section', element('strong')]]);
  const document = { body: element('body'), documentElement: { scrollHeight: 3200 }, getElementById: id => nodes.get(id),
    querySelectorAll: () => links.map(entry => entry.link), querySelector: selector => selector === '.topbar' ? { getBoundingClientRect: () => ({ bottom: 60 }) }
      : selector === '.content' ? {} : links[ids.indexOf(selector.slice(1))]?.section };
  const ResizeObserver = class { constructor(callback) { observers.push(callback); } observe() {} };
  win.ResizeObserver = ResizeObserver;
  const context = vm.createContext({ window: win, document, ResizeObserver, localStorage: { getItem() { return null; }, setItem() {} }, requestAnimationFrame: callback => frames.push(callback) });
  vm.runInContext(source + '\nsetupNavigation();', context);
  const flush = () => { while (frames.length) frames.shift()(); };
  const scroll = value => { win.scrollY = value; for (const callback of listeners.get('scroll') ?? []) callback(); };
  const active = () => links.filter(entry => entry.link.classList.contains('active')).map(entry => entry.link.getAttribute('href'));
  return { links, nodes, document, positions, frames, observers, scroll, flush, active, setMobile(value) { mobile = value; } };
}

test('menu acompanha rolagem nos dois sentidos, seções curtas e final da página', () => {
  const h = harness();
  assert.deepEqual(h.active(), ['#processamento']);
  h.positions[1] = 950.4;
  h.scroll(866); h.flush();
  assert.deepEqual(h.active(), ['#visao-geral']);
  for (const [position, expected] of [[1000, '#visao-geral'], [1100, '#mapa'], [1720, '#desempenho'], [2100, '#resultados'], [2400, '#validacao'], [1100, '#mapa'], [0, '#processamento']]) {
    h.scroll(position); h.flush(); assert.deepEqual(h.active(), [expected]);
    const active = h.links.find(entry => entry.link.getAttribute('href') === expected);
    assert.equal(active.link.getAttribute('aria-current'), 'location');
    assert.equal(h.links.filter(entry => entry.link.attributes.has('aria-current')).length, 1);
  }
});

test('menu agrupa eventos em um frame e recalcula após mudança de altura do conteúdo', () => {
  const h = harness();
  h.scroll(1000); h.scroll(1200); h.scroll(1800);
  assert.equal(h.frames.length, 1);
  h.flush(); assert.deepEqual(h.active(), ['#desempenho']);
  h.positions[3] = 2200;
  h.observers[0](); h.flush();
  assert.deepEqual(h.active(), ['#mapa']);
});

test('menu continua sincronizado recolhido e fecha a navegação móvel ao selecionar seção', () => {
  const h = harness();
  h.nodes.get('sidebar-toggle').click();
  assert.equal(h.document.body.classList.contains('sidebar-collapsed'), true);
  h.scroll(1720); h.flush(); assert.deepEqual(h.active(), ['#desempenho']);
  h.setMobile(true); h.nodes.get('mobile-menu').click();
  assert.equal(h.document.body.classList.contains('menu-open'), true);
  h.scroll(2100); h.flush(); assert.deepEqual(h.active(), ['#desempenho']);
  h.links[4].link.click(); h.flush();
  assert.equal(h.document.body.classList.contains('menu-open'), false);
  assert.deepEqual(h.active(), ['#resultados']);
  assert.equal(h.nodes.get('mobile-menu').getAttribute('aria-expanded'), 'false');
});
