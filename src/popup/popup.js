import { DEFAULT_RULE, clampVolume, toggleMuteRule } from '../lib/rules.js';

const $ = (id) => document.getElementById(id);
const el = {
  host: $('host'),
  status: $('status'),
  favicon: $('favicon'),
  controls: $('controls'),
  unsupported: $('unsupported'),
  scopeButtons: [...document.querySelectorAll('[data-scope]')],
  scopeHint: $('scopeHint'),
  mute: $('mute'),
  value: $('value'),
  slider: $('slider'),
  presets: [...document.querySelectorAll('[data-preset]')],
  override: $('override'),
  clearTabFromSite: $('clearTabFromSite'),
  ruleLabel: $('ruleLabel'),
  reset: $('reset'),
  sitesToggle: $('sitesToggle'),
  mainView: $('mainView'),
  sitesView: $('sitesView'),
  sitesList: $('sitesList'),
  sitesEmpty: $('sitesEmpty'),
  playing: $('playing'),
  playingList: $('playingList'),
  playingEmpty: $('playingEmpty'),
  playingLive: $('playingLive'),
  silenceOthers: $('silenceOthers'),
  defaultSlider: $('defaultSlider'),
  defaultValue: $('defaultValue'),
  defaultReset: $('defaultReset'),
};

const send = (msg) => chrome.runtime.sendMessage(msg);

let tabId = null;
let st = null; // estado vindo do service worker
let scope = 'site';
let rule = { ...DEFAULT_RULE }; // regra sendo editada no escopo atual

const hostLabel = (host) => (host === 'file://' ? 'Arquivos locais' : host);

const defaultRule = () => (st && st.defaultVolume != null ? { volume: st.defaultVolume, muted: false } : DEFAULT_RULE);

const ruleFor = (s) =>
  s === 'tab' ? st.tabRule ?? { ...st.effective.rule } : st.siteRule ?? { ...defaultRule() };

const describeRule = (r) => (r.muted || r.volume === 0 ? 'silenciado' : `${r.volume}%`);

// ---- Envio com uma requisição por vez (a última sempre vence) ----------------
function latestOnly(onResult, onIdle) {
  let inFlight = false;
  let queued = null;
  return async (msg) => {
    queued = msg;
    if (inFlight) return;
    inFlight = true;
    while (queued) {
      const next = queued;
      queued = null;
      try {
        onResult(await send(next));
      } catch {
        /* service worker reiniciando: a próxima interação reenvia */
      }
    }
    inFlight = false;
    onIdle?.();
  };
}

const sendRule = latestOnly(
  (res) => {
    if (res && res.ok) st = res;
  },
  () => renderMeta()
);
const pushRule = () => sendRule({ type: 'set', tabId, scope, rule: { ...rule } });

let frame = 0;
const scheduleCommit = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    pushRule();
  });
};

// ---- Renderização -----------------------------------------------------------
function renderControl() {
  const silent = rule.muted;
  el.value.firstChild.nodeValue = String(rule.volume);
  el.slider.value = String(rule.volume);
  el.slider.style.setProperty('--pct', `${rule.volume}%`);
  el.slider.setAttribute('aria-valuetext', silent ? `${rule.volume}% (silenciado)` : `${rule.volume}%`);
  el.mute.setAttribute('aria-pressed', String(silent));
  el.mute.title = silent ? 'Ativar som (M)' : 'Silenciar (M)';
  document.body.classList.toggle('is-muted', silent);
  for (const b of el.presets) b.classList.toggle('active', !silent && Number(b.dataset.preset) === rule.volume);
}

function renderMeta() {
  if (!st) return;
  for (const b of el.scopeButtons) b.setAttribute('aria-checked', String(b.dataset.scope === scope));

  el.scopeHint.textContent =
    scope === 'site'
      ? `Vale para todas as abas de ${hostLabel(st.host)}.`
      : 'Vale só para esta aba, mesmo se ela mudar de site.';

  el.override.hidden = !(scope === 'site' && st.tabRule);

  const { source, rule: active } = st.effective;
  const origin = { tab: 'regra da aba', site: 'regra do site', 'default-user': 'volume padrão' }[source];
  el.status.textContent = source === 'default' ? 'Volume normal' : `Tocando em ${describeRule(active)} · ${origin}`;

  const hasRule = scope === 'tab' ? Boolean(st.tabRule) : Boolean(st.siteRule);
  el.reset.hidden = !hasRule;
  el.ruleLabel.textContent = hasRule
    ? scope === 'tab'
      ? 'Volume próprio desta aba'
      : 'Salvo para o site'
    : scope === 'tab'
      ? 'Mexa no volume para criar a regra da aba'
      : st.defaultVolume != null
        ? 'Usando o volume padrão — mexa para salvar no site'
        : 'Mexa no volume para salvar no site';
}

function selectScope(next) {
  scope = next;
  rule = { ...ruleFor(scope) };
  renderControl();
  renderMeta();
}

