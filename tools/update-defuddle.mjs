#!/usr/bin/env node
/**
 * Refresh the vendored Defuddle bundle.
 *
 *   node tools/update-defuddle.mjs           # report only
 *   node tools/update-defuddle.mjs --apply   # fetch, vendor, bump patch version
 *
 * Manifest V3 forbids remotely-hosted code, so the library MUST ship inside the
 * extension package — there is no legitimate way to auto-load a newer Defuddle
 * at runtime. This makes updating a deliberate, reviewable, one-command act,
 * which is also the behaviour we want given why this extension exists.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_META = join(ROOT, 'vendor', 'defuddle-version.json');
const VENDOR_FILE = join(ROOT, 'vendor', 'defuddle.js');
const MANIFEST = join(ROOT, 'manifest.json');

const apply = process.argv.includes('--apply');
const current = JSON.parse(readFileSync(VENDOR_META, 'utf8'));

// Metadata only — a version string is data, not code.
const res = await fetch('https://registry.npmjs.org/defuddle/latest');
if (!res.ok) {
  console.error(`Could not reach the npm registry (${res.status}).`);
  process.exit(1);
}
const latest = await res.json();

console.log(`vendored: defuddle ${current.version}`);
console.log(`latest:   defuddle ${latest.version}`);

if (latest.version === current.version) {
  console.log('\nUp to date.');
  process.exit(0);
}

console.log(`\nUpdate available: ${current.version} → ${latest.version}`);
console.log(`Changelog: https://github.com/kepano/defuddle/releases`);

if (!apply) {
  console.log('\nRe-run with --apply to vendor it.');
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'defuddle-'));
try {
  execFileSync('npm', ['pack', `defuddle@${latest.version}`], { cwd: tmp, stdio: 'pipe' });
  const tgz = execFileSync('ls', [tmp], { encoding: 'utf8' }).trim().split('\n')
    .find((f) => f.endsWith('.tgz'));
  execFileSync('tar', ['xzf', join(tmp, tgz), '-C', tmp]);

  const built = join(tmp, 'package', 'dist', 'index.js');
  const size = readFileSync(built).length;
  copyFileSync(built, VENDOR_FILE);

  writeFileSync(VENDOR_META, `${JSON.stringify({
    ...current,
    version: latest.version,
    bytes: size,
    vendoredAt: new Date().toISOString().slice(0, 10)
  }, null, 2)}\n`);

  // Bump the extension patch version so the new build is distinguishable.
  const man = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const parts = man.version.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  man.version = parts.join('.');
  writeFileSync(MANIFEST, `${JSON.stringify(man, null, 2)}\n`);

  console.log(`\nVendored defuddle ${latest.version} (${(size / 1024).toFixed(0)} KB)`);
  console.log(`Extension version bumped to ${man.version}`);
  console.log('\nNow run:  node test/e2e.js');
  console.log('Then reload the extension at chrome://extensions');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
