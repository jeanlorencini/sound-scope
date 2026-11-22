// SoundScope — service worker. Guarda as regras e aplica o volume às abas.
//  • Regras de site: chrome.storage.local  { sites: { [host]: { volume, muted, updatedAt } } }
//  • Volume padrão (sites sem regra): chrome.storage.local { defaultVolume: 0..99 | null }
//  • Regras de aba:  chrome.storage.session { tabs: { [tabId]: { volume, muted } } }
//    (valem só enquanto a aba existir, mesmo que ela navegue para outro domínio)
//  • Abas silenciadas por "Silenciar as outras": chrome.storage.session
//    { silenced: { [tabId]: regraDeAbaAnterior | null } } (para desfazer exatamente)
import {
  badgeText,
  defaultRuleOf,
  gainOf,
  resolveRule,
  sanitizeDefault,
  sanitizeRule,
  siteKey,
  titleText,
} from './lib/rules.js';
import { applyCommand } from './lib/commands.js';

const PERSIST_DELAY_MS = 200;
const BADGE_COLOR = '#536dfe';
const BADGE_MUTED_COLOR = '#e5484d';

// ---- Estado (cache em memória + persistência com debounce) -----------------
let statePromise = null;
const isObj = (v) => Boolean(v) && typeof v === 'object';
const loadState = () =>
  (statePromise ??= Promise.all([
    chrome.storage.local.get(['sites', 'defaultVolume']),
    chrome.storage.session.get(['tabs', 'silenced']),
  ]).then(([local, session]) => ({
    sites: isObj(local.sites) ? local.sites : {},
    defaultVolume: sanitizeDefault(local.defaultVolume),
    tabs: isObj(session.tabs) ? session.tabs : {},
    silenced: isObj(session.silenced) ? session.silenced : {},
  })));

const timers = {};
const schedulePersist = (area, key, getValue) => {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    delete timers[key];
    chrome.storage[area].set({ [key]: getValue() }).catch(() => {});
  }, PERSIST_DELAY_MS);
};
const persistSites = (state) => schedulePersist('local', 'sites', () => state.sites);
const persistTabs = (state) => schedulePersist('session', 'tabs', () => state.tabs);
const persistSilenced = (state) => schedulePersist('session', 'silenced', () => state.silenced);

const stripMeta = (stored) => (stored ? { volume: stored.volume, muted: stored.muted } : null);

const describe = (state, tabId, url) => {
  const host = siteKey(url);
  const siteRule = host ? stripMeta(state.sites[host]) : null;
  const tabRule = state.tabs[tabId] ?? null;
  const defaultRule = defaultRuleOf(state.defaultVolume);
  return { host, siteRule, tabRule, effective: resolveRule({ tabRule, siteRule, defaultRule }) };
};

// ---- Aplicação ---------------------------------------------------------------
const getTab = (tabId) => chrome.tabs.get(tabId).catch(() => null);

// Selo e título do ícone: o retorno visível de qualquer mudança, com ou sem popup aberto.
async function updateBadge(tabId, { host, effective }) {
  const { rule } = effective;
  const text = badgeText(rule);
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title: titleText({ ...effective, host }) });
    if (text) {
      const muted = rule.muted || rule.volume === 0;
      await chrome.action.setBadgeBackgroundColor({ tabId, color: muted ? BADGE_MUTED_COLOR : BADGE_COLOR });
      await chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' });
    }
  } catch {
    /* aba fechada */
  }
}

async function applyToTab(state, tab) {
  if (!tab || tab.id == null) return;
  const info = describe(state, tab.id, tab.url);
  const { host, effective } = info;
  await updateBadge(tab.id, info);
  if (!host) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'gain', gain: gainOf(effective.rule) }).catch(() => {});
}

async function applyToSite(state, host) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((t) => siteKey(t.url) === host).map((t) => applyToTab(state, t)));
}

// Abas abertas antes da instalação não têm os content scripts: injeta sob demanda.
async function ensureInjected(tabId) {
  const ok = await chrome.tabs
    .sendMessage(tabId, { type: 'ping' }, { frameId: 0 })
    .then((r) => Boolean(r && r.ok))
    .catch(() => false);
  if (ok) return true;
  try {
    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['src/content/inject.js'], world: 'MAIN', injectImmediately: true });
    await chrome.scripting.executeScript({ target, files: ['src/content/bridge.js'], injectImmediately: true });
    return true;
  } catch {
    return false; // páginas protegidas (chrome://, Chrome Web Store…)
  }
}

