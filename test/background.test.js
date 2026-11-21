// Testa o service worker com uma simulação mínima das APIs do Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const event = () => {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...a) => Promise.all(fns.map((fn) => fn(...a))), fns };
};

function createChrome(tabs, { local = {}, session = {} } = {}) {
  const area = (data) => ({
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
  });
  const sent = [];
  const injected = [];
  const badges = {};
  const byId = () => new Map(tabs.map((t) => [t.id, t]));
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: { onMessage: event(), onInstalled: event() },
    tabs: {
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event(),
      async get(id) {
        const t = byId().get(id);
        if (!t) throw new Error('No tab with id');
        return { ...t };
      },
      async query(q = {}) {
        if (q.url) return tabs.filter((t) => /^https?:/.test(t.url)).map((t) => ({ ...t }));
        return tabs.map((t) => ({ ...t }));
      },
      async sendMessage(id, msg) {
        const t = byId().get(id);
        if (!t || !t.hasScript) throw new Error('Could not establish connection. Receiving end does not exist.');
        sent.push({ id, ...msg });
        return msg.type === 'ping' ? { ok: true } : undefined;
      },
    },
    scripting: {
      async executeScript({ target, files, world }) {
        const t = byId().get(target.tabId);
        if (!/^https?:/.test(t.url)) throw new Error('Cannot access contents of the page');
        injected.push({ id: target.tabId, file: files[0], world: world ?? 'ISOLATED' });
        t.hasScript = true;
      },
    },
    action: {
      async setBadgeText({ tabId, text }) {
        badges[tabId] = text;
      },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
    },
  };
  return { chrome, sent, injected, badges };
}

let n = 0;
async function boot(tabs, stores) {
  const env = createChrome(tabs, stores);
  globalThis.chrome = env.chrome;
  await import(`../src/background.js?instance=${++n}`);
  const call = (msg, sender = {}) =>
    new Promise((resolve) => {
      const handled = env.chrome.runtime.onMessage.fns[0](msg, sender, resolve);
      if (!handled) resolve(undefined);
    });
  const gains = () => Object.fromEntries(env.sent.filter((m) => m.type === 'gain').map((m) => [m.id, m.gain]));
  return { ...env, call, gains };
}

const TABS = () => [
  { id: 1, url: 'https://www.youtube.com/watch?v=a', hasScript: true },
  { id: 2, url: 'https://youtube.com/watch?v=b', hasScript: true },
  { id: 3, url: 'https://open.spotify.com/', hasScript: true },
  { id: 4, url: 'chrome://settings', hasScript: false },
];

test('regra de site vale para todas as abas do site, e só para elas', async () => {
  const bg = await boot(TABS());
  const res = await bg.call({ type: 'set', tabId: 1, scope: 'site', rule: { volume: 40 } });
  assert.equal(res.ok, true);
  assert.equal(res.host, 'youtube.com');
  assert.deepEqual(res.effective, { source: 'site', rule: { volume: 40, muted: false } });
  assert.deepEqual(bg.gains(), { 1: 0.4, 2: 0.4 });
  assert.equal(bg.badges[1], '40');
  assert.equal(bg.badges[2], '40');
  assert.equal(bg.badges[3], undefined);
});

test('regra de aba vale mais que a do site e só para aquela aba', async () => {
  const bg = await boot(TABS());
  await bg.call({ type: 'set', tabId: 1, scope: 'tab', rule: { volume: 80 } });
  await bg.call({ type: 'set', tabId: 2, scope: 'site', rule: { volume: 30 } });
  assert.deepEqual(bg.gains(), { 1: 0.8, 2: 0.3 });

  const s1 = await bg.call({ type: 'getState', tabId: 1 });
  assert.equal(s1.effective.source, 'tab');
  assert.deepEqual(s1.siteRule, { volume: 30, muted: false });

  // Ao remover a regra da aba, volta a valer a do site.
  const cleared = await bg.call({ type: 'clear', tabId: 1, scope: 'tab' });
  assert.deepEqual(cleared.effective, { source: 'site', rule: { volume: 30, muted: false } });
  assert.equal(bg.gains()[1], 0.3);
});

test('regra de aba acompanha a aba quando ela muda de domínio', async () => {
  const tabs = TABS();
  const bg = await boot(tabs);
  await bg.call({ type: 'set', tabId: 3, scope: 'tab', rule: { volume: 15 } });
  tabs[2].url = 'https://soundcloud.com/x';
  const r = await bg.call({ type: 'getGain' }, { tab: { id: 3, url: tabs[2].url }, frameId: 0 });
  assert.equal(r.gain, 0.15);
});

