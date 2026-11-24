import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { patterns, randomHex } from '../src/core/util.mjs';

export function rootCredential(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'root.key');
  try {
    writeFileSync(file, 'mrr_' + randomHex(), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const key = readFileSync(file, 'utf8').trim();
  if (!patterns.rootKey.test(key)) throw new Error('The existing root.key file is invalid.');
  return key;
}