// ---- Tocando agora -------------------------------------------------------------
// O usuário mexeu na regra da aba por conta própria: o "desfazer" não a sobrescreve mais.
function forgetSilenced(state, tabId) {
  if (Object.hasOwn(state.silenced, tabId)) {
    delete state.silenced[tabId];
    persistSilenced(state);
  }
}

// Silencia só pelo ganho do SoundScope (regra de aba), guardando a regra anterior.
function silenceTab(state, tabId, volume) {
  state.silenced[tabId] = state.tabs[tabId] ?? null;
  state.tabs[tabId] = { volume, muted: true };
}

function restoreTab(state, tabId) {
  const previous = state.silenced[tabId];
  delete state.silenced[tabId];
  if (previous) state.tabs[tabId] = previous;
  else delete state.tabs[tabId];
}

// Abas tocando (todas as janelas normais) + as silenciadas por nós, sem a aba ativa.
async function playingTabs(state, activeTabId) {
  const audible = await chrome.tabs.query({ audible: true, windowType: 'normal' });
  const seen = new Set(audible.map((t) => t.id));
  const extra = await Promise.all(
    Object.keys(state.silenced)
      .map(Number)
      .filter((id) => !seen.has(id))
      .map(getTab)
  );
  return [...audible, ...extra.filter(Boolean)].filter((t) => t.id != null && t.id !== activeTabId);
}

const playingItem = (state, tab) => {
  const { host, effective } = describe(state, tab.id, tab.url);
  return {
    tabId: tab.id,
    title: tab.title || '',
    host,
    favIconUrl: tab.favIconUrl || '',
    controllable: Boolean(host),
    silenced: Object.hasOwn(state.silenced, tab.id),
    effectiveRule: effective.rule,
  };
};

// ---- Mensagens ---------------------------------------------------------------
async function stateFor(tabId) {
  const state = await loadState();
  const tab = await getTab(tabId);
  if (!tab) return { ok: false, error: 'tab-not-found' };
  const info = describe(state, tabId, tab.url);
  return { ok: true, tabId, controllable: Boolean(info.host), defaultVolume: state.defaultVolume, ...info };
}

const handlers = {
  async getGain(_msg, sender) {
    const tab = sender.tab;
    if (!tab || tab.id == null) return { gain: 1 };
    const state = await loadState();
    const info = describe(state, tab.id, tab.url);
    const { effective } = info;
    if (sender.frameId === 0) updateBadge(tab.id, info);
    return { gain: gainOf(effective.rule) };
  },

  async getState({ tabId }) {
    const res = await stateFor(tabId);
    if (res.ok && res.controllable) res.injected = await ensureInjected(tabId);
    return res;
  },

  async set({ tabId, scope, rule }) {
    const clean = sanitizeRule(rule);
    if (!clean || (scope !== 'site' && scope !== 'tab')) return { ok: false, error: 'invalid' };
    const state = await loadState();
    const tab = await getTab(tabId);
    if (!tab) return { ok: false, error: 'tab-not-found' };
    if (scope === 'tab') {
      state.tabs[tabId] = clean;
      persistTabs(state);
      forgetSilenced(state, tabId);
      await applyToTab(state, tab);
    } else {
      const host = siteKey(tab.url);
      if (!host) return { ok: false, error: 'not-controllable' };
      state.sites[host] = { ...clean, updatedAt: Date.now() };
      persistSites(state);
      await applyToSite(state, host);
    }
    return stateFor(tabId);
  },

  async clear({ tabId, scope }) {
    const state = await loadState();
    const tab = await getTab(tabId);
    if (!tab) return { ok: false, error: 'tab-not-found' };
    if (scope === 'tab') {
      delete state.tabs[tabId];
      persistTabs(state);
      forgetSilenced(state, tabId);
      await applyToTab(state, tab);
    } else {
      const host = siteKey(tab.url);
      if (host && state.sites[host]) {
        delete state.sites[host];
        persistSites(state);
        await applyToSite(state, host);
      }
    }
    return stateFor(tabId);
  },

  async listPlaying({ activeTabId }) {
    const state = await loadState();
    const tabs = await playingTabs(state, activeTabId);
    return { ok: true, items: tabs.map((t) => playingItem(state, t)) };
  },

  async silenceOthers({ activeTabId }) {
    const state = await loadState();
    const tabs = await playingTabs(state, activeTabId);
    const targets = tabs.filter((t) => {
      const item = playingItem(state, t);
      return item.controllable && !item.silenced;
    });
    for (const t of targets) silenceTab(state, t.id, describe(state, t.id, t.url).effective.rule.volume);
    if (targets.length) {
      persistTabs(state);
      persistSilenced(state);
    }
    await Promise.all(targets.map((t) => applyToTab(state, t)));
    return { ok: true, count: targets.length, ...(await handlers.listPlaying({ activeTabId })) };
  },

  async toggleTabMute({ tabId }) {
    const state = await loadState();
    const tab = await getTab(tabId);
    if (!tab) return { ok: false, error: 'tab-not-found' };
    const { host, effective } = describe(state, tab.id, tab.url);
    if (!host) return { ok: false, error: 'not-controllable' };
    if (Object.hasOwn(state.silenced, tab.id)) restoreTab(state, tab.id);
    else silenceTab(state, tab.id, effective.rule.volume);
    persistTabs(state);
    persistSilenced(state);
    await applyToTab(state, tab);
    return { ok: true, item: playingItem(state, tab) };
  },

  // Muda o volume padrão e aplica na hora só às abas sem regra de aba nem de site.
  async setDefault({ volume }) {
    if (volume !== null && (typeof volume !== 'number' || !Number.isFinite(volume))) {
      return { ok: false, error: 'invalid' };
    }
    const state = await loadState();
    const tabs = await chrome.tabs.query({});
    const next = sanitizeDefault(volume);
    const usesDefault = (t) => describe(state, t.id, t.url).effective.source.startsWith('default');
    const affected = tabs.filter(usesDefault);
    state.defaultVolume = next;
    schedulePersist('local', 'defaultVolume', () => state.defaultVolume);
    await Promise.all(affected.map((t) => applyToTab(state, t)));
    return { ok: true, defaultVolume: state.defaultVolume };
  },

  clearDefault() {
    return handlers.setDefault({ volume: null });
  },

  async listSites() {
    const state = await loadState();
    const sites = Object.entries(state.sites)
      .map(([host, r]) => ({ host, volume: r.volume, muted: r.muted, updatedAt: r.updatedAt ?? 0 }))
      .sort((a, b) => a.host.localeCompare(b.host));
    return { ok: true, sites, defaultVolume: state.defaultVolume };
  },

  async removeSite({ host }) {
    const state = await loadState();
    if (typeof host === 'string' && state.sites[host]) {
      delete state.sites[host];
      persistSites(state);
      await applyToSite(state, host);
    }
    return handlers.listSites();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // resposta assíncrona
});

