import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, applyCommand, describeCommands, shortcutParts } from '../src/lib/commands.js';
import { titleText, toggleMuteRule } from '../src/lib/rules.js';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('CA3.1: passos de 10 limitados a 0..100, sempre inteiros', () => {
  const v = (volume, cmd) => applyCommand({ volume, muted: false }, cmd).volume;
  assert.equal(v(40, 'volume-up'), 50);
  assert.equal(v(95, 'volume-up'), 100);
  assert.equal(v(100, 'volume-up'), 100);
  assert.equal(v(5, 'volume-down'), 0);
  assert.equal(v(0, 'volume-down'), 0);
  assert.equal(v(42.4, 'volume-up'), 52);
  assert.equal(applyCommand(null, 'volume-down').volume, 90, 'sem regra parte de 100%');
  assert.equal(applyCommand({ volume: 50 }, 'outro'), null);
});

test('CA3.2: subir ou descer o volume tira o mudo do SoundScope', () => {
  assert.deepEqual(applyCommand({ volume: 30, muted: true }, 'volume-up'), { volume: 40, muted: false });
  assert.deepEqual(applyCommand({ volume: 30, muted: true }, 'volume-down'), { volume: 20, muted: false });
});

test('CA3.3: alternar o mudo mantém o volume; em 0% volta para 50% (mesma regra do popup)', () => {
  assert.deepEqual(applyCommand({ volume: 70, muted: false }, 'toggle-mute'), { volume: 70, muted: true });
  assert.deepEqual(applyCommand({ volume: 70, muted: true }, 'toggle-mute'), { volume: 70, muted: false });
  assert.deepEqual(toggleMuteRule({ volume: 0, muted: true }), { volume: 50, muted: false });
  assert.deepEqual(toggleMuteRule({ volume: 0, muted: false }), { volume: 0, muted: true });
});

test('CA3.6: título do ícone descreve o estado', () => {
  const r = (volume, muted = false) => ({ volume, muted });
  assert.equal(titleText({ source: 'site', rule: r(50), host: 'exemplo.com' }), 'SoundScope — 50% em exemplo.com (site)');
  assert.equal(titleText({ source: 'tab', rule: r(50, true), host: 'exemplo.com' }), 'SoundScope — silenciado nesta aba');
  assert.equal(titleText({ source: 'tab', rule: r(0), host: 'x.com' }), 'SoundScope — silenciado nesta aba');
  assert.equal(titleText({ source: 'default', rule: r(100), host: 'x.com' }), 'SoundScope');
  assert.equal(titleText({ source: 'site', rule: r(100), host: 'file://' }), 'SoundScope — 100% em arquivos locais (site)');
  assert.equal(titleText({ source: 'site', rule: r(20), host: null }), 'SoundScope');
});

test('CA3.10: manifesto tem os comandos com descrição em pt-BR e no máximo 4 teclas sugeridas', () => {
  const cmds = manifest.commands;
  assert.deepEqual(Object.keys(cmds), COMMANDS.map((c) => c.name));
  for (const c of COMMANDS) assert.equal(cmds[c.name].description, c.description);
  assert.ok(Object.values(cmds).filter((c) => c.suggested_key).length <= 4);
  assert.equal(cmds['volume-up'].suggested_key.default, 'Alt+Shift+Up');
  assert.equal(cmds['volume-down'].suggested_key.default, 'Alt+Shift+Down');
  assert.equal(cmds['toggle-mute'].suggested_key.default, 'Alt+Shift+M');
  assert.deepEqual(manifest.permissions, ['storage', 'scripting'], 'nenhuma permissão nova');
});
