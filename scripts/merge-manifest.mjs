#!/usr/bin/env node
// Merges the platforms of one updater manifest into another, so the macOS and Linux
// release jobs can each add their builds to the release's single latest.json.
//
//   node scripts/merge-manifest.mjs <target.json> <source.json>
//
// The source's platform entries win; the target's other entries are kept. A missing
// target is created from the source. Refuses to mix manifests of different versions.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [targetFile, sourceFile] = process.argv.slice(2);
if (!targetFile || !sourceFile) {
  console.error('usage: merge-manifest.mjs <target.json> <source.json>');
  process.exit(2);
}
const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
const target = existsSync(targetFile) ? JSON.parse(readFileSync(targetFile, 'utf8')) : { ...source, platforms: {} };
if (target.version !== source.version) {
  console.error(`manifest versions differ: ${targetFile} has ${target.version}, ${sourceFile} has ${source.version}`);
  process.exit(1);
}
target.platforms = { ...target.platforms, ...source.platforms };
writeFileSync(targetFile, JSON.stringify(target, null, 2) + '\n');
console.log(`${targetFile}: ${Object.keys(target.platforms).sort().join(', ')}`);
