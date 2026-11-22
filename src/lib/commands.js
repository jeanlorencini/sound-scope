// Atalhos globais (chrome.commands): lógica pura, sem dependência das APIs do Chrome.
import { clampVolume, sanitizeRule, toggleMuteRule } from './rules.js';

export const STEP = 10;

/** Comandos do manifesto, na ordem do painel "Seus atalhos". */
export const COMMANDS = Object.freeze([
  { name: '_execute_action', description: 'Abrir o SoundScope' },
  { name: 'volume-up', description: 'Aumentar o volume do site (+10)' },
  { name: 'volume-down', description: 'Diminuir o volume do site (−10)' },
  { name: 'toggle-mute', description: 'Silenciar ou ativar o som do site' },
]);

/** Regra nova depois do comando, ou null se o comando não é do SoundScope. */
export function applyCommand(rule, command) {
  const r = sanitizeRule(rule) ?? { volume: 100, muted: false };
  if (command === 'volume-up') return { volume: clampVolume(r.volume + STEP), muted: false };
  if (command === 'volume-down') return { volume: clampVolume(r.volume - STEP), muted: false };
  if (command === 'toggle-mute') return toggleMuteRule(r);
  return null;
}

const KEY_NAMES = { Up: '↑', Down: '↓', Left: '←', Right: '→', Comma: ',', Period: '.', Space: 'Espaço' };

/** "Alt+Shift+Up" → ["Alt", "Shift", "↑"]. Vazio → []. (No macOS o Chrome usa "⌥⇧V".) */
export function shortcutParts(shortcut) {
  if (typeof shortcut !== 'string' || !shortcut.trim()) return [];
  const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut];
  return parts.map((p) => p.trim()).filter(Boolean).map((p) => KEY_NAMES[p] ?? p);
}

/** Junta a lista de chrome.commands.getAll() com as descrições em pt-BR. */
export function describeCommands(list) {
  const byName = new Map((Array.isArray(list) ? list : []).map((c) => [c.name, c]));
  return COMMANDS.map(({ name, description }) => {
    const c = byName.get(name);
    return { name, description: (c && c.description) || description, keys: shortcutParts(c && c.shortcut) };
  });
}
