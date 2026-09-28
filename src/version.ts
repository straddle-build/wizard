import { readFileSync } from 'node:fs';
import { field, parseJson, text } from './json.ts';

// package.json sits one level above both src/ and dist/.
export const WIZARD_VERSION = text(field(parseJson(readFileSync(new URL('../package.json', import.meta.url), 'utf8')), 'version')) ?? 'unknown';
