// Teste ponta a ponta no Chrome real (opcional, não entra no `npm test`).
// Uso: npm i --no-save puppeteer && npm run e2e
// Carrega a extensão, abre páginas em dois "sites" (localhost e 127.0.0.1) e confere
// o volume real dos <audio> lendo pelo mundo isolado (sem o patch da página).
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const puppeteer = (await import('puppeteer')).default;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = process.env.E2E_SHOTS || '';

const PAGE = `<!doctype html><meta charset="utf-8"><title>p</title>
<audio id="a"></audio>
<script>
  const a = document.getElementById('a');
  a.volume = 0.8; // o próprio site define o volume do player
  window.pageSeen = () => a.volume;
</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const step = (msg) => console.log(`✔ ${msg}`);

try {
  const extId = await browser.installExtension(ROOT);
  step(`extensão carregada (${extId})`);
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId));
  assert.ok(sw);

  const open = async (url) => {
    const p = await browser.newPage();
    await p.goto(url, { waitUntil: 'load' });
    return p;
  };
  const a1 = await open(`http://localhost:${port}/um`);
  const a2 = await open(`http://localhost:${port}/dois`);
  const b1 = await open(`http://127.0.0.1:${port}/tres`);

  // Página da extensão para falar com o service worker como o popup faz.
  const ext = await open(`chrome-extension://${extId}/src/popup/popup.html`);
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const tabIdOf = async (p) => {
    const url = p.url();
    return ext.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, url);
  };
  const [t1, t2, t3] = [await tabIdOf(a1), await tabIdOf(a2), await tabIdOf(b1)];

  const real = (p) => p.mainFrame().isolatedRealm().evaluate(() => document.getElementById('a').volume);
  const seen = (p) => p.evaluate(() => window.pageSeen());
  const settle = () => new Promise((r) => setTimeout(r, 150));

  assert.equal(await real(a1), 0.8);

  // 1) Volume do site inteiro: todas as abas de localhost, e não 127.0.0.1
  let st = await send({ type: 'set', tabId: t1, scope: 'site', rule: { volume: 50, muted: false } });
  assert.equal(st.ok, true);
  await settle();
  assert.equal(await real(a1), 0.4);
  assert.equal(await real(a2), 0.4);
  assert.equal(await real(b1), 0.8);
  assert.equal(await seen(a1), 0.8, 'o site continua vendo o volume dele');
  step('volume por site aplicado em todas as abas do domínio');

  // 2) Volume só desta aba sobrepõe o do site
  await send({ type: 'set', tabId: t2, scope: 'tab', rule: { volume: 25, muted: false } });
  await settle();
  assert.equal(await real(a2), 0.2);
  assert.equal(await real(a1), 0.4);
  step('volume por aba sobrepõe o do site só naquela aba');

  // 3) Recarregar mantém as regras; navegar para outro domínio mantém a regra da aba
  await a1.reload({ waitUntil: 'load' });
  await settle();
  assert.equal(await real(a1), 0.4);
  await a2.goto(`http://127.0.0.1:${port}/outro`, { waitUntil: 'load' });
  await settle();
  assert.equal(await real(a2), 0.2);
  step('regras sobrevivem a recarregar e a regra da aba segue a aba entre domínios');

  // 4) Mudo
  await send({ type: 'set', tabId: t3, scope: 'site', rule: { volume: 60, muted: true } });
  await settle();
  assert.equal(await real(b1), 0);
  assert.equal(await seen(b1), 0.8);
  step('silenciar zera o som do site');

  // 5) Página altera o próprio volume depois: continua escalado
  await a1.evaluate(() => (document.getElementById('a').volume = 0.6));
  assert.equal(await real(a1), 0.3);
  step('mudanças de volume feitas pelo site continuam respeitando a regra');

  // 6) Remover regra restaura
  await send({ type: 'removeSite', host: 'localhost' });
  await settle();
  assert.equal(await real(a1), 0.6);
  step('remover a regra restaura o volume original');

  // 7) Interações reais no popup, apontando para a aba a1 (simula o clique no ícone)
  await send({ type: 'set', tabId: t1, scope: 'site', rule: { volume: 65, muted: false } });
  const pop = await browser.newPage();
  await pop.setViewport({ width: 320, height: 470, deviceScaleFactor: 2 });
  await pop.evaluateOnNewDocument((id) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info && info.active ? [await chrome.tabs.get(id)] : q(info));
  }, t1);
  await pop.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'networkidle0' });
  await settle();
  const text = (sel) => pop.$eval(sel, (e) => e.textContent.trim());
  assert.equal(await text('#host'), 'localhost');
  assert.equal(await pop.$eval('#slider', (e) => e.value), '65');
  await settle();
  assert.equal(await real(a1), 0.39); // 0.6 do site × 65%

  await pop.click('[data-scope="tab"]');
  await pop.click('[data-preset="25"]');
  await settle();
  assert.equal(await real(a1), 0.15);
  assert.equal(await real(a2), 0.2, 'outra aba não muda');
  await pop.focus('#slider');
  await pop.keyboard.press('ArrowRight'); // 26%
  await settle();
  assert.equal(Math.round((await real(a1)) * 1000), 156);
  await pop.keyboard.press('m');
  await settle();
  assert.equal(await real(a1), 0);
  assert.equal(await pop.$eval('#mute', (e) => e.getAttribute('aria-pressed')), 'true');

  await pop.click('[data-scope="site"]');
  assert.equal(await pop.$eval('#override', (e) => e.hidden), false, 'avisa que a aba sobrepõe o site');
  await pop.click('#clearTabFromSite');
  await settle();
  assert.equal(await real(a1), 0.39);
  step('popup: escopo, atalhos, teclado, mudo e "usar o do site" funcionam');

  // Capturas do popup (opcional)
  if (SHOTS) {
    for (const scheme of ['light', 'dark']) {
      await pop.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await pop.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'networkidle0' });
      await settle();
      await pop.screenshot({ path: `${SHOTS}/popup-${scheme}.png` });
    }
    await pop.click('#sitesToggle');
    await settle();
    await pop.screenshot({ path: `${SHOTS}/popup-sites.png` });
    step(`capturas salvas em ${SHOTS}`);
  }

  console.log('\nE2E OK');
} finally {
  await browser.close();
  server.close();
}
