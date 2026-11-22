// SoundScope — mundo isolado da extensão. Pede o fator de ganho ao service worker
// e o repassa para inject.js (mundo da página) por um nó privado, fora do DOM.
// O nó é entregue uma única vez (handshake em document_start); a página não o alcança.
(() => {
  'use strict';

  const alive = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };
  // Evita duplicar quando reinjetado, mas permite substituir uma cópia de uma versão antiga.
  const previous = globalThis.__soundscopeBridgeAlive;
  if (typeof previous === 'function' && previous()) return;
  globalThis.__soundscopeBridgeAlive = alive;

  const EVT_GAIN = 'soundscope:gain';
  const EVT_HELLO = 'soundscope:hello';
  const EVT_CHANNEL = 'soundscope:channel';
  const EVT_READY = 'soundscope:ready';
  let gain = 1;

  // Guardado no mundo isolado (a página não vê): uma cópia reinjetada reaproveita o canal.
  const ch = (globalThis.__soundscopeChannel ??= { node: document.createElement('span'), acked: false });

  const offer = () => {
    if (!ch.acked) document.dispatchEvent(new MouseEvent(EVT_CHANNEL, { relatedTarget: ch.node }));
  };

  const push = () => {
    ch.node.dispatchEvent(new CustomEvent(EVT_GAIN, { detail: gain }));
    // Modo legado: aba com o inject.js 1.0.0 (sem handshake) até ser recarregada.
    // O inject.js atual nunca escuta este evento no document.
    if (!ch.acked) document.dispatchEvent(new CustomEvent(EVT_GAIN, { detail: gain }));
  };

  const setGain = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    gain = Math.min(1, Math.max(0, n));
    push();
  };

  const request = () => {
    if (!alive()) return;
    chrome.runtime
      .sendMessage({ type: 'getGain' })
      .then((res) => res && setGain(res.gain))
      .catch(() => {});
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'gain') setGain(msg.gain);
    else if (msg.type === 'ping') sendResponse({ ok: true });
  });

  // inject.js pode carregar antes (recebe a oferta agora) ou depois (avisa com hello).
  if (!ch.acked) {
    ch.node.addEventListener(
      EVT_READY,
      () => {
        ch.acked = true;
        document.removeEventListener(EVT_HELLO, offer);
        push();
      },
      { once: true }
    );
    document.addEventListener(EVT_HELLO, offer);
    offer();
  }

  // Página restaurada do cache de navegação ou pré-renderizada: o valor pode ter mudado.
  window.addEventListener('pageshow', (e) => e.persisted && request());
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', request, { once: true });
  }

  request();
})();
