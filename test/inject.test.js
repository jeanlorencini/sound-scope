// Executa src/content/inject.js num contexto vm com DOM e Web Audio simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../src/content/inject.js', import.meta.url), 'utf8');

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
var document = new EventTarget();
document.querySelectorAll = () => __media;
globalThis.addEventListener = (type, fn) => __windowListeners.push(type);
Object.assign(globalThis, { HTMLMediaElement, AudioNode, AudioDestinationNode, GainNode, OscillatorNode,
  BaseAudioContext, AudioContext, OfflineAudioContext });
`;

function setup() {
  const ctx = vm.createContext({ EventTarget, Event, CustomEvent, DOMException, setTimeout, console });
  vm.runInContext(FAKES, ctx);
  const hellos = [];
  vm.runInContext("document.addEventListener('soundscope:hello', () => __hello.push(1));", Object.assign(ctx, { __hello: hellos }));
  vm.runInContext(SOURCE, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const setGain = (g) => run(`document.dispatchEvent(new CustomEvent('soundscope:gain', { detail: ${JSON.stringify(g)} }))`);
  return { ctx, run, setGain, hellos };
}

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
  for (const bad of [5, -1, 'abc', '0.5', null, NaN]) setGain(bad);
  assert.equal(run('el._v'), 1);
  setGain(0.5);
  assert.equal(run('el._v'), 0.5);
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
