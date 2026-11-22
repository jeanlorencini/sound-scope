# SoundScope

Extensão do Google Chrome para controlar o volume **por site** e **por aba**, leve e sem dependências.

- **Site inteiro** — o volume vale para todas as abas daquele domínio (ex.: todo `youtube.com`) e fica salvo.
- **Só esta aba** — o volume vale só para aquela aba, mesmo que ela navegue para outro site. Some quando a aba é fechada.
- **Volume padrão** — opcional, vale para os sites que ainda não têm volume salvo.
- Ordem de prioridade: **aba > site > volume padrão > 100%**. Sem nenhuma regra e sem padrão, o site toca normal (100%).

## Como usar

1. Clique no ícone do SoundScope (ou `Alt+Shift+V`).
2. Escolha **Site inteiro** ou **Só esta aba**.
3. Ajuste no controle deslizante, nos atalhos (10/25/50/75/100), com as setas, com a roda do mouse ou silencie com o botão (tecla `M`).

O ícone mostra o volume aplicado na aba (`40`, ou `×` quando silenciado), e o título do ícone descreve o estado (ex.: “SoundScope — 50% em exemplo.com (site)”). Em ☰ você vê e remove os sites salvos e define o volume padrão.

### Atalhos globais

Funcionam com o popup fechado, na aba ativa. O resultado aparece no ícone.

| Atalho sugerido | Ação |
|---|---|
| `Alt+Shift+V` | Abrir o SoundScope |
| `Alt+Shift+↑` | Aumentar o volume em 10 |
| `Alt+Shift+↓` | Diminuir o volume em 10 |
| `Alt+Shift+M` | Silenciar ou ativar o som |

Se a aba tem volume próprio, o atalho muda só a aba; senão, muda o site inteiro. O atalho mexe só no volume do SoundScope: o mudo do próprio Chrome (clique direito na aba → “Desativar som do site”) não é alterado. Veja e troque as teclas no botão de teclado do popup (“Seus atalhos”) ou em `chrome://extensions/shortcuts`. Se uma tecla já estiver em uso, o Chrome a deixa vazia e o painel mostra “Não definido”.

### Tocando agora

O popup lista as outras abas com som, em todas as janelas. **Silenciar as outras** silencia todas, menos a aba atual, criando um volume próprio só para cada aba (os sites salvos não mudam). Cada aba silenciada continua na lista com um botão para devolver exatamente o volume que tinha antes.

### Volume padrão

Em ☰, o controle **Volume padrão** vale para todos os sites que ainda não têm volume salvo. Sites salvos e abas com volume próprio não mudam. Não existe “mudo padrão”: em 0% o site fica em silêncio, mas basta subir o controle. **Redefinir padrão** volta para 100%.

## Instalar (modo desenvolvedor)

1. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e selecione esta pasta.

Para publicar na Chrome Web Store: `npm run pack` gera `dist/sound-scope-<versão>.zip`.

Requer Chrome 116 ou mais recente.

## Como funciona

- Um script na página (`src/content/inject.js`, mundo `MAIN`, `document_start`) multiplica o volume de cada `<audio>`/`<video>` pelo fator escolhido. O site continua lendo o volume que ele mesmo definiu, então o controle do player não “pula”.
- Áudio feito com Web Audio (jogos, alguns players) passa por um `GainNode` por contexto antes da saída.
- `src/content/bridge.js` (mundo isolado) recebe o fator do service worker e repassa à página por um nó privado, fora do DOM, entregue uma única vez em `document_start`. Eventos `soundscope:*` que o site dispara no `document` são ignorados, então o site não consegue desfazer o mudo nem ler o volume escolhido.
- `src/background.js` guarda as regras (`storage.local` para sites, `storage.session` para abas), avisa as abas quando algo muda e atualiza o selo do ícone. Abas abertas antes da instalação recebem os scripts automaticamente.
- iframes (ex.: vídeo incorporado) seguem a regra do site da aba, não do iframe.

Sem `tabCapture`: não aparece o indicador de “compartilhando aba”, não precisa de clique por aba e não processa áudio fora da página. Pacote de 28,1 KB (28.744 bytes, medido com `npm run pack`), sem bibliotecas. O limite é 60 KB e o `npm test` falha se ele for ultrapassado.

Permissões: `storage` (salvar regras), `scripting` (ativar em abas já abertas) e acesso aos sites (aplicar o volume nas páginas). Nada é enviado para fora do navegador.

### Limites conhecidos

- O volume vai de 0% a 100% (não amplifica acima do original).
- Páginas internas do Chrome (`chrome://`, Chrome Web Store) não permitem extensões.
- Um site feito de propósito para driblar o SoundScope roda no mesmo mundo da página e pode contornar o controle (por exemplo, guardando o `volume` nativo de um iframe novo). Iframes `about:blank` que a página-mãe cria e usa antes do `document_start` entram nesse mesmo caso.
- Em abas abertas **antes** da instalação ou atualização, os scripts entram com a página já rodando. Um site preparado de antemão pode capturar o canal dessa aba até ela ser recarregada. Sites comuns não são afetados.
- Mídia dentro de shadow DOM fechado que nunca chama `play()` pelo script pode escapar da detecção inicial; ela é ajustada assim que dispara eventos de mídia.

## Desenvolvimento

```bash
npm test            # testes unitários (node:test, sem dependências), inclui segurança e tamanho
npm run size        # confere se o pacote está dentro de 60 KB
npm run icons       # regera os ícones PNG
npm run pack        # gera o .zip para a Web Store

# Prévia do popup com chrome.* simulado (layout/acessibilidade, fora do pacote)
node test/fixtures/popup-preview.mjs   # abre em http://127.0.0.1:8765/src/popup/popup.html?tabs=10&long=1

# Ponta a ponta no Chrome real (opcional)
npm i --no-save puppeteer && npm run e2e
```

Estrutura:

```
manifest.json
src/background.js        service worker (regras, abas, selo)
src/lib/rules.js         lógica pura das regras
src/lib/commands.js      lógica pura dos atalhos
src/content/inject.js    controle de volume na página
src/content/bridge.js    ponte página ⇄ extensão
src/popup/               interface
scripts/                 ícones, empacotamento (zip.mjs), limite de tamanho, e2e
test/                    testes unitários
```
