// fleetmark driver, run by the harness as `node main.ts` (Node 22).
// Reads every case from cases.json in the input directory, renders each
// case's markdown with parse() from ./parse.js, and writes the HTML strings
// as a JSON array to html.json in the output directory, in case order.
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and /output
// outside the harness container.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
if (!Array.isArray(cases)) {
  throw new Error('cases.json did not contain an array of cases');
}

const html: string[] = [];
for (const c of cases) {
  html.push(parse(c.markdown));
}

// Self-check before writing: one HTML string per case, in order.
if (html.length !== cases.length || html.some(h => typeof h !== 'string')) {
  throw new Error(`render count mismatch: ${html.length} results for ${cases.length} cases`);
}

mkdirSync(outputDir, { recursive: true });
const outPath = join(outputDir, 'html.json');
writeFileSync(outPath, JSON.stringify(html));

// Self-check after writing: the file must parse back to the same shape,
// so a truncated or interleaved write fails loudly instead of scoring 0.
const written = JSON.parse(readFileSync(outPath, 'utf8')) as unknown;
if (!Array.isArray(written) || written.length !== cases.length) {
  throw new Error('html.json verification failed: unexpected contents after write');
}
