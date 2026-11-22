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
};

const send = (msg) => chrome.runtime.sendMessage(msg);

let tabId = null;
let st = null; // estado vindo do service worker
let scope = 'site';
let rule = { ...DEFAULT_RULE }; // regra sendo editada no escopo atual

const hostLabel = (host) => (host === 'file://' ? 'Arquivos locais' : host);

const ruleFor = (s) =>
  s === 'tab' ? st.tabRule ?? { ...st.effective.rule } : st.siteRule ?? { ...DEFAULT_RULE };

const describeRule = (r) => (r.muted || r.volume === 0 ? 'silenciado' : `${r.volume}%`);

// ---- Envio com uma requisição por vez (a última sempre vence) ----------------
let inFlight = false;
let queued = null;
async function pushRule() {
  queued = { type: 'set', tabId, scope, rule: { ...rule } };
  if (inFlight) return;
  inFlight = true;
  while (queued) {
    const msg = queued;
    queued = null;
    try {
      const res = await send(msg);
      if (res && res.ok) st = res;
    } catch {
      /* service worker reiniciando: a próxima interação reenvia */
    }
  }
  inFlight = false;
  renderMeta();
}

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
  el.status.textContent =
    source === 'default' ? 'Volume normal' : `Tocando em ${describeRule(active)} · ${source === 'tab' ? 'regra da aba' : 'regra do site'}`;

  const hasRule = scope === 'tab' ? Boolean(st.tabRule) : Boolean(st.siteRule);
  el.reset.hidden = !hasRule;
  el.ruleLabel.textContent = hasRule
    ? scope === 'tab'
      ? 'Volume próprio desta aba'
      : 'Salvo para o site'
    : scope === 'tab'
      ? 'Mexa no volume para criar a regra da aba'
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

el.sitesToggle.addEventListener('click', async () => {
  const open = el.sitesView.hidden;
  el.sitesView.hidden = !open;
  el.mainView.hidden = open;
  el.sitesToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    const res = await send({ type: 'listSites' });
    renderSites(res && res.ok ? res.sites : []);
  } else {
    selectScope(scope);
  }
});

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
