#!/usr/bin/env node
// Verifies an update bundle's minisign signature against the public key the app
// ships (tauri.conf.json → plugins.updater.pubkey) and that it is bound to the
// expected version, exactly as installed apps will. Run by release-macos.sh so a
// release signed with the wrong key is never published.
//
//   node scripts/verify-update-sig.mjs <bundle.tar.gz> <bundle.tar.gz.sig> <version>
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [file, sigFile, version] = process.argv.slice(2);
if (!file || !sigFile || !version) {
  console.error('usage: verify-update-sig.mjs <file> <file.sig> <version>');
  process.exit(2);
}
const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const unb64 = (s) => Buffer.from(s.trim(), 'base64');
const lines = (s) => unb64(s).toString('utf8').split('\n');

// Public key: "untrusted comment" line, then base64("Ed" | key id (8) | ed25519 key (32)).
const pk = unb64(lines(conf.plugins.updater.pubkey)[1]);
const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pk.subarray(10, 42).toString('base64url') }, format: 'jwk' });

// Signature: untrusted comment, base64("ED" | key id | sig(64)), trusted comment, base64(global sig).
const [, sigLine, trustedLine, globalLine] = lines(readFileSync(sigFile, 'utf8'));
const sig = unb64(sigLine);
const trusted = trustedLine.replace(/^trusted comment: /, '');
const fail = (m) => {
  console.error(`update signature check FAILED: ${m}`);
  process.exit(1);
};
if (sig.subarray(0, 2).toString() !== 'ED') fail('not a prehashed (ED) minisign signature');
if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) fail('signed by a different key than the one the app trusts');
const digest = createHash('blake2b512').update(readFileSync(file)).digest();
if (!verify(null, digest, key, sig.subarray(10, 74))) fail('signature does not match the file');
if (!verify(null, Buffer.concat([sig.subarray(10, 74), Buffer.from(trusted)]), key, unb64(globalLine))) fail('trusted comment was altered');
if (!trusted.split('\t').includes(`version:${version}`)) fail(`signature is not bound to version ${version} (${trusted})`);
console.log(`update signature OK (version ${version})`);
