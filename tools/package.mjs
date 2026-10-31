#!/usr/bin/env node
// package.mjs — builds the distributable zip from an explicit allow-list.
//
//   node tools/package.mjs             dist/SideRail-<version>.zip — unzip it, Load unpacked.
//                                      Keeps `key`, so every copy shares one extension id and a
//                                      reinstall from a new folder keeps its data.
//   node tools/package.mjs --store     dist/SideRail-<version>-store.zip — manifest.json at the
//                                      zip root and without `key`, which is what the Chrome Web
//                                      Store accepts.
//   node tools/package.mjs --out DIR   write the zip somewhere other than dist/.
//
// The list below is the whole point: what ships is decided here, once, and never by
// remembering. HANDOVER.md, STORE-READINESS.md, test/, tools/, node_modules/, .git/ and
// package*.json are not on it and so cannot get in. test/e2e.js builds a zip and checks.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything that ships. Directories ship whole, minus dotfiles. */
export const SHIP = [
  'manifest.json', 'background.js', 'common.js',
  'sidepanel.html', 'sidepanel.css', 'sidepanel.js',
  'icons', 'vendor',
  'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'PRIVACY.md', 'README.md', 'CHANGELOG.md'
];

const args = process.argv.slice(2);
const store = args.includes('--store');
const outIdx = args.indexOf('--out');
const outDir = outIdx !== -1 && args[outIdx + 1] ? resolve(args[outIdx + 1]) : join(ROOT, 'dist');

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`manifest.json says ${manifest.version} and package.json says ${pkg.version} — make them agree first`);
  process.exit(1);
}
const missing = SHIP.filter((f) => !existsSync(join(ROOT, f)));
if (missing.length) {
  console.error(`not in the tree: ${missing.join(', ')}`);
  process.exit(1);
}

const folder = `SideRail-${manifest.version}`;
const work = mkdtempSync(join(tmpdir(), 'siderail-pkg-'));
// Load-unpacked users get a folder to point Chrome at; the store wants manifest.json at the root.
const stage = store ? work : join(work, folder);
mkdirSync(stage, { recursive: true });
const notDotfile = (src) => !/\/\.[^/]*$/.test(src);
for (const f of SHIP) cpSync(join(ROOT, f), join(stage, f), { recursive: true, filter: notDotfile });
if (store) {
  const { key, ...rest } = manifest;   // eslint-disable-line no-unused-vars
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(rest, null, 2)}\n`);
}

mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `${folder}${store ? '-store' : ''}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zip, store ? '.' : folder], { cwd: work });
rmSync(work, { recursive: true, force: true });

const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').length;
console.log(`${zip}\n${entries} entries, ${Math.round(statSync(zip).size / 1024)} KB${store ? ', manifest without key' : ''}`);
