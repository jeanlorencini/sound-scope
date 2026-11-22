// Regras de volume: lógica pura, sem dependência das APIs do Chrome.
// Uma regra é { volume: 0..100, muted: boolean }.
// Prioridade: regra da aba > regra do site > padrão (100%).

export const DEFAULT_RULE = Object.freeze({ volume: 100, muted: false });

const CONTROLLABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

/** Chave do site para uma URL (hostname sem "www."), ou null se a página não é controlável. */
export function siteKey(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!CONTROLLABLE_PROTOCOLS.has(u.protocol)) return null;
  if (u.protocol === 'file:') return 'file://';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  return host || null;
}

export function clampVolume(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_RULE.volume;
  return Math.min(100, Math.max(0, n));
}

/** Normaliza uma regra vinda de fora (popup/armazenamento). Retorna null se inválida. */
export function sanitizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  return { volume: clampVolume(rule.volume), muted: rule.muted === true };
}

export function isDefaultRule(rule) {
  return !rule || (rule.volume === 100 && !rule.muted);
}

/** Decide qual regra vale. */
export function resolveRule({ tabRule, siteRule } = {}) {
  if (tabRule) return { source: 'tab', rule: tabRule };
  if (siteRule) return { source: 'site', rule: siteRule };
  return { source: 'default', rule: DEFAULT_RULE };
}

/** Fator multiplicador aplicado ao áudio da página (0..1). */
export function gainOf(rule) {
  if (!rule || rule.muted) return rule ? 0 : 1;
  return clampVolume(rule.volume) / 100;
}

/** Texto do selo do ícone: vazio quando o volume é o normal. */
export function badgeText(rule) {
  if (isDefaultRule(rule)) return '';
  if (rule.muted || rule.volume === 0) return '×';
  return String(rule.volume);
}

/** Alterna o mudo do SoundScope mantendo o volume (tirar o mudo em 0% volta para 50%). */
export function toggleMuteRule(rule) {
  const r = sanitizeRule(rule) ?? { ...DEFAULT_RULE };
  return r.muted ? { volume: r.volume === 0 ? 50 : r.volume, muted: false } : { ...r, muted: true };
}

const hostText = (host) => (host === 'file://' ? 'arquivos locais' : host);

/** Título do ícone: descreve o estado mesmo quando o selo está vazio. */
export function titleText({ source, rule, host } = {}) {
  if (!host || !rule || (source === 'default' && isDefaultRule(rule))) return 'SoundScope';
  const silent = rule.muted || rule.volume === 0;
  const value = silent ? 'silenciado' : `${rule.volume}%`;
  if (source === 'tab') return `SoundScope — ${value} nesta aba`;
  if (source === 'site') return `SoundScope — ${value} em ${hostText(host)} (site)`;
  if (source === 'default-user') return `SoundScope — volume padrão ${silent ? '0% (silenciado)' : value}`;
  return `SoundScope — ${value}`;
}
