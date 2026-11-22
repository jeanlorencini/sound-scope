// Executa src/content/inject.js (mundo MAIN) e src/content/bridge.js (mundo isolado)
// em contextos vm separados que compartilham o mesmo document, com DOM e Web Audio simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../src/content/inject.js', import.meta.url), 'utf8');
const BRIDGE = readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8');

const FAKES = `
class HTMLMediaElement extends EventTarget {
  constructor() { super(); this._v = 1; this.plays = 0; this.events = 0;
    this.addEventListener('volumechange', () => this.events++); }
}
Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
  configurable: true, enumerable: true,
  get() { if (!(this instanceof HTMLMediaElement)) throw new TypeError('Illegal invocation'); return this._v; },
  set(v) {
    if (!(this instanceof HTMLMediaElement)) throw new TypeError('Illegal invocation');
    v = +v;
    if (!(v >= 0 && v <= 1)) throw new DOMException('range', 'IndexSizeError');
    if (v !== this._v) { this._v = v; this.dispatchEvent(new Event('volumechange')); }
  },
});
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true, enumerable: true, writable: true,
  value: function play() { this.plays++; return Promise.resolve(); },
});

class AudioNode {
  constructor(ctx) { this.context = ctx; this.outputs = new Set(); }
  connect(t) { this.outputs.add(t); return t; }
  disconnect(t) { if (t === undefined) this.outputs.clear(); else this.outputs.delete(t); }
}
class AudioDestinationNode extends AudioNode {}
class GainNode extends AudioNode {
  constructor(ctx, opts = {}) { super(ctx); this.gain = { value: opts.gain ?? 1, setTargetAtTime(v) { this.value = v; } }; }
}
class OscillatorNode extends AudioNode {}
class BaseAudioContext { constructor() { this.currentTime = 0; this.destination = new AudioDestinationNode(this); } }
class AudioContext extends BaseAudioContext {}
class OfflineAudioContext extends BaseAudioContext {}

var window = globalThis;
var __media = [];
var __windowListeners = [];
var __win = new EventTarget();
document.querySelectorAll = () => __media;
globalThis.addEventListener = (type, ...rest) => { __windowListeners.push(type); __win.addEventListener(type, ...rest); };
globalThis.dispatchEvent = (e) => __win.dispatchEvent(e);
Object.assign(globalThis, { HTMLMediaElement, AudioNode, AudioDestinationNode, GainNode, OscillatorNode,
  BaseAudioContext, AudioContext, OfflineAudioContext });
`;

// Classes de DOM novas a cada página, para que um patch da página num teste não vaze para outro.
function createDom() {
  class Node extends EventTarget {}
  class MouseEvent extends Event {
    #rt;
    constructor(type, init = {}) {
      super(type, init);
      this.#rt = init.relatedTarget ?? null;
    }
    get relatedTarget() {
      return this.#rt;
    }
  }
  class PageCustomEvent extends CustomEvent {}
  const document = new Node();
  document.createElement = () => new Node(); // nó destacado: não está em nenhuma árvore
  document.documentElement = new Node();
  // Simula a propagação de documentElement para document.
  document.documentElement.dispatchEvent = function (e) {
    const r = EventTarget.prototype.dispatchEvent.call(this, e);
    if (e.bubbles) document.dispatchEvent(new PageCustomEvent(e.type, { detail: e.detail }));
    return r;
  };
  return { Node, MouseEvent, CustomEvent: PageCustomEvent, document };
}

/**
 * Monta uma página. `order`:
 *  'inject-first' (padrão) | 'bridge-first' | 'inject-only' | 'none'
 */
