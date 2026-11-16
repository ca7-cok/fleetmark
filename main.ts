// fleetmark driver, run by the harness as `node main.ts` (Node 22).
// Reads every case from cases.json in the input directory, renders each
// case's markdown with parse() from ./parse.js, and writes the HTML strings
// as a JSON array to html.json in the output directory, in case order.
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and /output
// outside the harness container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html: string[] = [];
for (const c of cases) {
  html.push(parse(c.markdown));
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
