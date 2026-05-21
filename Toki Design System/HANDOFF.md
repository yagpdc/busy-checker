# Handoff — Tornar o Toki temável

Este documento é um briefing para o **Claude Code** (ou outro agente de dev) implementar o sistema de temas do Toki no codebase real (`busy-checker/`).

A "fonte da verdade" visual está neste projeto: **`Toki Design System`**. O agente deve lê-la inteira antes de tocar no código de produção.

---

## O que precisa ser feito (em uma linha)

Refatorar o CSS da extensão para usar **CSS custom properties** (em vez de hex hard-coded), e adicionar **7 temas** (default, terminal, doodle, washi, aqua, jornal, cyberpunk) com um seletor de tema na tela de Configurações.

---

## Onde estão as referências

Neste projeto (`Toki Design System`):

| Arquivo | Para quê |
|---|---|
| `README.md` | Voz, tom, fundamentos visuais, iconografia. |
| `colors_and_type.css` | **Os tokens canônicos** — copie isso direto para o repo da extensão. |
| `ui_kits/extension/index.html` | Recriação temável do popup + widget. **Contém os 7 temas inteiros num único `<style>`.** Para extrair, copie cada bloco `.toki[data-theme="X"] { ... }` para o seu próprio arquivo. |
| `preview/*.html` | Cards do design system — uma vista atômica de cada componente. Útil para checar fidelidade visual durante o refactor. |
| `_ref/popup.css`, `_ref/popup.html`, `_ref/popup.ts`, `_ref/chat-google.ts`, `_ref/manifest.json` | Snapshot somente leitura do código atual do busy-checker, pra referência. |

---

## Arquivos do `busy-checker/` que vão mudar

```
busy-checker/extension/
├── manifest.json                           ← talvez (web_accessible_resources)
├── src/
│   ├── popup.css                           ← refatorar para usar var(--token)
│   ├── popup.html                          ← adicionar <link> para o tema ativo
│   ├── popup.ts                            ← carregar/persistir tema; adicionar seletor na tela de Configurações
│   ├── chat-google.ts                      ← o WIDGET_HTML inline tem ~600 linhas de CSS; mesmo refactor
│   ├── settings.ts                         ← novo campo `theme: ThemeName`
│   └── themes/                             ← NOVO
│       ├── _tokens.css                     ← copia de colors_and_type.css
│       ├── default.css
│       ├── terminal.css
│       ├── doodle.css
│       ├── washi.css
│       ├── aqua.css
│       ├── jornal.css
│       └── cyberpunk.css
├── copy-assets.mjs                         ← adicionar copia da pasta themes/
```

---

## Passo a passo

### 1. Tokens
- Copiar `colors_and_type.css` (deste projeto) para `extension/src/themes/_tokens.css`.
- Esse arquivo define as variáveis canônicas (`--ink`, `--gray-1`, `--fg-1`, `--font-ui`, `--font-kanji`, `--r-card`, etc.) usadas pelo tema **default**.

### 2. Refactor do `popup.css`
Cada hex no arquivo atual mapeia para um token:

| Hex atual | Vira |
|---|---|
| `#111827` | `var(--ink)` ou `var(--fg-1)` |
| `#1f2937` | `var(--ink-2)` |
| `#374151` | `var(--ink-3)` |
| `#6b7280` | `var(--gray-1)` ou `var(--fg-2)` |
| `#9ca3af` | `var(--gray-2)` ou `var(--fg-3)` |
| `#d1d5db` | `var(--gray-3)` ou `var(--border-strong)` |
| `#e5e7eb` | `var(--gray-4)` ou `var(--border)` |
| `#f3f4f6` | `var(--gray-5)` ou `var(--bg-chip)` |
| `#fafafa` | `var(--off-white)` ou `var(--bg-sunken)` |
| `#dc2626` | `var(--red)` ou `var(--danger)` |
| `#f97316` | `var(--orange)` ou `var(--now-line)` |
| `#3b82f6` | `var(--blue-event)` |

Border-radius, fontes, shadows: igual tudo via token. Veja `colors_and_type.css` para a lista completa.

**Importante:** não inline mais nenhum hex em popup.css. Se faltar um token, adicione em `_tokens.css`.

### 3. Refactor do `chat-google.ts` (WIDGET_HTML)
Mesmo trabalho, com uma sutileza: o widget vive dentro de um **shadow DOM**. Variáveis CSS atravessam shadow DOM via `:host`, então:
- Em vez de injetar o `<style>` inline no shadow root, **importe** os 3 arquivos: `_tokens.css` + `<theme>.css` + `widget-base.css` (que vai conter o atual `WIDGET_HTML` style refatorado, mas usando vars).
- Para isso, no `manifest.json`, exponha a pasta `themes/` via `web_accessible_resources`:
  ```json
  "web_accessible_resources": [{
    "resources": ["themes/*.css", "widget-base.css"],
    "matches": ["https://chat.google.com/*"]
  }]
  ```
- No `chat-google.ts`, busque os arquivos com `chrome.runtime.getURL('themes/_tokens.css')` e injete `<link rel="stylesheet" href="...">` no shadow root.

### 4. Adicionar os outros 6 temas
Cada um vira um `themes/<nome>.css` que **só** sobrescreve variáveis no `:root` (e adiciona uma ou outra regra para decoração específica do tema).

Para extrair: vá ao `ui_kits/extension/index.html` deste projeto, ache o bloco `.toki[data-theme="terminal"] { ... }` e seus seletores filhos, e converta:

