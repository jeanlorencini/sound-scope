// Gera dist/sound-scope-<versão>.zip pronto para a Chrome Web Store (sem dependências).
// Uso: npm run pack
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, buildZip, listFiles } from './zip.mjs';

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const files = listFiles();
mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', `sound-scope-${manifest.version}.zip`);
const zip = buildZip(files);
writeFileSync(out, zip);
console.log(`${relative(ROOT, out)} — ${files.length} arquivos, ${(zip.length / 1024).toFixed(1)} KB`);
