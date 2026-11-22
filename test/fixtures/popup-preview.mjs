// Serve o popup com chrome.* simulado para conferir layout e acessibilidade no navegador.
// Uso: node test/fixtures/popup-preview.mjs [porta]  →  http://127.0.0.1:<porta>/src/popup/popup.html?tabs=10&long=1
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const port = Number(process.argv[2] || 8765);

http
  .createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..')) return res.writeHead(403).end();
    try {
      let body = await readFile(join(ROOT, path));
      if (path.endsWith('popup.html')) {
        body = String(body).replace('<script type="module"', '<script src="/test/fixtures/chrome-mock.js"></script>\n    <script type="module"');
      }
      res.writeHead(200, { 'content-type': `${TYPES[extname(path)] || 'application/octet-stream'}; charset=utf-8` }).end(body);
    } catch {
      res.writeHead(404).end('não encontrado');
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/src/popup/popup.html`));
