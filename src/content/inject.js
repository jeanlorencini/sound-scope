// SoundScope — roda no mundo da página (MAIN) em document_start.
// Aplica um fator de ganho (0..1) a todo áudio da página sem que o site perceba:
//  • <audio>/<video>: o volume real = volume pedido pela página × fator.
//    O getter de `volume` continua devolvendo o valor que a página definiu,
//    então os controles do player do site não "pulam".
//  • Web Audio: conexões ao destino passam por um GainNode por contexto.
// Recebe o fator do script isolado (bridge.js) só por um nó privado (fora do DOM),
// entregue uma única vez num handshake em document_start. Eventos que a página
// dispara no document, no window ou em outros nós são ignorados.
(() => {
  'use strict';

  const GUARD = Symbol.for('soundscope.inject.v1');
  if (window[GUARD]) return;
  Object.defineProperty(window, GUARD, { value: true });

  const EVT_GAIN = 'soundscope:gain';
  const EVT_HELLO = 'soundscope:hello';
  const EVT_CHANNEL = 'soundscope:channel';
  const EVT_READY = 'soundscope:ready';

  // Nativos guardados antes de qualquer script da página: um patch posterior não intercepta o canal.
  const getterOf = (proto, name) => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (d) return d.get;
    }
  };
  const ET = window.EventTarget && window.EventTarget.prototype;
  const nativeOn = ET && ET.addEventListener;
  const nativeOff = ET && ET.removeEventListener;
  const nativeDispatch = ET && ET.dispatchEvent;
  const NodeCtor = window.Node;
  const CustomEventCtor = window.CustomEvent;
  const relatedTargetOf = window.MouseEvent && getterOf(window.MouseEvent.prototype, 'relatedTarget');
  const detailOf = CustomEventCtor && getterOf(CustomEventCtor.prototype, 'detail');
  if (!nativeOn || !NodeCtor || !relatedTargetOf || !detailOf) return;

  const MediaProto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  const volumeDesc = MediaProto && Object.getOwnPropertyDescriptor(MediaProto, 'volume');
  if (!volumeDesc || !volumeDesc.get || !volumeDesc.set) return;

  const nativeGetVolume = volumeDesc.get;
  const nativeSetVolume = volumeDesc.set;
  const EPS = 1e-6;

  let gain = 1;

  // ---- <audio>/<video> -----------------------------------------------------
  const wanted = new WeakMap(); // elemento -> volume que a página pediu
  const tracked = new WeakSet();
  const refs = new Set(); // WeakRef<HTMLMediaElement>

  const track = (el) => {
    if (tracked.has(el)) return;
    tracked.add(el);
    refs.add(new WeakRef(el));
    if (!wanted.has(el)) wanted.set(el, nativeGetVolume.call(el));
  };

  const apply = (el) => {
    const target = wanted.get(el) * gain;
    if (Math.abs(nativeGetVolume.call(el) - target) > EPS) nativeSetVolume.call(el, target);
  };

  const accessors = {
    get volume() {
      return wanted.has(this) ? wanted.get(this) : nativeGetVolume.call(this);
    },
    set volume(value) {
      const n = +value;
      if (!Number.isFinite(n)) {
        throw new TypeError(
          "Failed to set the 'volume' property on 'HTMLMediaElement': The provided double value is non-finite."
        );
      }
      if (n < 0 || n > 1) {
        throw new DOMException(
          `Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${n}) is outside the range [0, 1].`,
          'IndexSizeError'
        );
      }
      const before = nativeGetVolume.call(this); // também valida o `this` (Illegal invocation)
      const previous = wanted.has(this) ? wanted.get(this) : before;
      wanted.set(this, n);
      track(this);
      apply(this);
      // Com fator 0 o volume real não muda; avisa a página mesmo assim, como o navegador faria.
      if (previous !== n && Math.abs(nativeGetVolume.call(this) - before) <= EPS) {
        const el = this;
        setTimeout(() => el.dispatchEvent(new Event('volumechange')), 0);
      }
    },
  };
  const patched = Object.getOwnPropertyDescriptor(accessors, 'volume');
  Object.defineProperty(MediaProto, 'volume', {
    configurable: volumeDesc.configurable,
    enumerable: volumeDesc.enumerable,
    get: patched.get,
    set: patched.set,
  });

  // Mídia criada por script e tocada fora do DOM (new Audio().play()).
  const playDesc = Object.getOwnPropertyDescriptor(MediaProto, 'play');
  if (playDesc && typeof playDesc.value === 'function') {
    const nativePlay = playDesc.value;
    const wrapped = {
      play() {
        try {
          track(this);
          apply(this);
        } catch {
          /* `this` inválido: deixa o play nativo lançar o erro correto */
        }
        return nativePlay.apply(this, arguments);
      },
    }.play;
    Object.defineProperty(MediaProto, 'play', { ...playDesc, value: wrapped });
  }

  // Mídia no DOM: eventos de mídia não borbulham, mas passam pela fase de captura.
  const onMediaEvent = (event) => {
    const el = event.target;
    if (el instanceof HTMLMediaElement && !tracked.has(el)) {
      track(el);
      apply(el);
    }
  };
  for (const type of ['loadstart', 'play', 'playing', 'volumechange']) {
    window.addEventListener(type, onMediaEvent, { capture: true, passive: true });
  }

  const applyAll = () => {
    for (const el of document.querySelectorAll('audio, video')) track(el);
    for (const ref of refs) {
      const el = ref.deref();
      if (el) apply(el);
      else refs.delete(ref);
    }
  };

  // ---- Web Audio ------------------------------------------------------------
  const gainNodes = new Set(); // WeakRef<GainNode>
  const AudioNodeCtor = window.AudioNode;
  const DestinationCtor = window.AudioDestinationNode;
  const GainNodeCtor = window.GainNode;

  if (AudioNodeCtor && DestinationCtor && GainNodeCtor) {
    const nodeProto = AudioNodeCtor.prototype;
    const nativeConnect = nodeProto.connect;
    const nativeDisconnect = nodeProto.disconnect;
    const OfflineCtx = window.OfflineAudioContext;
    const perContext = new WeakMap(); // BaseAudioContext -> GainNode

    const gainFor = (destination) => {
      const ctx = destination.context;
      if (OfflineCtx && ctx instanceof OfflineCtx) return null; // renderização offline não sai no alto-falante
      let node = perContext.get(ctx);
      if (!node) {
        node = new GainNodeCtor(ctx, { gain });
        nativeConnect.call(node, destination);
        perContext.set(ctx, node);
        gainNodes.add(new WeakRef(node));
      }
      return node;
    };

    const methods = {
      connect(target, ...rest) {
        if (target instanceof DestinationCtor) {
          const node = gainFor(target);
          if (node) {
            nativeConnect.call(this, node, ...rest);
            return target; // mantém o encadeamento igual ao nativo
          }
        }
        return nativeConnect.apply(this, arguments);
      },
      disconnect(...args) {
        if (args[0] instanceof DestinationCtor) {
          const node = perContext.get(args[0].context);
          if (node) args[0] = node;
        }
        return nativeDisconnect.apply(this, args);
      },
    };
    for (const name of ['connect', 'disconnect']) {
      const desc = Object.getOwnPropertyDescriptor(nodeProto, name);
      Object.defineProperty(nodeProto, name, { ...desc, value: methods[name] });
    }
  }

  const applyWebAudio = () => {
    for (const ref of gainNodes) {
      const node = ref.deref();
      if (!node) {
        gainNodes.delete(ref);
        continue;
      }
      const ctx = node.context;
      // Transição curta evita estalos ao mexer no volume.
      node.gain.setTargetAtTime(gain, ctx.currentTime, 0.015);
    }
  };

  // ---- Canal com o script isolado ----------------------------------------
  const onGain = (event) => {
    let next;
    try {
      next = detailOf.call(event);
    } catch {
      return;
    }
    if (typeof next !== 'number' || !(next >= 0 && next <= 1) || next === gain) return;
    gain = next;
    applyAll();
    applyWebAudio();
  };

  // Aceita só a primeira oferta de canal (MouseEvent com relatedTarget = nó privado).
  let channel = null;
  const onOffer = (event) => {
    if (channel) return;
    let node;
    try {
      node = relatedTargetOf.call(event);
    } catch {
      return;
    }
    if (!(node instanceof NodeCtor)) return;
    channel = node;
    nativeOff.call(document, EVT_CHANNEL, onOffer, true);
    nativeOn.call(node, EVT_GAIN, onGain);
    nativeDispatch.call(node, new CustomEventCtor(EVT_READY));
  };
  nativeOn.call(document, EVT_CHANNEL, onOffer, true);

  // bridge.js pode já estar carregado: ele responde ao hello com a oferta do canal.
  nativeDispatch.call(document, new CustomEventCtor(EVT_HELLO));
})();