function setup({ order = 'inject-first', before } = {}) {
  const dom = createDom();
  const base = { EventTarget, Event, DOMException, setTimeout, console, ...dom };
  const ctx = vm.createContext({ ...base });
  vm.runInContext(FAKES, ctx);
  const run = (code) => vm.runInContext(code, ctx);

  const hellos = [];
  ctx.__hello = hellos;
  run("document.addEventListener('soundscope:hello', () => __hello.push(1));");

  // Mundo isolado com um chrome.runtime simulado.
  const listeners = [];
  const iso = vm.createContext({
    ...base,
    chrome: {
      runtime: {
        id: 'ext',
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: () => Promise.resolve(undefined),
      },
    },
  });
  vm.runInContext('var window = globalThis; globalThis.addEventListener = () => {};', iso);
  const runBridge = () => vm.runInContext(BRIDGE, iso);
  const runInject = () => vm.runInContext(SOURCE, ctx);

  if (before) before({ run });
  if (order === 'inject-first') {
    runInject();
    runBridge();
  } else if (order === 'bridge-first') {
    runBridge();
    runInject();
  } else if (order === 'inject-only') {
    runInject();
  }

  // Ganho legítimo: chega do service worker pelo chrome.runtime.onMessage do bridge.
  const setGain = (g) => {
    for (const fn of listeners) fn({ type: 'gain', gain: g }, {}, () => {});
  };
  return { ctx, iso, run, setGain, hellos, runBridge, runInject, dom };
}

// Ataques da página: rodam no mundo MAIN.
const forgeAll = (run, detail) =>
  run(`
    for (const t of [document, window, document.documentElement]) {
      t.dispatchEvent(new CustomEvent('soundscope:gain', { detail: ${detail}, bubbles: true }));
    }`);

const tick = () => new Promise((r) => setTimeout(r, 5));

test('anuncia que carregou (hello) e escuta eventos de mídia na captura', () => {
  const { hellos, run } = setup();
  assert.equal(hellos.length, 1);
  assert.equal(run('__windowListeners.join()'), 'loadstart,play,playing,volumechange');
});

test('volume real = volume da página × fator, e a página continua vendo o seu valor', () => {
  const { run, setGain } = setup();
  run('el = new HTMLMediaElement(); el.volume = 0.8');
  assert.equal(run('el._v'), 0.8);
  setGain(0.5);
  assert.equal(run('el._v'), 0.4);
  assert.equal(run('el.volume'), 0.8);
  run('el.volume = 0.6');
  assert.equal(run('el._v'), 0.3);
  assert.equal(run('el.volume'), 0.6);
  setGain(1);
  assert.equal(run('el._v'), 0.6);
});

test('encontra mídia já no DOM ao mudar o fator', () => {
  const { run, setGain } = setup();
  run('dom = new HTMLMediaElement(); __media.push(dom)');
  setGain(0.25);
  assert.equal(run('dom._v'), 0.25);
  assert.equal(run('dom.volume'), 1);
});

test('mídia criada por script é ajustada antes de tocar', () => {
  const { run, setGain } = setup();
  setGain(0.5);
  run('a = new HTMLMediaElement(); a.play()');
  assert.equal(run('a.plays'), 1);
  assert.equal(run('a._v'), 0.5);
});

test('mantém as validações nativas do setter', () => {
  const { run } = setup();
  run('el = new HTMLMediaElement()');
  assert.throws(() => run('el.volume = 2'), (e) => e.name === 'IndexSizeError');
  assert.throws(() => run('el.volume = -0.1'), (e) => e.name === 'IndexSizeError');
  const isTypeError = (e) => e.name === 'TypeError';
  assert.throws(() => run('el.volume = NaN'), isTypeError);
  assert.throws(() => run('el.volume = Infinity'), isTypeError);
  assert.throws(() => run('HTMLMediaElement.prototype.volume'), isTypeError);
  assert.throws(() => run("Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').set.call({}, 0.5)"), isTypeError);
  assert.equal(run('el.volume'), 1);
});