// ---- Atalhos globais (chrome.commands) ----------------------------------------
// Um comando por vez: disparos rápidos acumulam sem perder passos.
let commandQueue = Promise.resolve();
const enqueue = (fn) => (commandQueue = commandQueue.then(fn).catch(() => {}));

async function runCommand(command, tab) {
  if (!tab || tab.id == null) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) return;
  const state = await loadState();
  tab = (await getTab(tab.id)) ?? tab;
  // Daqui até gravar não há await: lê e escreve sobre o mesmo estado.
  const { host, tabRule, effective } = describe(state, tab.id, tab.url);
  if (!host) return; // página protegida: nada muda
  const next = applyCommand(effective.rule, command);
  if (!next) return;
  // Só o ganho do SoundScope: o mudo nativo da aba (chrome.tabs.update) nunca é tocado.
  if (tabRule) {
    state.tabs[tab.id] = next;
    persistTabs(state);
    forgetSilenced(state, tab.id); // o atalho vira a nova regra: o "desfazer" não a sobrescreve

    await applyToTab(state, tab);
  } else {
    state.sites[host] = { ...next, updatedAt: Date.now() };
    persistSites(state);
    await applyToSite(state, host);
  }
}

chrome.commands.onCommand.addListener((command, tab) => enqueue(() => runCommand(command, tab)));

// ---- Ciclo de vida das abas ------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  if (state.tabs[tabId]) {
    delete state.tabs[tabId];
    persistTabs(state);
  }
  forgetSilenced(state, tabId);
});

// Pré-renderização/troca instantânea substitui o id da aba: a regra acompanha.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const state = await loadState();
  if (Object.hasOwn(state.silenced, removedTabId)) {
    state.silenced[addedTabId] = state.silenced[removedTabId];
    delete state.silenced[removedTabId];
    persistSilenced(state);
  }
  if (state.tabs[removedTabId]) {
    state.tabs[addedTabId] = state.tabs[removedTabId];
    delete state.tabs[removedTabId];
    persistTabs(state);
    applyToTab(state, await getTab(addedTabId));
  }
});

// Navegação para outro site muda qual regra de site vale: atualiza o selo.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  const state = await loadState();
  updateBadge(tabId, describe(state, tabId, tab.url));
});

// Após instalar/atualizar, ativa a extensão nas abas que já estavam abertas.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const state = await loadState();
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.discarded) return;
      if (await ensureInjected(tab.id)) await applyToTab(state, tab);
    })
  );
});
