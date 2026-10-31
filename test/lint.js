// lint.js — static check for the bug class that broke bookmarks + history:
// a helper used from common.js but never added to the import list.
//
// That fails at runtime only on the code path that touches it, and inside an
// async function it surfaces as "Uncaught (in promise) ReferenceError" with no
// visible symptom beyond a feature quietly returning nothing. Cheap to catch here.
//
// Run: node test/lint.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMMON = 'common.js';
const CONSUMERS = ['sidepanel.js', 'background.js'];

const problems = [];
const notes = [];

/** Comments only — module specifiers are strings, so they must survive. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * Also blank out regex, string and template literals, for scanning real code.
 *
 * Regex literals go FIRST and deliberately. A regex containing a quote — say a
 * character class of characters to strip — otherwise looks like the start of a
 * string to the pass below, which then swallows the rest of the file and makes
 * every export after it appear to vanish. That surfaced as six confident,
 * completely fictional "does not export it" failures.
 *
 * Telling a regex literal from a division sign needs the parser we don't have,
 * so this uses the usual heuristic: a `/` that follows an operator or an opening
 * bracket starts a regex. Anything it gets wrong is caught by the blind-spot
 * check below rather than reported as a missing export.
 */
function stripNoise(src) {
  return stripComments(src)
    .replace(/([=(,:[!&|?{};+\-*%^~]\s*)\/(?![*/])(?:\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|[^/\\\n[])+\/[gimsuy]*/g, '$1/RX/')
    // One pass for all three quote styles, not three passes in sequence. Run
    // separately, the single-quote pass met the double-quoted literal `"'"`
    // — as found in any escaper's lookup table — treated its inner quote as
    // the start of a string, and swallowed code down to the next `'`, exports
    // included. A single alternation pairs whichever quote opens first.
    .replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"/g,
      (m) => m[0] + m[0]);
}

const EXPORTS_RE = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
const namesIn = (src) => new Set([...src.matchAll(EXPORTS_RE)].map((m) => m[1]));

const commonSrc = fs.readFileSync(path.join(ROOT, COMMON), 'utf8');
const commonCode = stripNoise(commonSrc);

const exported = namesIn(commonCode);

// Blind-spot check: if blanking literals lost an export the raw source clearly
// declares, the stripper is at fault, not the code. Say so, and keep the name —
// a broken scanner must not be able to invent missing-export failures.
const rawExports = namesIn(stripComments(commonSrc));
const eaten = [...rawExports].filter((n) => !exported.has(n));
if (eaten.length) {
  problems.push(
    `lint.js: literal-stripping hid ${eaten.length} export(s) — ${eaten.join(', ')}. ` +
    'A quote inside a regex literal is the usual cause. Fix stripNoise, not the code.'
  );
  eaten.forEach((n) => exported.add(n));
}
notes.push(`${COMMON} exports ${exported.size} names`);

for (const file of CONSUMERS) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const withStrings = stripComments(raw);
  const code = stripNoise(raw);

  const importMatch = withStrings.match(/import\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/common\.js['"]/);
  if (!importMatch) {
    notes.push(`${file}: no import from ${COMMON}`);
    continue;
  }

  const imported = new Set(
    importMatch[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/).pop().trim())
      .filter(Boolean)
  );

  // Names the file declares itself (these legitimately shadow).
  const declared = new Set(
    [...code.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  );

  // 1. Imported something common.js doesn't export.
  for (const name of imported) {
    if (!exported.has(name)) {
      problems.push(`${file}: imports "${name}" but ${COMMON} does not export it`);
    }
  }

  // 2. Used a common.js export without importing or declaring it.
  const body = code.replace(/import\s*\{[\s\S]*?\}\s*from\s*[^;\n]+;?/, '');
  for (const name of exported) {
    if (imported.has(name) || declared.has(name)) continue;
    const used = new RegExp(`\\b${name}\\b`).test(body);
    if (used) {
      problems.push(
        `${file}: uses "${name}" from ${COMMON} but never imports it ` +
        '— this throws ReferenceError at runtime'
      );
    }
  }

  notes.push(`${file}: ${imported.size} imports checked`);
}

// 3. No network. The privacy claim is "nothing leaves your browser"; make the
// suite say so rather than the README. fetch() is allowed only for the
// extension's own files and for data URLs; nothing else that opens a socket.
for (const file of ['background.js', 'common.js', 'sidepanel.js']) {
  const src = stripNoise(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  for (const bad of ['XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'RTCPeerConnection']) {
    if (new RegExp(`\\b${bad}\\b`).test(src)) {
      problems.push(`${file}: uses ${bad} — shipped code must make no network calls`);
    }
  }
  const raw = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  for (const m of raw.matchAll(/\bfetch\s*\(\s*([^)]*)/g)) {
    const arg = m[1].trim();
    if (!/^chrome\.runtime\.getURL\(/.test(arg) && !/^dataUrl\b/.test(arg)) {
      problems.push(`${file}: fetch(${arg.slice(0, 40)}…) — only the extension's own files and data URLs may be fetched`);
    }
  }
}
// The vendored reader has network paths behind parseAsync(); the shipped code
// must only ever call the synchronous parse().
if (/parseAsync\s*\(/.test(stripComments(fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8')))) {
  problems.push('sidepanel.js: calls Defuddle parseAsync(), whose extractors make network requests');
}
notes.push('no network calls in shipped code; Defuddle used synchronously');

// 4. Shipped text files are UTF-8 with no control characters. Two raw NUL bytes
// in a template string made every text tool — grep, diff, GitHub — treat
// common.js as binary, and nobody noticed for seven weeks. Write them as escapes.
const SHIPPED_TEXT = [
  'manifest.json', 'background.js', 'common.js',
  'sidepanel.html', 'sidepanel.css', 'sidepanel.js',
  'vendor/exclusions.js', 'vendor/emoji.js',
  'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'PRIVACY.md', 'README.md', 'CHANGELOG.md'
];
for (const file of SHIPPED_TEXT) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { problems.push(`${file}: missing — it ships in the package`); continue; }
  let src;
  try { src = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full)); }
  catch { problems.push(`${file}: not valid UTF-8`); continue; }
  const m = src.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  if (m) {
    const line = src.slice(0, m.index).split('\n').length;
    problems.push(`${file}:${line}: control character U+${m[0].charCodeAt(0).toString(16).padStart(4, '0')} — ` +
      'write it as an escape; a raw one makes tools treat the file as binary');
  }
}
notes.push('shipped text files are UTF-8 with no control characters');

// 5. Nothing read from a page is ever stored. 0.23–0.25 kept page text in an
// IndexedDB database; 0.26.0 removed it. The only IndexedDB call allowed in
// shipped code is the one that deletes that old database, and nothing may
// write to chrome.storage.sync at all. The README and PRIVACY.md say both;
// this is what makes them true.
for (const file of ['background.js', 'common.js', 'sidepanel.js']) {
  const src = stripNoise(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const idb = [...src.matchAll(/\bindexedDB\b[^\n;]*/g)].map((m) => m[0].trim());
  for (const use of idb) {
    // Allowed, in common.js only: the delete, and the `typeof indexedDB === 'undefined'`
    // guard in front of it (string literals are blanked, so the comparison reads '').
    if (!(file === 'common.js' && /^indexedDB\.deleteDatabase\(|^indexedDB === ''\)/.test(use.replace(/^typeof\s+/, '')))) {
      problems.push(`${file}: ${use.slice(0, 60)} — page text is never stored; the only IndexedDB call allowed deletes the old database`);
    }
  }
  if (/\bstorage\.sync\b/.test(src)) problems.push(`${file}: uses chrome.storage.sync — nothing SideRail keeps may leave this profile`);
  if (/new\s+Worker\s*\(/.test(src)) problems.push(`${file}: creates a Worker — the term-index worker was removed in 0.26.0`);
}
notes.push('no page text is stored: no IndexedDB beyond deleting the old database, no storage.sync, no workers');

for (const n of notes) console.log(`  ok   ${n}`);

if (problems.length) {
  console.log('');
  for (const p of problems) console.log(` FAIL  ${p}`);
  console.log(`\n${notes.length} passed, ${problems.length} failed\n`);
  process.exit(1);
}

console.log(`\n${notes.length} passed, 0 failed\n`);
