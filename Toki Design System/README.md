# Toki Design System

> 時 — *Toki* (時) means "time" in Japanese. Toki é uma extensão de navegador + backend que responde "fulano tá livre?" combinando presença ao vivo, Google Agenda e GPT, com um widget que aparece no Google Chat.

This design system codifies Toki's existing visual language and provides **theme variations** on top of it — alternate moods (dev/terminal, cute/doodle, etc.) that swap the surface treatment without breaking the underlying component contract.

---

## Index

| File / folder | What's in it |
|---|---|
| `README.md` | This file. Brand context, content fundamentals, visual foundations, iconography. |
| `colors_and_type.css` | CSS custom properties: base color + type tokens, and semantic ones (`--fg-1`, `--h1`, etc.). |
| `ui_kits/extension/` | Pixel-faithful recreation of the Toki Chrome extension (popup + Google Chat widget) with **7 themes** toggleable live (default, terminal, doodle, washi, aqua, jornal, cyberpunk). |
| `preview/` | Small HTML cards that populate the Design System tab in the editor. Not for end users. |
| `assets/` | The Toki calendar-kanji logo. |
| `HANDOFF.md` | **Briefing for Claude Code (or any dev agent)** to port these themes into the real `busy-checker/` codebase — refactor plan + ready-to-paste prompt. |
| `SKILL.md` | Agent-Skills compatible manifest so this can be downloaded and used in Claude Code. |
| `_ref/` | Read-only copy of the source files used to build this system. |

## Sources

- **Codebase** — `busy-checker/` (local mount). Specifically:
  - `extension/src/popup.html`, `popup.css`, `popup.ts` — the toolbar popup
  - `extension/src/chat-google.ts` — the in-page widget that mounts inside Google Chat DMs (contains the WIDGET_HTML template with all CSS inline)
  - `extension/icons/icon.png` — the 時 calendar logo
  - `backend/` — Express + Postgres; doesn't affect visual design but sets product scope
- **Product copy** — Portuguese-Brazilian throughout the popup, settings, loading phrases, and chat-google widget

---

## Product context

Toki is one product with **two surfaces**:

1. **Extension popup** (360 px wide). Opens from the toolbar icon. Greeting + a single prompt box where you ask "tá livre o fulano?" in natural language. Tiny chat thread persisted to `chrome.storage.session`. Settings page underneath (work hours, event color, widget on/off).

2. **In-page widget** (320 px floating card, bottom-right). Mounts inside `chat.google.com` whenever a 1:1 DM is open. Shows that person's email + meetings-today badge + busy tag, then a clock-style readout of their next free slot, a mini Google-Calendar timeline of events ±2.5 h around that slot, and an "Agendar nesta janela" button that creates the meeting.

Both surfaces share: the 時 kanji as a "thinking" mark, a near-black-on-white palette, pill chips, soft borders, and Brazilian-Portuguese conversational microcopy.

---

## Content fundamentals

**Language:** Brazilian Portuguese, exclusively. No English in user-facing copy. Occasional Japanese phrases appear as **flavor inside the loading state** (e.g. "時間を整理しています...") but never as functional copy the user has to understand.

**Tone:** Warm, casual, terse. Short sentences, no exclamation marks, no marketing-speak. Reads like a competent coworker, not a chatbot. Examples from the product:

- Greeting: "Boa tarde, Hugo" (time-of-day + first name from email local-part)
- Subtitle: "Pergunte sobre a agenda de alguém — eu respondo com base no calendário em tempo real."
- Placeholder: "Pergunte sobre a agenda de alguém..."
- Settings labels: "Horário de trabalho" / "Define a janela em que sugiro reuniões."
- Empty/error states: "Erro: insufficient_scope. Saia e entre de novo na extensão pra reautorizar."
- Success: "**\"Conversa com Ana\"** agendada. · Abrir Meet · Ver evento"

**Casing:**
- **Sentence case** for labels, buttons, and section titles ("Salvar", "Limpar conversa", "Horário de trabalho"). Never Title Case, never ALL CAPS for UI copy.
- **All caps + letter-spacing** is reserved for two tiny micro-labels: the busy tag ("OCUPADO") and the day name in the carousel ("SEXTA"). 9 px / 12 px, 0.06–0.10 em tracking.
- **Lowercase abbreviations** for short units: "30m", "1h", "agendando…", "minimizar", "fechar". Lowercase makes them feel like terminal output.

**Person:** Second-person informal ("você" implied — "Pergunte…", "Saia e entre…"). The assistant refers to itself as **"eu"** ("eu respondo", "sugiro reuniões"). Never "nós" or "the assistant".

**Numbers & time:** `pt-BR` locale formatting (`24h` clock, `19 nov`, `quinta`). Tabular numerals (`font-variant-numeric: tabular-nums`) used wherever digits live in a card — clock, calendar tile, meeting count badge.

**Emoji:** Not used. The Japanese kanji 時 plays the role an emoji would in most products: it's the brand mascot, the loading-state indicator, the assistant-bubble avatar.

**Ellipses:** Real `…` character (U+2026), not three dots. Used to mark in-flight async ("agendando…", "Carregando o futuro…").