test('iframes usam o site da aba, não o do frame', async () => {
  const bg = await boot(TABS());
  await bg.call({ type: 'set', tabId: 1, scope: 'site', rule: { volume: 50 } });
  // Um iframe de outro domínio dentro da aba do YouTube
  const r = await bg.call({ type: 'getGain' }, { tab: { id: 1, url: 'https://www.youtube.com/watch?v=a' }, frameId: 7, url: 'https://ads.example/x' });
  assert.equal(r.gain, 0.5);
  // Sem aba (ex.: pré-renderização) não altera nada
  assert.deepEqual(await bg.call({ type: 'getGain' }, {}), { gain: 1 });
});

test('silenciar resulta em ganho 0 e selo ×', async () => {
  const bg = await boot(TABS());
  await bg.call({ type: 'set', tabId: 3, scope: 'site', rule: { volume: 70, muted: true } });
  assert.equal(bg.gains()[3], 0);
  assert.equal(bg.badges[3], '×');
});

test('persiste sites no local e abas no session; fechar a aba apaga a regra', async () => {
  const local = {};
  const session = {};
  const bg = await boot(TABS(), { local, session });
  await bg.call({ type: 'set', tabId: 1, scope: 'site', rule: { volume: 20 } });
  await bg.call({ type: 'set', tabId: 3, scope: 'tab', rule: { volume: 60 } });
  await wait(260);
  assert.equal(local.sites['youtube.com'].volume, 20);
  assert.deepEqual(session.tabs, { 3: { volume: 60, muted: false } });

  await bg.chrome.tabs.onRemoved.fire(3);
  await wait(260);
  assert.deepEqual(session.tabs, {});
});

test('lê as regras salvas quando o service worker reinicia', async () => {
  const local = { sites: { 'youtube.com': { volume: 25, muted: false, updatedAt: 1 } } };
  const bg = await boot(TABS(), { local });
  const r = await bg.call({ type: 'getGain' }, { tab: { id: 2, url: 'https://youtube.com/' }, frameId: 0 });
  assert.equal(r.gain, 0.25);
  const list = await bg.call({ type: 'listSites' });
  assert.deepEqual(list.sites, [{ host: 'youtube.com', volume: 25, muted: false, updatedAt: 1 }]);
});

test('remover site salvo restaura o volume nas abas', async () => {
  const bg = await boot(TABS());
  await bg.call({ type: 'set', tabId: 3, scope: 'site', rule: { volume: 10 } });
  const res = await bg.call({ type: 'removeSite', host: 'open.spotify.com' });
  assert.deepEqual(res.sites, []);
  assert.equal(bg.gains()[3], 1);
  assert.equal(bg.badges[3], '');
});

test('rejeita entradas inválidas e páginas protegidas', async () => {
  const bg = await boot(TABS());
  assert.equal((await bg.call({ type: 'set', tabId: 1, scope: 'global', rule: { volume: 5 } })).ok, false);
  assert.equal((await bg.call({ type: 'set', tabId: 1, scope: 'site', rule: null })).ok, false);
  assert.equal((await bg.call({ type: 'set', tabId: 99, scope: 'tab', rule: { volume: 5 } })).ok, false);
  const r = await bg.call({ type: 'set', tabId: 4, scope: 'site', rule: { volume: 5 } });
  assert.deepEqual(r, { ok: false, error: 'not-controllable' });
  const st = await bg.call({ type: 'getState', tabId: 4 });
  assert.equal(st.controllable, false);
  assert.equal(await bg.call({ type: 'naoExiste' }), undefined);
});

test('ao instalar, injeta os scripts nas abas já abertas que não os têm', async () => {
  const tabs = TABS();
  tabs[0].hasScript = false;
  const bg = await boot(tabs, { local: { sites: { 'youtube.com': { volume: 45, muted: false } } } });
  await bg.chrome.runtime.onInstalled.fire({ reason: 'install' });
  assert.deepEqual(bg.injected, [
    { id: 1, file: 'src/content/inject.js', world: 'MAIN' },
    { id: 1, file: 'src/content/bridge.js', world: 'ISOLATED' },
  ]);
  assert.equal(bg.gains()[1], 0.45);
});

test('getState injeta sob demanda e informa quando não consegue', async () => {
  const tabs = TABS();
  tabs[2].hasScript = false;
  const bg = await boot(tabs);
  const st = await bg.call({ type: 'getState', tabId: 3 });
  assert.equal(st.injected, true);
  assert.equal(bg.injected.length, 2);
});
