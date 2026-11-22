// Falha se o pacote da extensão passar do limite (60 KB = 61.440 bytes).
// Uso: npm run size
import { fileURLToPath } from 'node:url';
import { buildZip } from './zip.mjs';

export const LIMIT = 60 * 1024;

const fmt = (bytes) =>
  `${bytes.toLocaleString('pt-BR')} B (${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB)`;

export function checkSize({ limit = LIMIT, bytes = buildZip().length } = {}) {
  const ok = bytes <= limit;
  const message = `pacote ${fmt(bytes)} ${ok ? '≤' : '>'} limite ${fmt(limit)}`;
  return { ok, bytes, limit, message };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = checkSize();
  console.log(r.ok ? `✔ ${r.message}` : `✘ ${r.message}`);
  if (!r.ok) process.exitCode = 1;
}
