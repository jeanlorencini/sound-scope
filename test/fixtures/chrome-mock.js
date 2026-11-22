// Simulação mínima de chrome.* para abrir o popup fora da extensão (só desenvolvimento).
// Cenários pela query string: ?tabs=10&long=1&protected=1&default=60&empty=1
(() => {
  const q = new URLSearchParams(location.search);
  const n = q.has('empty') ? 0 : Number(q.get('tabs') || 3);
  const long = q.has('long');
  const state = { defaultVolume: q.has('default') ? Number(q.get('default')) : null, silenced: new Set(), sites: { 'youtube.com': 40 } };
  const active = q.has('protected')
    ? { id: 1, url: 'chrome://settings', title: 'Configurações' }
    : { id: 1, url: 'https://www.youtube.com/watch?v=1', title: 'YouTube', favIconUrl: '' };
  const others = Array.from({ length: n }, (_, i) => ({
    tabId: 10 + i,
    title: long ? `Uma aba com um título muito, muito comprido que não cabe na largura — nº ${i + 1}` : `Aba ${i + 1}`,
    host: i === 2 ? null : `site${i + 1}.example.com`,
    favIconUrl: '',
  }));
  const item = (o) => ({ ...o, controllable: Boolean(o.host), silenced: state.silenced.has(o.tabId), effectiveRule: { volume: 100, muted: false } });
  const getState = () => {
    if (active.url.startsWith('chrome:')) return { ok: true, tabId: 1, controllable: false, host: null, effective: { source: 'default', rule: { volume: 100, muted: false } } };
    const siteRule = state.sites['youtube.com'] != null ? { volume: state.sites['youtube.com'], muted: false } : null;
    const def = state.defaultVolume != null ? { volume: state.defaultVolume, muted: false } : null;
    const effective = siteRule ? { source: 'site', rule: siteRule } : def ? { source: 'default-user', rule: def } : { source: 'default', rule: { volume: 100, muted: false } };
    return { ok: true, tabId: 1, controllable: true, injected: true, host: 'youtube.com', siteRule, tabRule: null, defaultVolume: state.defaultVolume, effective };
  };
  const handlers = {
    getState,
    set: (m) => {
      if (m.scope === 'site') state.sites['youtube.com'] = m.rule.volume;
      return getState();
    },
    clear: () => (delete state.sites['youtube.com'], getState()),
    listPlaying: () => ({ ok: true, items: others.map(item) }),
    silenceOthers: () => {
      const t = others.filter((o) => o.host && !state.silenced.has(o.tabId));
      t.forEach((o) => state.silenced.add(o.tabId));
      return { ok: true, count: t.length, items: others.map(item) };
    },
    toggleTabMute: ({ tabId }) => {
      state.silenced.has(tabId) ? state.silenced.delete(tabId) : state.silenced.add(tabId);
      return { ok: true, item: item(others.find((o) => o.tabId === tabId)) };
    },
    listSites: () => ({ ok: true, defaultVolume: state.defaultVolume, sites: Object.entries(state.sites).map(([host, volume]) => ({ host, volume, muted: false })) }),
    removeSite: ({ host }) => (delete state.sites[host], handlers.listSites()),
    setDefault: ({ volume }) => ((state.defaultVolume = volume === 100 ? null : volume), { ok: true, defaultVolume: state.defaultVolume }),
    clearDefault: () => ((state.defaultVolume = null), { ok: true, defaultVolume: null }),
  };
  const ev = () => ({ addListener() {} });
  window.__opened = [];
  window.chrome = {
    runtime: { sendMessage: async (m) => structuredClone(handlers[m.type](m)) },
    tabs: { query: async () => [active], onUpdated: ev(), onRemoved: ev(), create: async (o) => window.__opened.push(o.url) },
    commands: {
      getAll: async () => [
        { name: '_execute_action', description: '', shortcut: 'Alt+Shift+V' },
        { name: 'volume-up', description: 'Aumentar o volume do site (+10)', shortcut: 'Alt+Shift+Up' },
        { name: 'volume-down', description: 'Diminuir o volume do site (−10)', shortcut: 'Alt+Shift+Down' },
        { name: 'toggle-mute', description: 'Silenciar ou ativar o som do site', shortcut: '' },
      ],
    },
  };
})();