// ---- Interações ----------------------------------------------------------
function setVolume(v) {
  const volume = clampVolume(v);
  if (volume === rule.volume && !rule.muted) return;
  rule = { volume, muted: false };
  renderControl();
  scheduleCommit();
}

function toggleMute() {
  rule = toggleMuteRule(rule);
  renderControl();
  scheduleCommit();
}

el.slider.addEventListener('input', () => setVolume(el.slider.valueAsNumber));
el.mute.addEventListener('click', toggleMute);
for (const b of el.presets) b.addEventListener('click', () => setVolume(Number(b.dataset.preset)));
for (const b of el.scopeButtons) b.addEventListener('click', () => selectScope(b.dataset.scope));

el.reset.addEventListener('click', async () => {
  const res = await send({ type: 'clear', tabId, scope });
  if (res && res.ok) st = res;
  selectScope(scope);
});

el.clearTabFromSite.addEventListener('click', async () => {
  const res = await send({ type: 'clear', tabId, scope: 'tab' });
  if (res && res.ok) st = res;
  renderMeta();
});

document.addEventListener('keydown', (e) => {
  if (el.controls.hidden || !el.sitesView.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target instanceof Element && e.target.closest('#playing')) return; // teclas da lista são da lista
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    toggleMute();
  } else if (document.activeElement !== el.slider && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
    e.preventDefault();
    setVolume(rule.volume + (e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 5 : -5));
  }
});

// Rolar o mouse sobre o popup ajusta o volume.
el.controls.addEventListener(
  'wheel',
  (e) => {
    if (!e.deltaY) return;
    e.preventDefault();
    setVolume(rule.volume + (e.deltaY < 0 ? 2 : -2));
  },
  { passive: false }
);

