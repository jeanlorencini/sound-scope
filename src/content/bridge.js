// SoundScope — mundo isolado da extensão. Pede o fator de ganho ao service worker
// e o repassa para inject.js (mundo da página) via CustomEvent.
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
  let gain = 1;

  const push = () => document.dispatchEvent(new CustomEvent(EVT_GAIN, { detail: gain }));

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

  // inject.js pode carregar depois deste script: ele avisa e recebe o valor atual.
  document.addEventListener(EVT_HELLO, push);

  // Página restaurada do cache de navegação ou pré-renderizada: o valor pode ter mudado.
  window.addEventListener('pageshow', (e) => e.persisted && request());
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', request, { once: true });
  }

  request();
})();
