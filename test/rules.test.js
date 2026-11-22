import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RULE,
  badgeText,
  defaultRuleOf,
  clampVolume,
  gainOf,
  isDefaultRule,
  resolveRule,
  sanitizeDefault,
  sanitizeRule,
  siteKey,
} from '../src/lib/rules.js';

test('siteKey normaliza o host e ignora www', () => {
  assert.equal(siteKey('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(siteKey('http://music.youtube.com/'), 'music.youtube.com');
  assert.equal(siteKey('http://localhost:8080/x'), 'localhost');
  assert.equal(siteKey('file:///home/a.mp3'), 'file://');
});

test('siteKey rejeita páginas que o Chrome não deixa controlar', () => {
  for (const url of ['chrome://extensions', 'about:blank', 'chrome-extension://abc/x.html', '', undefined, 'lixo']) {
    assert.equal(siteKey(url), null, String(url));
  }
});

test('clampVolume limita a 0..100 e arredonda', () => {
  assert.equal(clampVolume(150), 100);
  assert.equal(clampVolume(-3), 0);
  assert.equal(clampVolume('42.6'), 43);
  assert.equal(clampVolume(NaN), 100);
});

test('sanitizeRule aceita só objetos e normaliza campos', () => {
  assert.equal(sanitizeRule(null), null);
  assert.equal(sanitizeRule(5), null);
  assert.deepEqual(sanitizeRule({ volume: 300, muted: 'sim' }), { volume: 100, muted: false });
  assert.deepEqual(sanitizeRule({ volume: 30, muted: true, extra: 1 }), { volume: 30, muted: true });
});

test('resolveRule: aba > site > padrão', () => {
  const tabRule = { volume: 20, muted: false };
  const siteRule = { volume: 60, muted: false };
  assert.deepEqual(resolveRule({ tabRule, siteRule }), { source: 'tab', rule: tabRule });
  assert.deepEqual(resolveRule({ siteRule }), { source: 'site', rule: siteRule });
  assert.deepEqual(resolveRule({}), { source: 'default', rule: DEFAULT_RULE });
  assert.deepEqual(resolveRule(), { source: 'default', rule: DEFAULT_RULE });
});

test('gainOf converte regra em fator e respeita o mudo', () => {
  assert.equal(gainOf({ volume: 40, muted: false }), 0.4);
  assert.equal(gainOf({ volume: 40, muted: true }), 0);
  assert.equal(gainOf(DEFAULT_RULE), 1);
  assert.equal(gainOf(null), 1);
});

test('badgeText some no volume normal e mostra × quando mudo', () => {
  assert.equal(badgeText(DEFAULT_RULE), '');
  assert.equal(badgeText({ volume: 35, muted: false }), '35');
  assert.equal(badgeText({ volume: 35, muted: true }), '×');
  assert.equal(badgeText({ volume: 0, muted: false }), '×');
  assert.ok(isDefaultRule(null));
  assert.ok(!isDefaultRule({ volume: 100, muted: true }));
});

// ---- Volume padrão (R5) --------------------------------------------------------

test('CA5.1: precedência aba > site > padrão do usuário > 100%', () => {
  const tabRule = { volume: 10, muted: false };
  const siteRule = { volume: 20, muted: false };
  const defaultRule = defaultRuleOf(60);
  assert.equal(resolveRule({ tabRule, siteRule, defaultRule }).source, 'tab');
  assert.equal(resolveRule({ siteRule, defaultRule }).source, 'site');
  assert.deepEqual(resolveRule({ defaultRule }), { source: 'default-user', rule: { volume: 60, muted: false } });
  assert.deepEqual(resolveRule({ defaultRule: null }), { source: 'default', rule: DEFAULT_RULE });
});

test('CA5.4/5.8: sanitizeDefault aceita só 0..100 e trata 100 como "sem padrão"', () => {
  assert.equal(sanitizeDefault(60), 60);
  assert.equal(sanitizeDefault(0), 0);
  assert.equal(sanitizeDefault(42.6), 43);
  assert.equal(sanitizeDefault(100), null);
  for (const bad of [undefined, null, '60', NaN, Infinity, -1, 101, {}, true]) assert.equal(sanitizeDefault(bad), null, String(bad));
  assert.deepEqual(defaultRuleOf(0), { volume: 0, muted: false });
  assert.equal(badgeText(defaultRuleOf(0)), '×');
  assert.equal(badgeText(defaultRuleOf(60)), '60');
});