test('com fator 0 a página ainda recebe volumechange ao mudar o próprio volume', async () => {
  const { run, setGain } = setup();
  run('el = new HTMLMediaElement(); el.volume = 0.5');
  setGain(0);
  assert.equal(run('el._v'), 0);
  const before = run('el.events');
  run('el.volume = 0.7');
  assert.equal(run('el._v'), 0);
  assert.equal(run('el.volume'), 0.7);
  await tick();
  assert.equal(run('el.events'), before + 1);
  setGain(1);
  assert.equal(run('el._v'), 0.7);
});

test('ignora fatores inválidos', () => {
  const { run, setGain } = setup();
  run('el = new HTMLMediaElement(); el.volume = 1');
  for (const bad of ['abc', NaN, undefined, {}, Infinity]) setGain(bad);
  assert.equal(run('el._v'), 1);
  setGain(0.5);
  assert.equal(run('el._v'), 0.5);
  setGain(5); // fora da faixa: o bridge limita a 0..1
  assert.equal(run('el._v'), 1);
});

test('Web Audio: conexões ao destino passam por um GainNode controlado', () => {
  const { run, setGain } = setup();
  setGain(0.3);
  run('ac = new AudioContext(); osc = new OscillatorNode(ac); ret = osc.connect(ac.destination)');
  assert.equal(run('ret === ac.destination'), true);
  assert.equal(run('osc.outputs.has(ac.destination)'), false);
  assert.equal(run('g = [...osc.outputs][0]; g instanceof GainNode && g.outputs.has(ac.destination)'), true);
  assert.equal(run('g.gain.value'), 0.3);

  run('osc2 = new OscillatorNode(ac); osc2.connect(ac.destination)');
  assert.equal(run('[...osc2.outputs][0] === g'), true, 'um GainNode por contexto');

  setGain(0.8);
  assert.equal(run('g.gain.value'), 0.8);

  run('osc.disconnect(ac.destination)');
  assert.equal(run('osc.outputs.size'), 0);
});

test('Web Audio: renderização offline não é afetada', () => {
  const { run, setGain } = setup();
  setGain(0.3);
  run('oc = new OfflineAudioContext(); n = new OscillatorNode(oc); n.connect(oc.destination)');
  assert.equal(run('n.outputs.has(oc.destination)'), true);
});

test('injetar duas vezes não aplica o fator em dobro', () => {
  const { ctx, run, setGain, hellos } = setup();
  const getter = run("Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').get");
  vm.runInContext(SOURCE, ctx);
  assert.equal(run("Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').get"), getter);
  assert.equal(hellos.length, 1);
  run('el = new HTMLMediaElement(); el.volume = 0.8');
  setGain(0.5);
  assert.equal(run('el._v'), 0.4);
});

// ---- Segurança do canal (Requisito #3, R1) ----------------------------------

test('CA1.1: a página não anula o mudo do usuário forjando soundscope:gain', () => {
  const { run, setGain } = setup();
  run('el = new HTMLMediaElement(); el.volume = 0.8; ac = new AudioContext(); o = new OscillatorNode(ac); o.connect(ac.destination); g = [...o.outputs]');
  setGain(0); // mudo do usuário, pelo canal legítimo
  assert.equal(run('el._v'), 0);
  forgeAll(run, 1);
  assert.equal(run('el._v'), 0, 'o volume real continua 0');
  assert.equal(run('el.volume'), 0.8);
  assert.equal(run('g[0].gain.value'), 0, 'o GainNode continua com ganho 0');
});

test('CA1.2: valores forjados não mudam um ganho parcial', () => {
  const { run, setGain } = setup();
  run('el = new HTMLMediaElement(); el.volume = 1');
  setGain(0.4);
  for (const detail of ['1', '0', '"1"', '{}', 'NaN']) forgeAll(run, detail);
  assert.equal(run('el._v'), 0.4);
});