// ---- Sites salvos ----------------------------------------------------------
function renderSites(sites) {
  el.sitesList.replaceChildren(
    ...sites.map((s) => {
      const li = document.createElement('li');
      const host = document.createElement('span');
      host.className = 'host';
      host.textContent = hostLabel(s.host);
      host.title = s.host;
      const pill = document.createElement('span');
      const off = s.muted || s.volume === 0;
      pill.className = off ? 'pill off' : 'pill';
      pill.textContent = off ? 'mudo' : `${s.volume}%`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.title = `Remover ${s.host}`;
      remove.setAttribute('aria-label', `Remover ${s.host}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.addEventListener('click', async () => {
        const res = await send({ type: 'removeSite', host: s.host });
        if (res && res.ok) renderSites(res.sites);
        if (st && s.host === st.host) await refresh();
      });
      li.append(host, pill, remove);
      return li;
    })
  );
  el.sitesEmpty.hidden = sites.length > 0;
}

// ---- Volume padrão ---------------------------------------------------------------
function renderDefault(volume) {
  const v = volume ?? 100;
  el.defaultSlider.value = String(v);
  el.defaultSlider.style.setProperty('--pct', `${v}%`);
  el.defaultSlider.setAttribute('aria-valuetext', v === 0 ? '0% (silenciado)' : `${v}%`);
  el.defaultValue.textContent = `${v}%`;
  el.defaultReset.hidden = volume == null;
}

let defaultChanged = false;
const sendDefault = latestOnly((res) => {
  if (res && res.ok) el.defaultReset.hidden = res.defaultVolume == null;
});

el.defaultSlider.addEventListener('input', () => {
  const v = clampVolume(el.defaultSlider.valueAsNumber);
  renderDefault(v === 100 ? null : v);
  defaultChanged = true;
  sendDefault({ type: 'setDefault', volume: v });
});

el.defaultReset.addEventListener('click', () => {
  renderDefault(null);
  defaultChanged = true;
  sendDefault({ type: 'clearDefault' });
  el.defaultSlider.focus();
});

el.sitesToggle.addEventListener('click', async () => {
  const open = el.sitesView.hidden;
  el.sitesView.hidden = !open;
  el.mainView.hidden = open;
  el.sitesToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    const res = await send({ type: 'listSites' });
    renderSites(res && res.ok ? res.sites : []);
    renderDefault(res && res.ok ? res.defaultVolume : null);
  } else if (defaultChanged) {
    defaultChanged = false;
    await refresh();
  } else {
    selectScope(scope);
  }
});

// ---- Tocando agora -------------------------------------------------------------
const ICON_SOUND =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" class="fill"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>';
const ICON_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" class="fill"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
const ICON_TAB =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 9.5h18"/></svg>';

const tabLabel = (item) => item.title || (item.host ? hostLabel(item.host) : 'Aba sem título');

function playingRow(item) {
  const li = document.createElement('li');
  const icon = document.createElement('span');
  icon.className = 'play-icon';
  if (/^(https?:|data:image\/)/.test(item.favIconUrl)) {
    const img = document.createElement('img');
    img.src = item.favIconUrl;
    img.alt = '';
    img.width = img.height = 16;
    img.addEventListener('error', () => (icon.innerHTML = ICON_TAB), { once: true });
    icon.append(img);
  } else {
    icon.innerHTML = ICON_TAB;
  }

  const text = document.createElement('span');
  text.className = 'play-text';
  const title = document.createElement('span');
  title.className = 'play-title';
  title.textContent = tabLabel(item);
  title.title = tabLabel(item);
  const host = document.createElement('span');
  host.className = 'muted-text play-host';
  host.textContent = item.controllable ? (item.silenced ? `${hostLabel(item.host)} · silenciada` : hostLabel(item.host)) : 'Aba protegida';
  text.append(title, host);

  let action;
  if (item.controllable) {
    action = document.createElement('button');
    action.type = 'button';
    action.className = 'icon-btn play-toggle';
    action.dataset.tabId = String(item.tabId);
    action.setAttribute('aria-pressed', String(item.silenced));
    const label = item.silenced ? `Ativar som de ${tabLabel(item)}` : `Silenciar ${tabLabel(item)}`;
    action.setAttribute('aria-label', label);
    action.title = label;
    action.innerHTML = item.silenced ? ICON_MUTED : ICON_SOUND;
    action.addEventListener('click', async () => {
      const res = await send({ type: 'toggleTabMute', tabId: item.tabId }).catch(() => null);
      if (res && res.ok) {
        el.playingLive.textContent = res.item.silenced ? `${tabLabel(item)} silenciada` : `Som de ${tabLabel(item)} ativado`;
      }
      await loadPlaying();
    });
  } else {
    action = document.createElement('span');
    action.className = 'muted-text play-na';
    action.textContent = 'não dá para controlar';
  }
  li.append(icon, text, action);
  return li;
}

function renderPlaying(items) {
  const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.tabId;
  el.playingList.replaceChildren(...items.map(playingRow));
  el.playingList.hidden = items.length === 0;
  const pending = items.filter((i) => i.controllable && !i.silenced).length;
  el.silenceOthers.disabled = pending === 0;
  el.playingEmpty.hidden = pending > 0;
  el.playingEmpty.textContent = items.length === 0 ? 'Nenhuma outra aba está tocando' : 'Nenhuma outra aba para silenciar';
  if (focused) {
    const again = el.playingList.querySelector(`[data-tab-id="${focused}"]`);
    if (again) again.focus();
  }
}

async function loadPlaying() {
  const res = await send({ type: 'listPlaying', activeTabId: tabId }).catch(() => null);
  renderPlaying(res && res.ok ? res.items : []);
}

el.silenceOthers.addEventListener('click', async () => {
  const res = await send({ type: 'silenceOthers', activeTabId: tabId }).catch(() => null);
  if (!res || !res.ok) return;
  el.playingLive.textContent = res.count === 1 ? '1 aba silenciada' : `${res.count} abas silenciadas`;
  if (document.activeElement === el.silenceOthers) el.playingList.querySelector('button')?.focus();
  renderPlaying(res.items);
});

// Abas começam ou param de tocar com o popup aberto.
let playingTimer = 0;
const schedulePlaying = () => {
  clearTimeout(playingTimer);
  playingTimer = setTimeout(loadPlaying, 250);
};
chrome.tabs.onUpdated.addListener((_id, change) => {
  if ('audible' in change || 'title' in change || 'favIconUrl' in change) schedulePlaying();
});
chrome.tabs.onRemoved.addListener(schedulePlaying);

// ---- Início ------------------------------------------------------------------
async function refresh() {
  const res = await send({ type: 'getState', tabId });
  if (!res || !res.ok) return showUnsupported();
  st = res;
  if (!st.controllable || st.injected === false) return showUnsupported();
  selectScope(scope);
}

function showUnsupported() {
  el.controls.hidden = true;
  el.unsupported.hidden = false;
  el.status.textContent = 'Página protegida do navegador';
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return showUnsupported();
  tabId = tab.id;
  loadPlaying();

  let label = tab.title || '';
  try {
    const u = new URL(tab.url || tab.pendingUrl || '');
    label = u.protocol === 'file:' ? 'Arquivos locais' : u.hostname.replace(/^www\./, '') || label;
  } catch {
    /* mantém o título */
  }
  el.host.textContent = label || '—';
  el.host.title = tab.url || '';

  if (tab.favIconUrl && /^(https?:|data:image\/)/.test(tab.favIconUrl)) {
    el.favicon.src = tab.favIconUrl;
    el.favicon.hidden = false;
    el.favicon.addEventListener('error', () => (el.favicon.hidden = true), { once: true });
  }

  const res = await send({ type: 'getState', tabId });
  if (!res || !res.ok) return showUnsupported();
  st = res;
  if (!st.controllable || st.injected === false) return showUnsupported();
  scope = st.tabRule ? 'tab' : 'site';
  selectScope(scope);
  el.slider.focus({ focusVisible: false });
}

init();
