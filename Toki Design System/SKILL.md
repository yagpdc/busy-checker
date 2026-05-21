---
name: toki-design
description: Use this skill to generate well-branded interfaces and assets for Toki (the "fulano tá livre?" Google Chat extension), either for production or throwaway prototypes/mocks. Contains essential design guidelines, colors, type, fonts, assets, themed UI kit, and 7 theme variations (default, terminal, doodle, washi, aqua, jornal, cyberpunk) for prototyping.
user-invocable: true
---

# Toki Design Skill

Read the `README.md` file within this skill first — it has voice, content fundamentals, visual foundations, and iconography spec. Then explore the other available files:

- **`colors_and_type.css`** — canonical CSS tokens (`--ink`, `--fg-1`, `--font-ui`, `--radius-card`, etc.). Always link or copy this into any artifact you create.
- **`ui_kits/extension/index.html`** — pixel-faithful recreation of the Toki Chrome extension (toolbar popup + Google Chat widget) with 7 themes toggleable live. Use as the source of truth for layouts AND theme tokens.
- **`ui_kits/extension/toki.css`** — themeable base CSS for popup/widget components, separated from theme variables.
- **`preview/*.html`** — atomic design-system cards (one component per file). Use these as quick visual references when building something new.
- **`assets/icon.png`** — the Toki calendar-with-kanji logo. The only image asset; the kanji 時 (Yu Mincho / Noto Serif JP) is the brand mark.
- **`HANDOFF.md`** — instructions for porting the design system into the real `busy-checker/` codebase (refactor plan + ready-to-paste Claude Code prompt).
- **`_ref/`** — read-only snapshot of the source codebase (`popup.css`, `popup.ts`, `chat-google.ts`, `manifest.json`). Lossless reference for behavior and exact production styles.

## What to produce

- **Visual artifacts** (slides, mocks, throwaway prototypes): copy `assets/icon.png` and `colors_and_type.css` out, and emit static HTML. Pick one theme from `ui_kits/extension/index.html` or use the default. The kanji 時 should appear somewhere.
- **Production code**: read the rules here, then write CSS that uses the tokens from `colors_and_type.css`. Don't inline hex values. Refer to `HANDOFF.md` if the task is integrating into the real extension.

## Defaults

- **Language**: Brazilian Portuguese in all user-facing copy.
- **Casing**: sentence case for labels and buttons; all-caps + 0.06em tracking only on micro-tags (e.g. OCUPADO).
- **Font**: system sans (SF Pro / Segoe UI Variable / Inter fallback) for UI; Yu Mincho / Noto Serif JP for the kanji 時.
- **Color**: ink (`#111827`) on white (`#ffffff`). Sparingly: red `#dc2626` (errors, busy), orange `#f97316` (now-line), blue `#3b82f6` (default events).
- **Radius**: 6 (controls) / 8 (button) / 12 (card) / 14 (bubble) / 999 (pill).
- **Easing**: `cubic-bezier(0.16, 1, 0.3, 1)` everywhere.
- **No emoji**, no gradients (except in non-default themes), no glassmorphism (except aqua theme).

## When the user invokes this skill without other guidance

Ask what they want to build or design (a slide deck? a new screen for the extension? a marketing artifact? a refactor of the live code?). Confirm which **theme** they want — show the 7 options from `ui_kits/extension/index.html`. Then ask 1–2 product-specific questions and proceed.

Act as an expert designer who outputs HTML artifacts OR production code, depending on the need. Always prefer existing components from `ui_kits/` over inventing new ones.