**Loading phrases** are rotated on each loading mount. The product has six:
- 時間を整理しています...
- Só mais alguns segundos
- Carregando o futuro
- Harmonizando agendas
- Processando eventos
- Preparando sua próxima reunião...

These show personality without being twee. The Japanese line is intentional — it reinforces the brand without forcing the user to read it.

---

## Visual foundations

### Palette

A near-monochrome neutral system anchored on **`#111827`** (the canonical "ink" — used for primary text, primary buttons, switch-on, focus ring, dashed slot border, busy tag's only chromatic counterpart). Backgrounds are **`#ffffff`** with a single warm-off-white **`#fafafa`** for form interiors and the prompt-box resting state.

The grayscale ladder is Tailwind's gray family, used as-is:
- `#f9fafb` / `#f3f4f6` / `#e5e7eb` — surface tints, dividers, chip backgrounds
- `#d1d5db` — control borders, switch-off
- `#9ca3af` / `#6b7280` — placeholder, secondary text, hover transitions
- `#374151` / `#1f2937` / `#111827` — primary text, button hover, ink

Three accent colors, used **sparingly**:
- `#dc2626` — error text, busy tag fill (the only red in the product)
- `#f97316` — "now" line on the agenda timeline (the only orange)
- `#3b82f6` — default event color (user-configurable, so think of it as a *category* of color, not a literal hex)

There are no gradients in the product, ever. The single exception is a `linear-gradient(180deg, #ffffff 0%, #fafafa 100%)` on the calendar tile's number cell — and it's so subtle it reads as flat.

### Typography

System UI stack:
```
-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
"Segoe UI Variable", "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif
```

Japanese serif stack for the kanji 時 (mandatory — sans-serif renderings of 時 lose the brushstroke):
```
"Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP",
"Noto Serif CJK JP", "MS Mincho", "Songti SC", serif
```

There is **no monospace** in the existing product. (Themes may introduce one — the dev/terminal theme uses JetBrains Mono.)

Size scale (px, anchored to the popup's 13px root):
- 9 / 10 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 — UI sizes
- 14 — brand wordmark
- 15 / 16 — day name + headings
- 18 — kanji at chat-message scale
- 20 / 24 — kanji at brand-mark scale
- 26 — calendar tile day number
- 32 — flip-clock digits

Tracking: tight throughout. **-0.005 em to -0.04 em** on most text; only the ALL-CAPS micro-labels go positive (+0.04 to +0.10 em). Headlines and digits get the most negative tracking (-0.02 to -0.04 em).

Weight: 400 / 500 / 600 / 700. 500 is the workhorse for buttons and labels; 600 for names and headings; 700 reserved for the busy tag and the flip-clock digits.

### Spacing & sizing

The popup is **360 px** wide; the floating widget is **320 px**. Both feel like cards, not pages. Internal padding is 12–16 px; gaps between siblings are 6 / 8 / 10 / 12 px. Section dividers are `border-bottom: 1px solid #f3f4f6` — almost invisible, just enough to imply rhythm.

### Corner radii

- **6 px** — small controls: chip border, duration button, number input, color swatch, dur button
- **7 px** — flip-clock card
- **8 px** — icon button, schedule button, agenda container, settings save button
- **9 px** — calendar tile
- **10 px** — prompt send button
- **12 px** — widget card outer
- **14 px** — prompt-box, message bubbles, popup-thread bubbles
- **999 px** — pill: meetings-today badge, busy tag, switch slider, sign-in button, chips

The pattern: **bigger surface → bigger radius**, but never more than 14 px on rectangular surfaces. The only fully-round shapes are pills.

### Borders & dividers

- Hairline `1px solid #e5e7eb` for almost every bordered control
- `1px solid #f3f4f6` for dividers (lighter — they shouldn't compete)
- `1.5px dashed #111827` for the "free slot" block in the timeline — the dashed-ink box is a signature element

### Shadows

Two-stop system:
- **Resting card**: `0 1px 2px rgba(0,0,0,0.04), 0 12px 32px rgba(15,23,42,0.10)` — the floating widget
- **Hover/active button**: `0 4px 12px rgba(17,24,39,0.15)` — only on the primary schedule button
- **Tiny element shadow**: `0 1px 2px rgba(0,0,0,0.05)` — calendar tile, flip-card

No inner shadows. No glow rings except focus, which uses `box-shadow: 0 0 0 3-4 px rgba(17,24,39,0.06–0.12)` — a soft ink halo.

### Backgrounds & textures

Solid white, full stop. No imagery, no patterns, no full-bleed photos, no illustrations. The kanji 時 is the only "graphic" element. The default theme is deliberately **minimal** — themes can break this rule (the cute theme adds doodles; the terminal theme adds a CRT scanline).

### Animation

Easing: **`cubic-bezier(0.16, 1, 0.3, 1)`** everywhere — the "easeOutExpo-ish" curve used for the widget enter, form expand, success-in, message fade-in. The product uses this curve so consistently it functions as a brand element.

Durations:
- 80 ms — `:active` scale (`scale(0.92–0.95)`)
- 120–180 ms — color / background transitions on hover
- 240–350 ms — element enter (`fade-in`, `bc-enter`, `bc-section-in`, `bc-form-expand`)
- 400 ms — success bubble entry
- 500–1300 ms — clock-tick interpolation (computed from time delta)

Idioms:
- **Fade + 4–8 px translate** for any element entering on screen
- **Scale(0.985 → 1)** combined with translate for the widget mount — a confident *snap into place*
- **Press = 0.92–0.95 scale** with no shadow change (the shadow stays so it doesn't "lift off")
- **Spin** is reserved for the loading kanji-companion spinner (2.5s for the widget, 1.4s in the popup)

### Hover & press

- **Buttons**: background darkens one step (`#111827 → #1f2937`), no scale change on hover
- **Chips / icon buttons**: background fills from transparent → `#f3f4f6`, color goes ink
- **Press**: most controls scale down to 0.92–0.95 for 80 ms, primary buttons translateY(1px)
- **Disabled**: opacity 0.25–0.6 + `cursor: not-allowed` or `cursor: wait` for in-flight async

### Layout rules

- Single-column layouts only — no side-by-side cards in the popup
- Fixed-position elements are limited to the in-page widget (`bottom: 24px; right: 24px; z-index: 2147483647`)
- The popup is auto-height; the widget is auto-height with a minimized state that swaps width to `auto`
- Inner scroll only on `.chat-thread` (max-height 320 px, 6 px scrollbar)

### Transparency & blur

Not used. No glassmorphism, no backdrop-filter. The product values **legibility over depth**.

### Imagery vibe

If photography or screenshots ever appeared, they would be: high-key, warm-neutral, no filter, no grain. The kanji is rendered as a **brushstroke calligraphy** (see `assets/icon.png`) — the only "art" the brand has.

---

## Iconography

**No icon font.** No Lucide, no Heroicons, no Feather as dependencies. Icons are **hand-rolled inline SVGs** following a consistent spec:

- **24×24 viewBox** (path coordinates normalized to this), rendered at **12–16 px**
- `fill="none"`, `stroke="currentColor"`, `stroke-width="1.8–2.5"` (2 is default; 2.5 for the prompt-send arrow which needs presence)
- `stroke-linecap="round"`, `stroke-linejoin="round"` — soft tips, no mitred corners
- `aria-hidden="true"` on decoration, `aria-label` on the parent button

Inventory currently in the codebase:
- **Gear** (settings cog) — popup header right
- **Back chevron** — settings page top-left
- **Arrow-up** (prompt send) — composer right
- **Calendar** — meetings-today badge in the widget
- **Single chevron-down** — minimize widget, slot-down chevron
- **Single chevron-up** — slot-up chevron
- **Left chevron** — back nav
- **Spinner clock** (`<circle/> + <polyline/>` clock-hands) — loading

There is exactly **one Unicode "icon"** in the system: the multiplication sign **×** as the widget close button (font-size 18 px, no SVG).

There is exactly **one image asset**: `assets/icon.png` — the calendar-with-kanji logo. PNG only (no SVG export of the brushstroke).

**Substitutions used in this design system:** None — all icons are reproduced exactly from the source.

**Emoji** is not used. Themes are free to break this (the cute theme leans on doodled SVG flowers/hearts; the terminal theme uses ASCII art) but the default theme has no emoji surface.

---

## Themes

The whole point of this project is **theming**. All 7 themes are live in `ui_kits/extension/index.html` (use the switcher at the top of the page to flip between them):

- **default** — the existing minimal ink-on-white look
- **terminal** — green-on-black CRT, JetBrains Mono, scanlines, blinking cursor, `$` prompt
- **doodle** — Caveat + Patrick Hand, pastel pinks, scribbled SVG flowers & hearts, chunky 2px borders with hard shadows
- **washi** — sumi-ink calligraphy on warm washi paper, Noto Serif JP, hanko-stamp OCUPADO tag, sepia events
- **aqua** — Y2K frosted glass, glossy blue gradient buttons, Lucida Grande, OS X/Windows XP nostalgia
- **jornal** — old newspaper print, Old Standard TT + Playfair Display, b&w only, hard 4px offset shadow
- **cyberpunk** — magenta + cyan neon, Orbitron, scanlines, gradient text, glow on every interactive element

All themes swap a defined set of CSS variables on the `.toki` host — they don't touch component structure. The same `<button class="schedule">` looks like a slate-black pill in default, a green ASCII box in terminal, a hot-pink doodle button in cute, and a magenta glowing rectangle in cyberpunk.

---

## Caveats

- The Japanese kanji 時 currently relies on the user's OS shipping a Japanese serif (Yu Mincho on macOS, MS Mincho on Windows). On Linux without `noto-cjk` installed, it falls back to a sans-serif glyph that loses the brushstroke. We do **not** webfont-load Noto Serif JP because the file is large; flag this if it becomes a real fidelity problem.
- The "Inter" fallback in the stack is mostly there for older Linux/Windows installs without SF Pro or Segoe UI Variable. Most users see SF Pro.
- All theme variations are **net-new explorations** for this design-system project — they don't ship in the extension today.
