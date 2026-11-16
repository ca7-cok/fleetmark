# fleetmark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ca7-cok/fleetmark/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ca7-cok/fleetmark/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer in a single JavaScript module, built for
speed: `parse(markdown)` returns exactly the HTML that marked 18.1.3 renders
with default options (GFM on), byte for byte — while running roughly **2.4×
faster** than marked itself on long documents.

## Layout

- `parse.js` — the renderer. A line-based block lexer (headings, paragraphs,
  lists, blockquotes, fenced/indented code, HTML blocks, link reference
  definitions, tables, thematic breaks) feeding a single-pass inline scanner
  (emphasis/strong via the delimiter algorithm, code spans, links/images,
  autolinks, strikethrough, line breaks, character references, raw HTML),
  tuned to marked's exact output habits.
- `main.ts` — the harness driver: reads `cases.json` from the input
  directory (`/input`, or `$MAKEFUN_INPUT_DIR`), renders every case with
  `parse()`, and writes the HTML strings as a JSON array to `html.json` in
  the output directory (`/output`, or `$MAKEFUN_OUTPUT_DIR`), verifying the
  result count and the written file before exiting.

## Running

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

No dependencies; Node 22.

---

Entry for the [make.fun markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02).
New to make.fun? [Join with my referral link](https://make.fun/?ref=3sgxakja) (ref code `3sgxakja`).
