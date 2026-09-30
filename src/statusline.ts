#!/usr/bin/env node
// Claude Code status line command the Wizard sets per session: the Straddle program as a one-line checklist, from
// the recorded events and the skills' contract files. It reads nothing else and writes nothing.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readObservedEvents } from './events.ts';
import { isRunnableSkill } from './programs.ts';
import { progress, statusLine } from './progress.ts';
import { WIZARD_DIR } from './receipt.ts';

const { values } = parseArgs({ options: { repo: { type: 'string' }, steps: { type: 'string' }, exclude: { type: 'string', multiple: true } } });
const repo = values.repo ?? '';
// `straddle-setup:5,straddle-plan:6`: each program step and how many step files it has.
const steps = (values.steps ?? '').split(',').map((s) => s.split(':')).flatMap(([skill, total]) => (skill && isRunnableSkill(skill) ? [{ skill, total: Number(total) }] : []));
process.stdout.write(`Straddle: ${statusLine(progress(repo, values.exclude ?? [], steps, readObservedEvents(join(repo, WIZARD_DIR, 'events.jsonl')).events))}\n`);