```css
/* Antes (no index.html do design system) */
.toki[data-theme="terminal"] {
  --c-bg: #0a0e14;
  --c-fg: #00ff9c;
  /* ... */
}
.toki[data-theme="terminal"] .popup,
.toki[data-theme="terminal"] .widget { ... }

/* Depois (em themes/terminal.css) */
:root {
  --ink: #00ff9c;
  --bg: #0a0e14;
  /* mapeia c-* (do design system) -> tokens canônicos (--ink, --bg, etc.) */
}
.popup, .widget { /* decoração específica do terminal */ }
```

**Mapeamento das chaves usadas no design system para os tokens canônicos:**

| `--c-*` (design system) | `--*` canônico |
|---|---|
| `--c-bg` | `--bg`, `--bg-elev` |
| `--c-bg-2` | `--bg-sunken` |
| `--c-bg-chip` | `--bg-chip` |
| `--c-fg` | `--fg-1` |
| `--c-fg-2` | `--fg-2` |
| `--c-fg-3` | `--fg-3` |
| `--c-border` | `--border` |
| `--c-border-2` | `--border-strong` |
| `--c-accent` | `--accent` |
| `--c-accent-fg` | `--accent-fg` |
| `--c-danger` | `--danger` |
| `--c-now` | `--now-line` |
| `--c-event` | `--info` |
| `--f-ui`, `--f-body`, `--f-display` | `--font-ui` |
| `--r-card`, `--r-button`, etc. | `--radius-card`, `--radius-button`, etc. |

### 5. Settings & loader
- Adicionar em `settings.ts`:
  ```ts
  type ThemeName = "default" | "terminal" | "doodle" | "washi" | "aqua" | "jornal" | "cyberpunk";
  type Settings = {
    // existentes...
    theme: ThemeName;
  };
  const DEFAULT_SETTINGS: Settings = {
    // ...
    theme: "default",
  };
  ```
- No `popup.ts`, ao carregar:
  ```ts
  const s = await getSettings();
  document.getElementById("theme-link")!.setAttribute("href", `themes/${s.theme}.css`);
  ```
  E em `popup.html` adicione `<link id="theme-link" rel="stylesheet" href="themes/default.css">`.
- Na tela de Configurações, adicionar um setting-row com um seletor (radio ou dropdown) para o tema. Salvar em `chrome.storage.local` via `setSettings`.
- No `chat-google.ts`, escutar `chrome.storage.onChanged` para o campo `settings.theme` e trocar o `<link>` injetado no shadow root quando o usuário mudar.

### 6. Decorações de tema (doodle, washi, cyber)
Alguns temas têm SVGs ou texturas. No design system esses SVGs estão **inline** no markup do index.html (flores, corações, etc.) controlados por CSS `display: none` no tema default. No código real, tem dois caminhos:

- **Opção A (simples)**: deixe os SVGs sempre no DOM e use `display: none` por padrão. O CSS de cada tema mostra os seus.
- **Opção B (mais limpa)**: cada tema injeta seu SVG via `::before` / `::after` com `background-image: url(...)`.

A opção B mantém o markup limpo mas exige inline SVG em data URI. Use B.

---

## Critérios de aceitação

- [ ] `extension/src/popup.css` não contém mais hex literais (exceto talvez em `box-shadow` rgba)
- [ ] `extension/src/chat-google.ts` carrega CSS de arquivos externos via shadow root, não inline
- [ ] Trocar o tema na tela de Configurações **reskina ao vivo** o popup e o widget (no Chat aberto), sem F5
- [ ] O tema sobrevive a um restart do navegador (lido de `chrome.storage.local`)
- [ ] Os 7 temas baixam todas as fontes do Google Fonts via `@import` em cada tema que precisa (terminal: JetBrains Mono; doodle: Caveat + Patrick Hand; washi: Noto Serif JP; jornal: Old Standard TT + Playfair Display; cyberpunk: Orbitron)
- [ ] Acessibilidade: pelo menos o tema default e o jornal passam contraste AA. Os outros são intencionalmente estilizados; documentar no README.

---

## Prompt pronto para colar no Claude Code

> Tenho um design system pronto para a extensão Toki em `<caminho-da-pasta-Toki-Design-System>`. Quero que você implemente 7 temas (default, terminal, doodle, washi, aqua, jornal, cyberpunk) no codebase atual em `<caminho-do-busy-checker>`.
>
> Leia primeiro:
> 1. `HANDOFF.md` desse design system — tem o plano passo a passo
> 2. `README.md` — voz e fundamentos
> 3. `colors_and_type.css` — tokens canônicos
> 4. `ui_kits/extension/index.html` — onde estão os 7 temas inteiros (procure por `.toki[data-theme="X"]`)
>
> Depois execute o plano do `HANDOFF.md` em ordem. Antes de cada commit, rode `npm run build` na pasta `extension/` e verifique que não há erros TS. Quando terminar, abra `chrome://extensions`, recarregue a unpacked, e teste cada tema no popup + no widget injetado em `chat.google.com`.
>
> Pergunte se algo no plano não estiver claro antes de improvisar — alguns temas (doodle, cyber) têm decorações específicas que precisam ser portadas com cuidado.

---

## Notas finais

- O design system foi escrito para que o **layout** (espaçamento, hierarquia, comportamento) fique idêntico entre temas. Mudam só cor, tipografia, raios e decoração — não a posição dos elementos.
- A tipografia japonesa (時 kanji) é mantida em todos os temas para preservar a identidade da marca. Só o **peso** muda em alguns (`--kanji-weight: 700` no cyberpunk e jornal).
- O tema doodle quebra deliberadamente a regra "sem emoji/sem decoração" do default — é parte do conceito. Documentar no README de produção.
