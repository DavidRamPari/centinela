/**
 * Node-only helpers (file system access). Import from `@centinela/shared/node`;
 * the web bundle must not import this module.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAttackIndex, type AttackIndex } from './attack.js';

/**
 * Default location of the ATT&CK data file. This module sits at
 * `packages/shared/{src,dist}/node.*`, three levels below the repository root.
 */
export const defaultAttackDataPath = fileURLToPath(
  new URL('../../../data/mitre-attack/enterprise-attack.min.json', import.meta.url),
);

/** Read and validate the ATT&CK data file. */
export async function loadAttackIndex(path: string = defaultAttackDataPath): Promise<AttackIndex> {
  const text = await readFile(path, 'utf8');
  return createAttackIndex(JSON.parse(text) as unknown);
}

/** Synchronous variant for start-up code and CLIs. */
export function loadAttackIndexSync(path: string = defaultAttackDataPath): AttackIndex {
  return createAttackIndex(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
