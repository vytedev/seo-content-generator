# Vendored fonts

Locally vendored `woff2` files for the app's four typography roles (see `.xevy/design.md` §06 — Typography). Delivery stays local; nothing is fetched from a CDN at runtime.

Fetched from Google Fonts (`fonts.gstatic.com`, latin subset only — the app is English (UK) only) on 20 August 2026:

| File                            | Family           | Weight(s)                         |
| ------------------------------- | ---------------- | --------------------------------- |
| `barlow-condensed-600.woff2`    | Barlow Condensed | 600                               |
| `barlow-condensed-700.woff2`    | Barlow Condensed | 700                               |
| `barlow-condensed-800.woff2`    | Barlow Condensed | 800 (default screen-title weight) |
| `inter-variable.woff2`          | Inter            | 400–700 (variable)                |
| `jetbrains-mono-variable.woff2` | JetBrains Mono   | 400–500 (variable)                |
| `source-serif-4-variable.woff2` | Source Serif 4   | 500–600 (variable)                |

Registered as `@font-face` in `src/client/styles/tokens.css`.

All four families are SIL Open Font License 1.1 — see `OFL.txt` (identical licence text for all four; copyright holders:
Barlow Condensed © 2017 The Barlow Project Authors, Inter © 2020 The Inter Project Authors, JetBrains Mono © 2020 The JetBrains Mono Project Authors, Source Serif 4 © 2014 The Source Serif 4 Project Authors). No additional fonts may be introduced without updating this note.
