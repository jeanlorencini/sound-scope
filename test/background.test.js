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
  const titles = {};
  const updates = [];
  const byId = () => new Map(tabs.map((t) => [t.id, t]));
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: { onMessage: event(), onInstalled: event() },
    commands: { onCommand: event() },
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
        let list = tabs;
        if (q.url) list = list.filter((t) => /^https?:/.test(t.url));
        if (q.active) list = list.filter((t) => t.active);
        if (q.audible) list = list.filter((t) => t.audible);
        return list.map((t) => ({ ...t }));
      },
      async update(id, props) {
        updates.push({ id, ...props });
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
      async setTitle({ tabId, title }) {
        titles[tabId] = title;
      },
      async setBadgeBackgroundColor() {},
      async setBadgeTextColor() {},
    },
  };
  return { chrome, sent, injected, badges, titles, updates };
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
  const command = (name, tab) => env.chrome.commands.onCommand.fns[0](name, tab);
  return { ...env, call, gains, command };
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

// ---- Atalhos globais (R3) ------------------------------------------------------

test('CA3.1/3.4: sem regra de aba, o atalho altera a regra do site em todas as abas dele', async () => {
  const local = {};
  const tabs = TABS();
  tabs[0].active = true;
  const bg = await boot(tabs, { local });
  await bg.call({ type: 'set', tabId: 1, scope: 'site', rule: { volume: 40 } });
  await bg.command('volume-up', { id: 1, url: tabs[0].url });
  assert.deepEqual(bg.gains(), { 1: 0.5, 2: 0.5 });
  assert.equal(bg.badges[1], '50');
  assert.equal(bg.titles[1], 'SoundScope — 50% em youtube.com (site)');
  await wait(260);
  assert.equal(local.sites['youtube.com'].volume, 50);
  assert.equal(bg.updates.length, 0, 'mudo nativo não é tocado');
});

test('CA3.4: com regra de aba, o atalho altera só a aba', async () => {
  const bg = await boot(TABS());
  await bg.call({ type: 'set', tabId: 1, scope: 'site', rule: { volume: 60 } });
  await bg.call({ type: 'set', tabId: 2, scope: 'tab', rule: { volume: 30 } });
  await bg.command('volume-down', { id: 2 });
  assert.deepEqual(bg.gains(), { 1: 0.6, 2: 0.2 });
  const st = await bg.call({ type: 'getState', tabId: 2 });
  assert.deepEqual(st.tabRule, { volume: 20, muted: false });
  assert.deepEqual(st.siteRule, { volume: 60, muted: false });
  assert.equal(bg.titles[2], 'SoundScope — 20% nesta aba');
});

test('CA3.2/3.3/3.6: mudo pelo atalho mantém o volume e o selo mostra ×', async () => {
  const bg = await boot(TABS());
  await bg.call({ type: 'set', tabId: 3, scope: 'site', rule: { volume: 70 } });
  await bg.command('toggle-mute', { id: 3 });
  assert.equal(bg.gains()[3], 0);
  assert.equal(bg.badges[3], '×');
  assert.equal(bg.titles[3], 'SoundScope — silenciado em open.spotify.com (site)');
  await bg.command('toggle-mute', { id: 3 });
  assert.equal(bg.gains()[3], 0.7, 'volta ao volume anterior');
  await bg.command('toggle-mute', { id: 3 });
  await bg.command('volume-up', { id: 3 });
  assert.equal(bg.gains()[3], 0.8, 'subir o volume tira o mudo');
  assert.equal(bg.updates.length, 0);
});

test('CA3.6: selo vazio em 100% e título ainda descreve o estado', async () => {
  const bg = await boot(TABS());
  await bg.call({ type: 'set', tabId: 3, scope: 'site', rule: { volume: 95 } });
  await bg.command('volume-up', { id: 3 });
  assert.equal(bg.badges[3], '');
  assert.equal(bg.titles[3], 'SoundScope — 100% em open.spotify.com (site)');
});

test('CA3.7: em página protegida o atalho não grava nada e não muda o selo', async () => {
  await wait(260); // deixa a persistência pendente do teste anterior terminar
  const local = {};
  const bg = await boot(TABS(), { local });
  await bg.command('volume-down', { id: 4 });
  await bg.command('nao-existe', { id: 1 });
  await wait(260);
  assert.equal(local.sites, undefined);
  assert.equal(bg.badges[4], undefined);
  assert.equal(bg.badges[1], undefined);
});

test('CA3.8/3.9: cinco atalhos seguidos acumulam (40 → 90) sem popup, e o estado fica salvo', async () => {
  const local = {};
  const tabs = TABS();
  tabs[2].active = true;
  const bg = await boot(tabs, { local });
  await bg.call({ type: 'set', tabId: 3, scope: 'site', rule: { volume: 40 } });
  // Sem a aba no evento: usa a aba ativa da janela em foco.
  await Promise.all([1, 2, 3, 4, 5].map(() => bg.command('volume-up')));
  assert.equal(bg.gains()[3], 0.9);
  await wait(260);
  assert.equal(local.sites['open.spotify.com'].volume, 90);
  const st = await bg.call({ type: 'getState', tabId: 3 });
  assert.deepEqual(st.effective, { source: 'site', rule: { volume: 90, muted: false } });
});
