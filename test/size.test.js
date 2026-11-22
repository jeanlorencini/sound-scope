// Limite de tamanho do pacote (R2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMIT, checkSize } from '../scripts/check-size.mjs';
import { INCLUDE, buildZip, listFiles } from '../scripts/zip.mjs';

test('CA2.1: o pacote real tem até 60 KB (61.440 bytes)', () => {
  assert.equal(LIMIT, 61440);
  const r = checkSize();
  assert.ok(r.ok, r.message);
  assert.equal(r.bytes, buildZip().length);
});

test('CA2.3: a verificação reprova quando o pacote passa do limite', () => {
  const { bytes } = checkSize();
  const r = checkSize({ limit: bytes - 1 });
  assert.equal(r.ok, false);
  assert.match(r.message, /^pacote [\d.]+ B \([\d,]+ KB\) > limite [\d.]+ B \([\d,]+ KB\)$/);
  assert.equal(checkSize({ limit: 61440, bytes: 61441 }).ok, false);
  assert.equal(checkSize({ limit: 61440, bytes: 61440 }).ok, true);
});

test('CA2.2: pack e verificação usam a mesma lista de arquivos', () => {
  assert.deepEqual(INCLUDE, ['manifest.json', 'icons', 'src']);
  const names = listFiles().map((f) => f.replace(/\\/g, '/'));
  assert.ok(names.some((f) => f.endsWith('/manifest.json')));
  assert.ok(names.some((f) => f.endsWith('/src/background.js')));
  assert.ok(!names.some((f) => /\/(test|scripts|dist)\//.test(f)), 'nada de teste ou script no pacote');
});