test('CA1.3: hello/channel forjados depois do handshake não abrem canal novo', () => {
  const { run, setGain } = setup();
  run(`
    el = new HTMLMediaElement(); el.volume = 1;
    offers = 0;
    document.addEventListener('soundscope:channel', () => offers++);
    document.dispatchEvent(new CustomEvent('soundscope:hello'));
    mine = new Node();
    document.dispatchEvent(new MouseEvent('soundscope:channel', { relatedTarget: mine }));
    mine.dispatchEvent(new CustomEvent('soundscope:gain', { detail: 0 }));
  `);
  assert.equal(run('offers'), 1, 'só a oferta forjada pela própria página');
  assert.equal(run('el._v'), 1);
  setGain(0.5);
  assert.equal(run('el._v'), 0.5, 'o canal legítimo continua valendo');
  run("mine.dispatchEvent(new CustomEvent('soundscope:gain', { detail: 1 }))");
  assert.equal(run('el._v'), 0.5);
});

test('CA1.3: patch da página em CustomEvent.detail não altera o ganho legítimo', () => {
  const { run, setGain } = setup();
  run(`el = new HTMLMediaElement(); el.volume = 1;
    Object.defineProperty(CustomEvent.prototype, 'detail', { get() { return 1; } });`);
  setGain(0);
  assert.equal(run('el._v'), 0);
});

test('CA1.4: canal funciona com inject antes ou depois do bridge', () => {
  for (const order of ['inject-first', 'bridge-first']) {
    const { run, setGain } = setup({ order });
    run('el = new HTMLMediaElement(); el.volume = 0.8');
    setGain(0.5);
    assert.equal(run('el._v'), 0.4, order);
  }
});

test('CA1.4: bridge reinjetado (extensão atualizada) reaproveita o canal', () => {
  const { run, iso, runBridge, setGain } = setup();
  run('el = new HTMLMediaElement(); el.volume = 1');
  // A cópia anterior perdeu o contexto da extensão.
  vm.runInContext('chrome.runtime.id = undefined', iso);
  run("offers = 0; document.addEventListener('soundscope:channel', () => offers++)");
  vm.runInContext("chrome.runtime.id = 'ext2'", iso);
  runBridge();
  assert.equal(run('offers'), 0, 'nenhuma oferta nova no document');
  setGain(0.25);
  assert.equal(run('el._v'), 0.25);
});

test('CA1.4: modo legado envia pelo document para o inject.js 1.0.0', () => {
  const { run, runBridge, setGain } = setup({
    order: 'none',
    before: ({ run }) =>
      run(`legacy = []; document.addEventListener('soundscope:gain', (e) => legacy.push(e.detail));
        window[Symbol.for('soundscope.inject.v1')] = true;`),
  });
  run('legacy = []');
  runBridge();
  setGain(0.3);
  assert.equal(run('JSON.stringify(legacy)'), '[0.3]');
});

test('CA1.7: depois do handshake a página não lê o ganho no document', () => {
  const { run, setGain } = setup();
  run(`seen = [];
    for (const t of ['soundscope:gain', 'soundscope:channel']) document.addEventListener(t, (e) => seen.push(t));`);
  setGain(0.2);
  setGain(0);
  assert.equal(run('JSON.stringify(seen)'), '[]');
});

test('R-1 (risco residual): na reinjeção tardia, uma oferta antecipada pela página é aceita', () => {
  // Documenta o comportamento: a página que se preparou antes da injeção controla o canal
  // daquela aba até recarregar; a oferta legítima posterior é ignorada.
  const { run, runBridge, setGain } = setup({ order: 'inject-only' });
  run(`el = new HTMLMediaElement(); el.volume = 1; mine = new Node();
    document.dispatchEvent(new MouseEvent('soundscope:channel', { relatedTarget: mine }));`);
  runBridge();
  setGain(0);
  assert.equal(run('el._v'), 1, 'o ganho legítimo não chega');
  run("mine.dispatchEvent(new CustomEvent('soundscope:gain', { detail: 0.1 }))");
  assert.equal(run('el._v'), 0.1);
});
