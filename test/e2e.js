// e2e.js — loads SideRail unpacked in real Chromium and drives the panel.
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

/** Browser binary for tests: CHROME_BIN wins, else the first that exists. */
function findBrowser() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Helium.app/Contents/MacOS/Helium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  const hit = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!hit) {
    throw new Error('No browser found. Set CHROME_BIN to your browser binary, e.g.\n' +
      '  CHROME_BIN="/Applications/Helium.app/Contents/MacOS/Helium" npm test');
  }
  return hit;
}


const EXT = path.resolve(__dirname, '..');
const results = [];
const ok = (name, detail = '') => results.push(['PASS', name, detail]);
const bad = (name, detail = '') => results.push(['FAIL', name, detail]);

/** Open the jump-bar overflow menu and click an item by its label. */
async function clickMenu(panel, label) {
  await panel.evaluate(async (text) => {
    document.getElementById('gmenu').click();
    await new Promise((r) => setTimeout(r, 150));
    const btn = [...document.querySelectorAll('#ctxmenu button')]
      .find((b) => b.textContent === text);
    if (!btn) throw new Error(`menu item not found: ${text}`);
    btn.click();
  }, label);
}

function check(cond, name, detail = '') {
  cond ? ok(name, detail) : bad(name, detail);
  return cond;
}

/*
 * Shell navigation, in one place.
 *
 * Since 0.17 browsing and management are two shells rather than five peer tabs,
 * so "go to Rules" is cog-then-section and "go to tabs" is the back arrow.
 * Every test that used to click `.view-btn[data-view=…]` goes through these, so
 * the next structural change is one edit rather than nineteen.
 */
async function openManage(panel, view = 'spaces') {
  await panel.evaluate((v) => {
    const cog = document.getElementById('manage-open');
    if (cog && !cog.hidden) cog.click();
    const b = document.querySelector(`.view-btn[data-view="${v}"]`);
    if (!b) throw new Error(`no management section: ${v}`);
    b.click();
  }, view);
  await panel.waitForTimeout(400);
}

async function backToBrowse(panel) {
  await panel.evaluate(() => {
    const back = document.getElementById('manage-back');
    if (back && !document.getElementById('manage-head').hidden) back.click();
  });
  await panel.waitForTimeout(400);
}

/**
 * The same two moves, injected into the page so the many in-`evaluate` call
 * sites can use them without a round trip.
 */
const SHELL_HELPERS = `
  // Membership is one storage key per tab since 0.20.0. These mirror
  // common.js's helpers so tests read and write it the way the app does,
  // rather than reaching for a shape that no longer exists.
  window.__readSpaceOf = async () => {
    const all = await chrome.storage.session.get(null);
    const out = {};
    for (const k of Object.keys(all)) if (k.startsWith('sp:')) out[k.slice(3)] = all[k];
    return out;
  };
  window.__writeSpaceOf = async (map) => {
    const patch = {};
    for (const id of Object.keys(map || {})) if (map[id]) patch['sp:' + id] = map[id];
    if (Object.keys(patch).length) await chrome.storage.session.set(patch);
  };
  window.__clearMembership = async () => {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('sp:') || k.startsWith('sph:'));
    if (keys.length) await chrome.storage.session.remove(keys);
  };
  window.__clearPinnedFlags = async () => {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('sph:'));
    if (keys.length) await chrome.storage.session.remove(keys);
  };
  window.__goManage = (v) => {
    const cog = document.getElementById('manage-open');
    if (cog && !cog.hidden) cog.click();
    const b = document.querySelector('.view-btn[data-view="' + v + '"]');
    if (!b) throw new Error('no management section: ' + v);
    b.click();
  };
  window.__goBrowse = () => {
    const back = document.getElementById('manage-back');
    if (back && !document.getElementById('manage-head').hidden) back.click();
  };
`;

(async () => {
  // Static pass first — a missing import is cheaper to catch here than to
  // watch a feature silently return nothing in the browser.
  try {
    require('child_process').execFileSync('node', [path.join(__dirname, 'lint.js')], { stdio: 'pipe' });
    ok('static import check (test/lint.js)');
  } catch (e) {
    bad('static import check (test/lint.js)', String(e.stdout || e).trim().split('\n').pop());
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: findBrowser(),
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-sandbox'
    ]
  });

  const consoleErrors = [];
  ctx.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  ctx.on('weberror', (e) => consoleErrors.push(String(e.error())));

  // ---------------------------------------------------------- service worker
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  if (!check(!!sw, 'service worker registered')) { await finish(ctx, userDataDir); return; }

  const extId = new URL(sw.url()).host;
  ok('extension id resolved', extId);

  // Verify the manifest really carries no host permissions.
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  check(!manifest.host_permissions, 'manifest declares no host_permissions');
  check(!manifest.content_scripts, 'manifest declares no content scripts');
  check(!manifest.permissions.includes('management'), 'manifest does not request management');
  check(
    manifest.permissions.every((p) =>
      ['tabs', 'tabGroups', 'sidePanel', 'storage', 'alarms'].includes(p)),
    'permission set is the intended five',
    manifest.permissions.join(', ')
  );
  check(
    (manifest.optional_host_permissions || []).includes('<all_urls>') &&
    (manifest.optional_permissions || []).includes('scripting'),
    'page access is optional-only, never granted at install'
  );
  check(/^\d+\.\d+\.\d+$/.test(manifest.version), 'manifest carries a version', manifest.version);

  // ------------------------------------------------------------- rebrand
  check(manifest.name === 'SideRail', 'manifest name is SideRail', manifest.name);
  check(!/Navigator/.test(JSON.stringify(manifest)), 'no "Navigator" left in the manifest');

  // No branding left anywhere in shipped code — but the `navigator` Web API
  // must survive untouched. A blind find-and-replace would break Copy URL.
  const shipped = ['background.js', 'common.js', 'sidepanel.js', 'sidepanel.html', 'sidepanel.css'];
  const brandHits = [];
  let webApiUses = 0;
  for (const f of shipped) {
    const src = fs.readFileSync(path.join(EXT, f), 'utf8');
    webApiUses += (src.match(/\bnavigator\.[a-zA-Z]/g) || []).length;
    for (const line of src.split('\n')) {
      if (/\bNavigator\b/.test(line)) brandHits.push(`${f}: ${line.trim().slice(0, 60)}`);
      if (/\bnavigator\b/.test(line) && !/\bnavigator\.[a-zA-Z]/.test(line)) {
        brandHits.push(`${f}: ${line.trim().slice(0, 60)}`);
      }
    }
  }
  check(brandHits.length === 0, 'no "Navigator" branding left in shipped code',
    brandHits.slice(0, 3).join(' | '));
  check(webApiUses >= 1, 'the navigator.* Web API is still present', `${webApiUses} use(s)`);

  // Storage keys must be untouched, or the rename would orphan existing data.
  const commonSrc = fs.readFileSync(path.join(EXT, 'common.js'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(EXT, 'sidepanel.js'), 'utf8');
  const bgSrc = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  const keysUsed = new Set(
    [...(panelSrc + bgSrc + commonSrc).matchAll(/(?:get|set)Store\('([a-zA-Z]+)'/g)].map((x) => x[1])
  );
  check(
    ['workspaces', 'snapshots', 'rules', 'settings', 'groupOrder'].every((k) => keysUsed.has(k)),
    'storage keys unchanged by the rename', [...keysUsed].sort().join(', ')
  );

  // -------------------------------------------------------------- seed tabs
  const seed = [
    'https://example.com/',
    'https://example.com/two',
    'https://example.org/',
    'https://example.org/deep/page',
    'https://example.net/'
  ];
  for (const url of seed) {
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  }
  // A deliberate duplicate for the dedupe test.
  const dupe = await ctx.newPage();
  await dupe.goto('https://example.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});

  // ------------------------------------------------------------- open panel
  const panel = await ctx.newPage();
  const panelErrors = [];
  panel.on('pageerror', (e) => panelErrors.push(String(e)));
  panel.on('console', (m) => { if (m.type() === 'error') panelErrors.push(m.text()); });

  // Survives the panel reloads later tests perform, which a one-off evaluate
  // would not.
  await panel.addInitScript(SHELL_HELPERS);
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  await panel.waitForTimeout(900);

  check(panelErrors.length === 0, 'panel booted with no JS errors', panelErrors.join(' | '));

  const rowCount = await panel.locator('#view-tabs .tab-row').count();
  check(rowCount >= seed.length, 'tab rows rendered', `${rowCount} rows`);

  const titles = await panel.locator('#view-tabs .tab-row .title').allTextContents();
  check(titles.some((t) => /example/i.test(t)), 'row titles populated', titles.slice(0, 3).join(' / '));

  // ------------------------------------------------- favicon / title alignment
  // Regression: the favicon slot used to be an inline box, which reserved
  // descender space below the icon and left the title looking bottom-aligned.
  //
  // Measured against a real <img>, not a letter tile: the fault only appears
  // with an inline-replaced element, so a test using tiles (which are
  // display:grid, hence block-level) passes even when the bug is present.
  const align = await panel.evaluate(async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9h' +
      'AAAAHElEQVQ4y2NgGAWjYBSMglEwCkbBKBgFo2AUAAAGmgABZ0Z9zQAAAABJRU5ErkJggg==';

    const probe = (iconEl) => {
      const row = document.createElement('div');
      row.className = 'tab-row';
      const slot = document.createElement('span');
      slot.className = 'fav-slot';
      slot.appendChild(iconEl);
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = 'Carbon values literature review';
      row.append(slot, title);
      document.getElementById('view-tabs').appendChild(row);
      return { row, slot, iconEl, title };
    };

    const img = document.createElement('img');
    img.className = 'fav';
    img.src = png;
    const a = probe(img);
    await img.decode().catch(() => {});

    const tile = document.createElement('span');
    tile.className = 'letter';
    tile.textContent = 'C';
    const b = probe(tile);

    const read = ({ slot, iconEl, title }) => {
      const i = iconEl.getBoundingClientRect();
      const t = title.getBoundingClientRect();
      return {
        slotH: +slot.getBoundingClientRect().height.toFixed(2),
        iconH: +i.height.toFixed(2),
        offset: +((i.top + i.height / 2) - (t.top + t.height / 2)).toFixed(2)
      };
    };
    const out = { img: read(a), tile: read(b) };
    a.row.remove();
    b.row.remove();
    return out;
  });

  check(Math.abs(align.img.offset) <= 0.5,
    'favicon image shares a centre line with the title',
    `offset ${align.img.offset}px`);
  check(Math.abs(align.img.slotH - align.img.iconH) < 0.5,
    'favicon slot is exactly icon-height (no inline descender gap)',
    `slot ${align.img.slotH} vs icon ${align.img.iconH}`);
  check(Math.abs(align.tile.offset) <= 0.5,
    'letter-tile fallback is centred too', `offset ${align.tile.offset}px`);

  // ----------------------------------------------------------------- search
  await panel.fill('#search', 'example.org');
  await panel.waitForTimeout(350);
  const hits = await panel.locator('#view-tabs .tab-row[data-id]').count();
  check(hits >= 1 && hits < rowCount, 'search narrows the list', `${hits} of ${rowCount}`);
  const webFallback = await panel.locator('#view-tabs .tab-row[data-url]').count();
  check(webFallback >= 1, 'web-search fallback row present');
  await panel.click('#clear-search');
  await panel.waitForTimeout(250);

  // ------------------------------------------------------------- matching
  // Regression cases: these are the exact false positives a plain subsequence
  // matcher produced for the query "supercharge".
  const m = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const s = (q, title, url) => lib.matchScore(q, { title, url });
    return {
      hitHost:  s('supercharge', 'Supercharge — Vertical Tabs', 'https://www.supercharge.example/navigation/'),
      hitTitle: s('supercharge', 'Supercharge your browser extension', 'https://plasmo.com/blog/x'),
      fpUpstack: s('supercharge', "0ponn/upstack: A 'copy for Substack'", 'https://github.com/0ponn/upstack'),
      fpObsidian: s('supercharge', 'cyanheads/obsidian-mcp-server: MCP', 'https://github.com/cyanheads/obsidian-mcp-server'),
      fpQuotio: s('supercharge', 'nguyenphutrong/quotio: Stop juggling', 'https://github.com/nguyenphutrong/quotio'),
      fpClaude: s('supercharge', 'Use the Claude Agent SDK', 'https://support.claude.com/en/articles/12覧'),
      twoTerms: s('git super', 'Supercharge extensions', 'https://github.com/x/supercharge'),
      twoTermsMiss: s('git super', 'Supercharge extensions', 'https://example.com/x/y'),
      initials: s('gd', 'Google Docs', 'https://docs.google.com/'),
      norm: lib.normUrl('https://a.com/x/#frag'),
      dom: lib.domainOf('https://www.bbc.co.uk/news')
    };
  });
  check(m.hitHost > 0 && m.hitTitle > 0, 'real "supercharge" matches still rank', `${m.hitHost}/${m.hitTitle}`);
  check(m.hitHost > m.hitTitle, 'hostname match outranks title match');
  check(
    m.fpUpstack === -1 && m.fpObsidian === -1 && m.fpQuotio === -1 && m.fpClaude === -1,
    'subsequence false positives rejected',
    `upstack=${m.fpUpstack} obsidian=${m.fpObsidian} quotio=${m.fpQuotio} claude=${m.fpClaude}`
  );
  check(m.twoTerms > 0 && m.twoTermsMiss === -1, 'every term must match', `${m.twoTerms}/${m.twoTermsMiss}`);
  check(m.initials > 0, 'initials match ("gd" → Google Docs)');
  check(m.norm === 'https://a.com/x', 'url normalisation strips fragment', m.norm);

  // ------------------------------------------------ URL canonicalisation
  // Tracking parameters made identical pages look distinct, so Dedupe missed them.
  const canon = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const same = (a, b) => lib.normUrl(a) === lib.normUrl(b);
    return {
      // The reported case, verbatim.
      github: same(
        'https://github.com/obra/superpowers?utm_source=viticci&utm_medium=email&utm_campaign=macstories-weekly-issue-511-f9aa',
        'https://github.com/obra/superpowers'),
      clickIds: same('https://shop.com/p?gclid=a&fbclid=b&msclkid=c', 'https://shop.com/p'),
      twitterRef: same('https://x.com/a?ref_src=twsrc%5Etfw', 'https://x.com/a'),
      newsletter: same('https://a.com/post?mc_cid=1&mc_eid=2&mkt_tok=3', 'https://a.com/post'),
      paramOrder: same('https://a.com/s?b=2&a=1', 'https://a.com/s?a=1&b=2'),
      trailingSlash: same('https://a.com/x/', 'https://a.com/x'),

      // Must NOT be treated as the same page.
      youtube: !same('https://youtube.com/watch?v=aaa', 'https://youtube.com/watch?v=bbb'),
      youtubeKeepsV: lib.normUrl('https://youtube.com/watch?v=aaa&utm_source=n')
        === 'https://youtube.com/watch?v=aaa',
      query: !same('https://a.com/s?q=cats', 'https://a.com/s?q=dogs'),
      hashRoutes: !same('https://app.com/#/inbox', 'https://app.com/#/sent'),
      paths: !same('https://a.com/one', 'https://a.com/two'),

      named: lib.trackingParamsIn(
        'https://github.com/obra/superpowers?utm_source=v&utm_medium=email&x=1').join(',')
    };
  });
  check(canon.github, 'utm parameters no longer defeat duplicate detection');
  check(canon.clickIds && canon.twitterRef && canon.newsletter,
    'click ids, ref_src and newsletter tokens are ignored too', JSON.stringify(canon));
  check(canon.paramOrder && canon.trailingSlash, 'parameter order and trailing slash normalised');
  check(canon.youtube && canon.youtubeKeepsV,
    'meaningful query parameters are preserved (?v= still distinguishes videos)');
  check(canon.query && canon.paths, 'genuinely different pages stay distinct');
  check(canon.hashRoutes, 'client-side hash routes are not collapsed');
  check(canon.named === 'utm_source,utm_medium', 'stripped parameters are reported for the UI', canon.named);
  check(m.dom === 'bbc.co.uk', 'domain strips www', m.dom);

  // ------------------------------------------------ page-text scan policy
  // A sweep of ~130 tabs used to take most of a minute, almost all of it spent
  // waiting on tabs that could never answer. `executeScript` does not reject
  // for a frozen tab — it queues the injection until the tab thaws, so the
  // promise never settles and only our own timeout ends the wait. Nothing an
  // extension can do will freeze a tab on demand, so the policy that excludes
  // them is checked here, on synthetic tabs.
  const plan = await panel.evaluate(async () => {
    const { planIndex } = await import('./common.js');
    const tabs = [
      { id: 1, url: 'https://a.example/one' },
      { id: 2, url: 'https://b.example/two', frozen: true },
      { id: 3, url: 'https://c.example/three', discarded: true },
      { id: 4, url: 'chrome://extensions' },
      { id: 5, url: 'https://e.example/five' },
      { id: 6, url: 'https://f.example/six' }
    ];
    const ids = (r) => r.queue.map((t) => t.id);
    const plain = planIndex(tabs);
    const excluded = planIndex(tabs, { exclude: new Set([5]) });
    const read = planIndex(tabs, { indexed: new Set([1, 2]) });
    const failed = planIndex(tabs, { failed: new Set([6]) });
    const never = planIndex(tabs, { isExcluded: (t) => (t.id === 5 ? 'site' : null) });
    return {
      plain: ids(plain), plainAsleep: plain.asleep.map((t) => t.id),
      excluded: ids(excluded),
      read: ids(read), readAsleep: read.asleep.map((t) => t.id), searchable: read.searchable,
      failed: ids(failed),
      never: ids(never), neverWhy: never.excluded.map((x) => `${x.tab.id}:${x.why}`)
    };
  });

  check(JSON.stringify(plan.plain) === JSON.stringify([1, 5, 6]),
    'frozen, discarded and chrome:// tabs are never opened', JSON.stringify(plan.plain));
  check(JSON.stringify(plan.plainAsleep) === JSON.stringify([2, 3]),
    'sleeping tabs are counted, not waited on', JSON.stringify(plan.plainAsleep));
  check(JSON.stringify(plan.excluded) === JSON.stringify([1, 6]),
    'tabs already shown as title matches are not read again');
  check(JSON.stringify(plan.read) === JSON.stringify([5, 6]) &&
        JSON.stringify(plan.readAsleep) === JSON.stringify([3]) && plan.searchable === 2,
    'a tab read before it slept is searchable, not asleep — the index outlives sleep',
    JSON.stringify({ queue: plan.read, asleep: plan.readAsleep, searchable: plan.searchable }));
  check(JSON.stringify(plan.failed) === JSON.stringify([1, 5]),
    'a tab that did not answer is not asked again until a re-index', JSON.stringify(plan.failed));
  check(JSON.stringify(plan.never) === JSON.stringify([1, 6]) && plan.neverWhy[0] === '5:site',
    'an excluded tab is never queued, and the plan says why', JSON.stringify(plan.neverWhy));

  // ------------------------------------------- which side is the panel on?
  // The hover card is drawn inside the page, so it has to know which edge to
  // hug. It used to compare window.screenX between the panel and the page,
  // which always said "right" — Chrome reports the browser window's left edge
  // for both — and the card ended up pinned to the far side of the screen.
  // The cursor's screen position is the reliable signal, so pin the arithmetic.
  const dock = await panel.evaluate(async () => {
    const { dockSide } = await import('./common.js');
    const win = { windowLeft: 1000, windowWidth: 1600, panelWidth: 360 };
    return {
      // Window at x=1000..2600, 360px panel. Cursor inside the panel:
      leftDock: dockSide({ ...win, cursorScreenX: 1180 }),      // 180px in
      rightDock: dockSide({ ...win, cursorScreenX: 2420 }),     // 180px from the right
      leftEdge: dockSide({ ...win, cursorScreenX: 1002 }),
      rightEdge: dockSide({ ...win, cursorScreenX: 2598 }),
      // A window not at the screen origin must not fool it.
      offOrigin: dockSide({ windowLeft: 0, windowWidth: 1600, panelWidth: 360, cursorScreenX: 180 }),
      // Panel wider than half the window: the slices overlap, so fall back
      // to the midpoint rather than always answering "left".
      narrowLeft: dockSide({ windowLeft: 0, windowWidth: 600, panelWidth: 360, cursorScreenX: 100 }),
      narrowRight: dockSide({ windowLeft: 0, windowWidth: 600, panelWidth: 360, cursorScreenX: 500 }),
      // Missing geometry must not silently pick a side by accident.
      noGeometry: dockSide({ cursorScreenX: NaN, windowLeft: 0, windowWidth: 0, panelWidth: 360 })
    };
  });
  check(dock.leftDock === 'left' && dock.rightDock === 'right',
    'the docked side is read from the cursor, not from window.screenX',
    JSON.stringify(dock));
  check(dock.leftEdge === 'left' && dock.rightEdge === 'right',
    'the very edges of the panel still resolve correctly');
  check(dock.offOrigin === 'left',
    'a window away from the screen origin is measured relative to itself');
  check(dock.narrowLeft === 'left' && dock.narrowRight === 'right',
    'a panel wider than half the window falls back to the midpoint');
  check(dock.noGeometry === 'right', 'missing geometry resolves to a single defined side');

  // Same query, driven through the real UI.
  await panel.fill('#search', 'supercharge');
  await panel.waitForTimeout(400);
  const bogus = await panel.locator('#view-tabs .tab-row[data-id]').count();
  check(bogus === 0, 'no bogus tab hits for "supercharge"', `${bogus} rows`);
  await panel.click('#clear-search');
  await panel.waitForTimeout(250);

  // ------------------------------------------------------------- grouping
  await clickMenu(panel, 'Group tabs by domain');
  await panel.waitForTimeout(900);
  const groups = await panel.evaluate(() => chrome.tabGroups.query({}).then((g) =>
    g.map((x) => ({ title: x.title, color: x.color }))));
  check(groups.length >= 2, 'group-by-domain created groups', JSON.stringify(groups));
  check(groups.some((g) => g.title === 'example.com'), 'group titled by domain');

  const groupBlocks = await panel.locator('#view-tabs .group').count();
  check(groupBlocks >= 2, 'group blocks render in panel', `${groupBlocks} blocks`);

  await clickMenu(panel, 'Ungroup all tabs');
  await panel.waitForTimeout(700);
  const after = await panel.evaluate(() => chrome.tabGroups.query({}).then((g) => g.length));
  check(after === 0, 'ungroup-all cleared groups', `${after} remaining`);

  // --------------------------------------------------------------- dedupe
  // Since 0.17 the button is always present and greys out instead of vanishing:
  // three peers that come and go make the footer a moving target. Its label
  // still states how many tabs it would close — the number the sheet then lists.
  const dedupeBtn = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const btn = document.getElementById('act-dedupe');
    return {
      hidden: btn.hidden,
      disabled: btn.disabled,
      label: btn.querySelector('.foot-label').textContent,
      title: btn.title,
      hasIcon: !!btn.querySelector('svg'),
      expected: lib.duplicateCount(tabs)
    };
  });
  check(!dedupeBtn.hidden,
    'the Dedupe button is always on the footer, whether or not it can act');
  check(dedupeBtn.disabled === (dedupeBtn.expected === 0),
    'and it is enabled exactly when there are duplicates',
    `${dedupeBtn.expected} duplicates, disabled=${dedupeBtn.disabled}`);
  check(dedupeBtn.label === (dedupeBtn.expected ? `Dedupe (${dedupeBtn.expected})` : 'Dedupe'),
    'the button says how many tabs it would close', dedupeBtn.label);
  check(dedupeBtn.hasIcon && /duplicate/i.test(dedupeBtn.title),
    'it carries one icon and explains itself in either state',
    `${dedupeBtn.hasIcon} · ${dedupeBtn.title}`);

  // The count has to track the tab strip, not a stale snapshot: opening another
  // copy must raise it, and closing that copy must lower it again.
  const dupeLive = await panel.evaluate(async () => {
    const label = () => document.getElementById('act-dedupe').textContent;
    const num = () => Number((label().match(/\((\d+)\)/) || [0, 0])[1]);
    const settle = async (want) => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (num() === want) return true;
      }
      return false;
    };
    const before = num();

    const open = await chrome.tabs.query({ currentWindow: true, pinned: false });
    const twin = open.find((t) => /^https?:/i.test(t.url || ''));
    if (!twin) return { skipped: true };

    const copy = await chrome.tabs.create({ url: twin.url, active: false });
    const rose = await settle(before + 1);
    const afterOpen = num();

    await chrome.tabs.remove(copy.id);
    const fell = await settle(before);

    return { before, afterOpen, rose, fell, hiddenNow: document.getElementById('act-dedupe').hidden };
  });
  check(dupeLive.skipped || dupeLive.rose,
    'opening a duplicate raises the count', JSON.stringify(dupeLive));
  check(dupeLive.skipped || dupeLive.fell,
    'closing it lowers the count again', JSON.stringify(dupeLive));

  // Must REVIEW, never close on its own.
  const beforeDedupe = await panel.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  await panel.click('#act-dedupe');
  await panel.waitForTimeout(700);

  check(await panel.locator('#sheet').isVisible(), 'dedupe opens a review sheet');
  const stillOpen = await panel.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  check(stillOpen === beforeDedupe, 'nothing closed before confirmation', `${beforeDedupe} → ${stillOpen}`);

  const sheetTitle = await panel.locator('#sheet-title').textContent();
  check(/duplicate URL/.test(sheetTitle || ''), 'sheet summarises the duplicates', sheetTitle);

  const dupeRows = await panel.locator('#sheet-body .dupe-row').count();
  const keepTags = await panel.locator('#sheet-body .tag').count();
  check(dupeRows >= 2 && keepTags >= 1, 'every copy listed, one marked as the keeper',
    `${dupeRows} rows, ${keepTags} keepers`);

  // End to end: a tracking-laden twin must be found, and the clean copy kept.
  await panel.evaluate(async () => { document.getElementById('sheet').hidden = true; });
  const tracked = await panel.evaluate(async () => {
    const clean = 'https://example.net/article';
    const dirty = `${clean}?utm_source=news&utm_medium=email&fbclid=xyz`;
    const a = await chrome.tabs.create({ url: clean, active: false });
    const b = await chrome.tabs.create({ url: dirty, active: false });
    await new Promise((r) => setTimeout(r, 1500));

    const res = await chrome.runtime.sendMessage({
      type: 'find-duplicates', windowId: (await chrome.windows.getCurrent()).id
    });
    const group = (res.groups || []).find((g) => g.key === clean);
    await chrome.tabs.remove([a.id, b.id]).catch(() => {});
    if (!group) return { found: false };
    const keeper = group.tabs.find((t) => t.keep);
    return {
      found: true,
      size: group.tabs.length,
      canonicalHeader: group.url,
      keeperIsClean: keeper && keeper.url === clean,
      trackedReported: group.tabs.find((t) => t.url === clean.length ? 0 : t.url !== clean)?.tracked || []
    };
  });
  check(tracked.found && tracked.size === 2,
    'a tracking-laden twin is detected as a duplicate', JSON.stringify(tracked));
  check(tracked.canonicalHeader === 'https://example.net/article',
    'the sheet shows the canonical URL', String(tracked.canonicalHeader));
  check(tracked.keeperIsClean,
    'the clean URL is preferred as the keeper over the tracked one');
  check((tracked.trackedReported || []).length === 3,
    'the ignored parameters are reported per tab', JSON.stringify(tracked.trackedReported));

  await panel.click('#act-dedupe');
  await panel.waitForTimeout(700);

  const preChecked = await panel.evaluate(() =>
    [...document.querySelectorAll('#sheet-body input')].filter((b) => b.checked).length);
  const keeperChecked = await panel.evaluate(() =>
    [...document.querySelectorAll('#sheet-body .dupe-row.is-keep input')].some((b) => b.checked));
  check(preChecked >= 1 && !keeperChecked, 'keeper is left unticked by default',
    `${preChecked} pre-ticked`);

  const goLabel = await panel.locator('#sheet-go').textContent();
  check(/Close \d+ tabs?/.test(goLabel || ''), 'confirm button counts the selection', goLabel);

  // Untick everything — the button must disable rather than close anything.
  await panel.click('#sheet-none');
  await panel.waitForTimeout(150);
  check(await panel.locator('#sheet-go').isDisabled(), 'confirm disabled with nothing ticked');

  // Cancel leaves every tab alone.
  await panel.click('#sheet-cancel');
  await panel.waitForTimeout(300);
  const afterCancel = await panel.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  check(afterCancel === beforeDedupe, 'cancel closes nothing', `${beforeDedupe} → ${afterCancel}`);

  // Now actually confirm.
  await panel.click('#act-dedupe');
  await panel.waitForTimeout(600);
  await panel.click('#sheet-go');
  await panel.waitForTimeout(900);
  const afterDedupe = await panel.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  check(afterDedupe < beforeDedupe, 'confirming closes the ticked tabs', `${beforeDedupe} → ${afterDedupe}`);
  check(await panel.locator('#sheet').isHidden(), 'sheet dismisses after closing');

  // ------------------------------------------------------ close button
  // Regression: the × must fire on pointerdown, so a re-render mid-click
  // can't cancel it.
  const closeBtn = await panel.evaluate(async () => {
    const row = document.querySelector('#view-tabs .tab-row[data-id]');
    const id = Number(row.dataset.id);
    const btn = row.querySelector('.close');
    const rect = btn.getBoundingClientRect();
    return { id, hasBtn: !!btn, w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  check(closeBtn.hasBtn && closeBtn.w >= 20 && closeBtn.h >= 20,
    'close button has a real hit area', `${closeBtn.w}×${closeBtn.h}`);

  const closed = await panel.evaluate(async (id) => {
    const row = document.querySelector(`#view-tabs .tab-row[data-id="${id}"]`);
    const btn = row.querySelector('.close');
    // Deliberately fire ONLY pointerdown — no click event follows.
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 600));
    const gone = await chrome.tabs.get(id).then(() => false).catch(() => true);
    return gone;
  }, closeBtn.id);
  check(closed, 'pointerdown alone closes the tab');

  // Same regression for switching tabs: pointerdown must be enough.
  const switched = await panel.evaluate(async () => {
    const rows = [...document.querySelectorAll('#view-tabs .tab-row[data-id]')];
    const inactive = rows.find((r) => !r.classList.contains('is-active'));
    if (!inactive) return { skipped: true };
    const id = Number(inactive.dataset.id);
    inactive.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0
    }));
    await new Promise((r) => setTimeout(r, 500));
    const t = await chrome.tabs.get(id).catch(() => null);
    return { active: !!(t && t.active), id };
  });
  check(switched.skipped || switched.active,
    'pointerdown alone switches to the tab', JSON.stringify(switched));

  // Right-click must not switch tabs.
  const rightClick = await panel.evaluate(async () => {
    const rows = [...document.querySelectorAll('#view-tabs .tab-row[data-id]')];
    const inactive = rows.find((r) => !r.classList.contains('is-active'));
    if (!inactive) return { skipped: true };
    const id = Number(inactive.dataset.id);
    inactive.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 2
    }));
    await new Promise((r) => setTimeout(r, 350));
    const t = await chrome.tabs.get(id).catch(() => null);
    return { active: !!(t && t.active) };
  });
  check(rightClick.skipped || !rightClick.active,
    'right-click does not switch tabs', JSON.stringify(rightClick));

  // ------------------------------------------------------- context menu
  const openMenu = async () => panel.evaluate(async () => {
    const row = document.querySelector('#view-tabs .tab-row[data-id]');
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 40, clientY: 90
    }));
    await new Promise((r) => setTimeout(r, 120));
    return !document.getElementById('ctxmenu').hidden;
  });

  check(await openMenu(), 'right-click opens the context menu');

  // Clicking in the browser window can't reach this document, so the panel
  // has to fall back on losing focus.
  const blurClosed = await panel.evaluate(async () => {
    window.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 120));
    return document.getElementById('ctxmenu').hidden;
  });
  check(blurClosed, 'menu closes when the panel loses focus');

  await openMenu();
  const outsideClosed = await panel.evaluate(async () => {
    document.getElementById('main').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 120));
    return document.getElementById('ctxmenu').hidden;
  });
  check(outsideClosed, 'menu closes on a click elsewhere in the panel');

  await openMenu();
  const scrollClosed = await panel.evaluate(async () => {
    document.getElementById('main').dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 120));
    return document.getElementById('ctxmenu').hidden;
  });
  check(scrollClosed, 'menu closes on scroll');

  await openMenu();
  const escClosed = await panel.evaluate(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return document.getElementById('ctxmenu').hidden;
  });
  check(escClosed, 'menu closes on Escape');

  // Regression: a real side panel is routinely never given document focus, so
  // testing hasFocus() as an absolute value closed the menu on the first tick.
  // Dismissal must key off a focused → unfocused TRANSITION.
  const neverFocused = await panel.evaluate(async () => {
    const menu = document.getElementById('ctxmenu');
    const real = document.hasFocus.bind(document);
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
    try {
      document.querySelector('#view-tabs .tab-row[data-id]').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 }));
      await new Promise((r) => setTimeout(r, 120));
      const opened = !menu.hidden;
      await new Promise((r) => setTimeout(r, 900));
      return { opened, stillOpen: !menu.hidden };
    } finally {
      Object.defineProperty(document, 'hasFocus', { value: real, configurable: true });
      menu.hidden = true;
    }
  });
  check(neverFocused.opened && neverFocused.stillOpen,
    'menu survives when the panel never receives focus', JSON.stringify(neverFocused));

  // …but losing focus that WAS held still closes it.
  const lostFocus = await panel.evaluate(async () => {
    const menu = document.getElementById('ctxmenu');
    const real = document.hasFocus.bind(document);
    Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
    try {
      document.querySelector('#view-tabs .tab-row[data-id]').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 }));
      await new Promise((r) => setTimeout(r, 350));
      const heldOpen = !menu.hidden;
      Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
      await new Promise((r) => setTimeout(r, 400));
      return { heldOpen, closed: menu.hidden };
    } finally {
      Object.defineProperty(document, 'hasFocus', { value: real, configurable: true });
      menu.hidden = true;
    }
  });
  check(lostFocus.heldOpen && lostFocus.closed,
    'menu still closes once focus is held and then lost', JSON.stringify(lostFocus));

  // Pointer leaving the menu closes it shortly after — the practical stand-in
  // for "clicked on the page", which this document cannot observe.
  const pointerAway = await panel.evaluate(async () => {
    const menu = document.getElementById('ctxmenu');
    document.querySelector('#view-tabs .tab-row[data-id]').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 }));
    await new Promise((r) => setTimeout(r, 120));
    menu.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 200));
    const openWhileHovered = !menu.hidden;
    menu.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 700));
    const stillOpenEarly = !menu.hidden;
    await new Promise((r) => setTimeout(r, 800));
    return { openWhileHovered, stillOpenEarly, closedAfter: menu.hidden };
  });
  check(pointerAway.openWhileHovered && pointerAway.stillOpenEarly && pointerAway.closedAfter,
    'menu closes shortly after the pointer leaves it', JSON.stringify(pointerAway));

  // …and the items still work despite all that dismissal machinery.
  const menuWorks = await panel.evaluate(async () => {
    const row = document.querySelector('#view-tabs .tab-row[data-id]');
    const id = Number(row.dataset.id);
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 40, clientY: 90
    }));
    await new Promise((r) => setTimeout(r, 120));
    const btn = [...document.querySelectorAll('#ctxmenu button')]
      .find((b) => /^Pin$|^Unpin$/.test(b.textContent));
    if (!btn) return { skipped: true };
    const wasPinned = (await chrome.tabs.get(id)).pinned;
    btn.click();
    await new Promise((r) => setTimeout(r, 500));
    const nowPinned = (await chrome.tabs.get(id)).pinned;
    return { changed: wasPinned !== nowPinned, hidden: document.getElementById('ctxmenu').hidden };
  });
  check(menuWorks.skipped || (menuWorks.changed && menuWorks.hidden),
    'menu items still fire and dismiss the menu', JSON.stringify(menuWorks));

  // ---------------------------------------------------------- live spaces
  // A space is a LABEL on a tab, not a container. Switching must therefore be
  // provably inert: no tab closed, created, moved or reloaded.
  const spaceSetup = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const a = lib.makeLiveSpace({ name: 'Work', emoji: '💼' });
    const b = lib.makeLiveSpace({ name: 'Play', emoji: '🎮' });
    await chrome.storage.local.set({ spaces: [a, b] });
    await new Promise((r) => setTimeout(r, 600));

    // Split this window's tabs between the two spaces.
    const tabs = (await chrome.tabs.query({ currentWindow: true, pinned: false }))
      .filter((t) => /^https?:/i.test(t.url || ''));
    const spaceOf = {};
    tabs.forEach((t, i) => { spaceOf[t.id] = i % 2 === 0 ? a.id : b.id; });
    await __writeSpaceOf(spaceOf);
    await new Promise((r) => setTimeout(r, 800));

    return { a: a.id, b: b.id, split: tabs.length, inA: Math.ceil(tabs.length / 2) };
  });
  check(spaceSetup.split >= 4, 'enough tabs to split between two spaces',
    `${spaceSetup.split} tabs`);

  const spaceBar = await panel.evaluate(async () => {
    __goBrowse();
    await new Promise((r) => setTimeout(r, 600));
    const chips = [...document.querySelectorAll('.space-bar .schip')].map((c) => ({
      name: c.querySelector('.nm')?.textContent,
      count: c.querySelector('.ct')?.textContent,
      on: c.classList.contains('is-on')
    }));
    return { chips, rows: document.querySelectorAll('#view-tabs .tab-row[data-id]').length };
  });
  check(spaceBar.chips.some((c) => c.name === 'Work') && spaceBar.chips.some((c) => c.name === 'Play'),
    'the space bar lists every space', JSON.stringify(spaceBar.chips));
  check(spaceBar.chips.filter((c) => c.on).length === 1,
    'exactly one space is showing', JSON.stringify(spaceBar.chips.map((c) => [c.name, c.on])));

  // THE test: switching changes what is drawn and nothing else.
  const inert = await panel.evaluate(async () => {
    const wid = (await chrome.windows.getCurrent()).id;
    const snap = async () => (await chrome.tabs.query({ windowId: wid }))
      .sort((a, b) => a.index - b.index)
      .map((t) => `${t.id}:${t.index}:${t.url}:${t.groupId}`).join('|');

    const before = await snap();
    const winsBefore = (await chrome.windows.getAll()).length;
    const rowsBefore = document.querySelectorAll('#view-tabs .tab-row[data-id]').length;

    const other = [...document.querySelectorAll('.space-bar .schip')]
      .find((c) => !c.classList.contains('is-on'));
    if (!other) return { skipped: true };
    other.click();
    await new Promise((r) => setTimeout(r, 700));

    return {
      identical: (await snap()) === before,
      winsSame: (await chrome.windows.getAll()).length === winsBefore,
      rowsBefore,
      rowsAfter: document.querySelectorAll('#view-tabs .tab-row[data-id]').length,
      switched: [...document.querySelectorAll('.space-bar .schip')]
        .find((c) => c.classList.contains('is-on'))?.querySelector('.nm')?.textContent
    };
  });
  check(inert.skipped || inert.identical,
    'switching space leaves every tab exactly as it was — id, order, URL and group',
    JSON.stringify({ identical: inert.identical }));
  check(inert.skipped || inert.winsSame, 'switching space opens no window');
  check(inert.skipped || inert.rowsAfter !== inert.rowsBefore,
    'the panel really is showing a different set of tabs',
    `${inert.rowsBefore} → ${inert.rowsAfter} rows`);

  // Only the showing space's tabs are drawn.
  const filtered = await panel.evaluate(async () => {
    const shown = [...document.querySelectorAll('#view-tabs .tab-row[data-id]')]
      .map((r) => Number(r.dataset.id));
    const spaceOf = await __readSpaceOf();
    // Read the showing space from where the panel keeps it, not by chip index —
    // Main is always chip 0 and is not in the stored `spaces` array.
    const wid = (await chrome.windows.getCurrent()).id;
    const activeId = (await chrome.storage.session.get(`activeSpace:${wid}`))[`activeSpace:${wid}`];
    const globals = new Set(Object.entries(spaceOf)
      .filter(([, v]) => v === '*').map(([k]) => Number(k)));
    return {
      activeId,
      strays: shown.filter((id) => !globals.has(id) && (spaceOf[id] || 'unsorted') !== activeId)
    };
  });
  check(filtered.strays.length === 0,
    'no tab from another space is drawn', JSON.stringify(filtered.strays));

  // A new tab lands in the space on screen, not in its opener's.
  //
  // This assertion used to read the other way round — "inherits its space" —
  // and passed for four releases while testing nothing. Both reasons are worth
  // writing down. `chrome.tabs.create({openerTabId})` does NOT carry the opener
  // in the `onCreated` payload at all (only a tab the BROWSER makes does), and
  // the parent it happened to pick was already in the space the panel was
  // showing, so the two rules could never disagree. The teeth are now explicit:
  // the opener is parked somewhere the panel is definitely not showing, and
  // that difference is asserted before anything is concluded from it.
  const inherit = await panel.evaluate(async () => {
    const wid = (await chrome.windows.getCurrent()).id;
    const k = 'activeSpace:' + wid;                    // common.js SPACE_KEY
    const showing = (await chrome.storage.session.get(k))[k] || 'unsorted';

    const spaceOf = await __readSpaceOf();
    const parent = (await chrome.tabs.query({ windowId: wid }))
      .find((t) => !t.pinned && spaceOf[t.id]);
    if (!parent) return { error: 'no parent tab with a space' };
    const parked = 'elsewhere';
    await __writeSpaceOf({ [parent.id]: parked });
    await new Promise((r) => setTimeout(r, 400));

    const child = await chrome.tabs.create({
      windowId: wid, url: 'https://example.com/child', openerTabId: parent.id, active: false
    });
    await new Promise((r) => setTimeout(r, 1200));
    const got = (await __readSpaceOf())[child.id];

    await chrome.tabs.remove(child.id).catch(() => {});
    await __writeSpaceOf({ [parent.id]: spaceOf[parent.id] });
    await new Promise((r) => setTimeout(r, 400));
    return { showing, parked, got };
  });
  check(!inherit.error && inherit.parked !== inherit.showing,
    'the placement check has teeth: the opener sits in a space that is not on screen',
    JSON.stringify(inherit));
  check(inherit.got === inherit.showing,
    "a new tab lands in the space on screen, not its opener's",
    `${inherit.got} vs ${inherit.showing}`);

  // Deleting a space closes nothing — its tabs fall back to Unsorted.
  const del = await panel.evaluate(async () => {
    const wid = (await chrome.windows.getCurrent()).id;
    const before = (await chrome.tabs.query({ windowId: wid })).length;
    __goManage('spaces');
    await new Promise((r) => setTimeout(r, 500));
    const card = [...document.querySelectorAll('#view-spaces .space-card')]
      .find((c) => /Play/.test(c.querySelector('.card-name')?.textContent || ''));
    if (!card) return { skipped: true };
    [...card.querySelectorAll('.card-actions button')]
      .find((b) => /Delete/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 500));
    const warning = document.getElementById('dialog-body').textContent;
    [...document.querySelectorAll('#dialog-actions button')]
      .find((b) => /Delete space/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 900));
    const spaceOf = await __readSpaceOf();
    return {
      warning,
      after: (await chrome.tabs.query({ windowId: wid })).length,
      before,
      unsorted: Object.values(spaceOf).filter((v) => v === 'unsorted').length
    };
  });
  check(del.skipped || /stay open/i.test(del.warning),
    'deleting says the tabs stay open', (del.warning || '').slice(0, 60));
  check(del.skipped || del.after === del.before,
    'deleting a space closes nothing', `${del.before} → ${del.after}`);
  check(del.skipped || del.unsorted > 0,
    'its tabs fall back to Unsorted rather than vanishing', `${del.unsorted} unsorted`);

  await backToBrowse(panel);
  await panel.waitForTimeout(400);


  // -------------------------------------------------------------- snapshots
  // Driven from the panel: sendMessage from the SW would not reach its own handler.
  const snap = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'snapshot-now' }).catch(() => null);
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    return { replied: !!(r && r.ok), count: snapshots.length, tabs: snapshots[0]?.tabCount || 0 };
  });
  check(snap.replied, 'background answered snapshot-now');
  check(snap.count >= 1, 'snapshot written to ring buffer', JSON.stringify(snap));

  await openManage(panel, 'rewind');
  await panel.waitForTimeout(400);
  const snapCards = await panel.locator('#view-rewind .card').count();
  check(snapCards >= 1, 'rewind view lists snapshots', `${snapCards} cards`);

  // Duplicate-state suppression: a second immediate snapshot should be skipped.
  const dupSnap = await panel.evaluate(async () => {
    const get = async () => ((await chrome.storage.local.get('snapshots')).snapshots || []).length;
    const before = await get();
    await chrome.runtime.sendMessage({ type: 'snapshot-now' });
    return { before, after: await get() };
  });
  check(dupSnap.after === dupSnap.before, 'identical snapshot suppressed', JSON.stringify(dupSnap));

  // -------------------------------------------------- pinned strip is sticky
  await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const t = tabs.find((x) => /example\.net/.test(x.url)) || tabs[0];
    await chrome.tabs.update(t.id, { pinned: true });
  });
  await backToBrowse(panel);
  await panel.waitForTimeout(500);
  // Pinned tabs are per-space now, and an unassigned one lives in Main — so the
  // strip is only populated while Main is showing. That IS the feature.
  await panel.evaluate(async () => {
    document.querySelector('.space-bar .schip')?.click();
    await new Promise((r) => setTimeout(r, 500));
  });
  await panel.waitForTimeout(400);
  const pinCss = await panel.evaluate(() => {
    const s = document.querySelector('.pin-strip');
    if (!s) return null;
    const cs = getComputedStyle(s);
    return { position: cs.position, top: cs.top, chips: s.childElementCount };
  });
  const stickCss = await panel.evaluate(() => {
    const s = document.querySelector('.stick');
    if (!s) return null;
    const cs = getComputedStyle(s);
    return { position: cs.position, top: cs.top, hasPins: !!s.querySelector('.pin-strip') };
  });
  check(stickCss && stickCss.position === 'sticky' && stickCss.top === '0px',
    'pinned strip is sticky at the top', JSON.stringify(stickCss));
  check(pinCss && pinCss.chips >= 1, 'pinned chips render', JSON.stringify(pinCss));

  // A pin belongs to one space; it appears in another only if you say so.
  const pinScope = await panel.evaluate(async () => {
    const chips = () => document.querySelectorAll('.pin-strip .pin-chip').length;
    const inMain = chips();
    const others = [...document.querySelectorAll('.space-bar .schip')].slice(1);
    if (!others.length) return { skipped: true };
    others[0].click();
    await new Promise((r) => setTimeout(r, 600));
    const inOther = chips();

    // Now make it global and check it rides along.
    document.querySelector('.space-bar .schip').click();
    await new Promise((r) => setTimeout(r, 500));
    const pinned = (await chrome.tabs.query({ currentWindow: true, pinned: true }))[0];
    const spaceOf = await __readSpaceOf();
    spaceOf[pinned.id] = '*';
    await __writeSpaceOf(spaceOf);
    await new Promise((r) => setTimeout(r, 700));
    others[0].click();
    await new Promise((r) => setTimeout(r, 600));
    const globalElsewhere = chips();
    const dotted = !!document.querySelector('.pin-strip .pin-chip.is-global');

    document.querySelector('.space-bar .schip').click();
    await new Promise((r) => setTimeout(r, 400));
    return { inMain, inOther, globalElsewhere, dotted };
  });
  check(pinScope.skipped || (pinScope.inMain >= 1 && pinScope.inOther === 0),
    'a pinned tab shows only in its own space', JSON.stringify(pinScope));
  check(pinScope.skipped || pinScope.globalElsewhere >= 1,
    'a pin marked global rides along into other spaces', JSON.stringify(pinScope));
  check(pinScope.skipped || pinScope.dotted,
    'a global pin is marked, so the two kinds are tellable apart');

  // ------------------------------------------------------ group jump bar
  await clickMenu(panel, 'Group tabs by domain');
  await panel.waitForTimeout(900);

  const jump = await panel.evaluate(async () => {
    const chips = [...document.querySelectorAll('.group-bar .gjump')];
    if (!chips.length) return { skipped: true };

    const groups = await chrome.tabGroups.query({ windowId: (await chrome.windows.getCurrent()).id });
    const labels = chips.map((c) => c.querySelector('.gname').textContent);
    const colours = chips.map((c) => c.style.getPropertyValue('--gc'));
    const expected = groups.map((g) => g.title || '?');
    const titles = chips.map((c) => c.title);

    // Pick a group the active tab is NOT in, so a switch should happen.
    const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    let idx = -1;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].id !== active.groupId) { idx = i; break; }
    }
    if (idx === -1) return { labels, colours, expected, skipped: 'no other group' };

    const targetGroup = groups[idx];
    const chip = chips.find((c) =>
      c.title.startsWith(targetGroup.title || '')) || chips[idx];
    chip.click();
    await new Promise((r) => setTimeout(r, 700));

    const nowActive = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    return {
      labels, colours, expected, titles,
      switchedIntoGroup: nowActive.groupId === targetGroup.id,
      scrolled: document.getElementById('main').scrollTop >= 0
    };
  });

  check(jump.skipped === true || (jump.labels && jump.labels.length >= 1),
    'group-jump bar renders one chip per group', JSON.stringify(jump.labels));
  check(jump.skipped === true ||
    jump.labels.every((l, i) => l === jump.expected[i]),
    'chips carry the group’s real name, not its initial',
    `${JSON.stringify(jump.labels)} vs ${JSON.stringify(jump.expected)}`);
  check(jump.skipped === true ||
    jump.colours.every((c) => /var\(--g-/.test(c)),
    'chips carry the group colour', JSON.stringify(jump.colours));
  check(jump.skipped ? true : jump.switchedIntoGroup,
    'clicking a chip switches into that group', JSON.stringify(jump));

  // Clicking the chip for the group you're already in must not switch tabs.
  const noSwitch = await panel.evaluate(async () => {
    const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!active || active.groupId === -1) return { skipped: true };
    const g = await chrome.tabGroups.get(active.groupId);
    const chip = [...document.querySelectorAll('.group-bar .gjump')]
      .find((c) => c.title.startsWith(g.title || ''));
    if (!chip) return { skipped: true };
    chip.click();
    await new Promise((r) => setTimeout(r, 500));
    const after = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    return { same: after.id === active.id };
  });
  check(noSwitch.skipped || noSwitch.same,
    'chip for the current group does not steal the active tab', JSON.stringify(noSwitch));

  // ---------------------------------------------- jump-bar reordering
  await panel.evaluate(async () => {
    const windowId = (await chrome.windows.getCurrent()).id;
    const tabs = (await chrome.tabs.query({ windowId, pinned: false })).slice(0, 4);
    if (tabs.length < 2) return;
    const g1 = await chrome.tabs.group({ tabIds: [tabs[0].id], createProperties: { windowId } });
    await chrome.tabGroups.update(g1, { title: 'Alpha', color: 'red' });
    const g2 = await chrome.tabs.group({ tabIds: [tabs[1].id], createProperties: { windowId } });
    await chrome.tabGroups.update(g2, { title: 'Beta', color: 'green' });
  });
  await panel.waitForTimeout(800);

  const reorder = await panel.evaluate(async () => {
    const chips = () => [...document.querySelectorAll('.gjump-list .gjump')];
    if (chips().length < 2) return { skipped: true };
    const before = chips().map((c) => c.textContent);
    const draggable = chips().every((c) => c.draggable);

    // Drag the second chip onto the first.
    const dt = new DataTransfer();
    dt.setData('text/plain', `group:${chips()[1]._gid}`);
    chips()[0].dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt
    }));
    await new Promise((r) => setTimeout(r, 600));

    const after = chips().map((c) => c.textContent);
    const stored = (await chrome.storage.local.get('groupOrder')).groupOrder || [];
    return { draggable, before, after, stored, moved: before[0] !== after[0] };
  });
  check(reorder.skipped || reorder.draggable, 'jump-bar chips are draggable');
  check(reorder.skipped || reorder.moved,
    'dragging a chip reorders the jump bar', JSON.stringify(reorder));
  check(reorder.skipped || reorder.stored.length >= 2,
    'jump-bar order is persisted', JSON.stringify(reorder.stored));

  // The order must survive a panel reload.
  const persisted = await panel.evaluate(async () => {
    const wanted = ((await chrome.storage.local.get('groupOrder')).groupOrder || []);
    return wanted;
  });
  await panel.reload({ waitUntil: 'load' });
  await panel.waitForTimeout(900);
  const afterReload = await panel.evaluate(() =>
    [...document.querySelectorAll('.gjump-list .gjump')].map((c) => c.textContent));
  check(reorder.skipped || JSON.stringify(afterReload) === JSON.stringify(reorder.after),
    'jump-bar order survives a reload',
    `${JSON.stringify(afterReload)} vs ${JSON.stringify(reorder.after)} (${persisted.length} keys)`);

  // ------------------------------------------- rule colour reaches the chip
  const recolour = await panel.evaluate(async () => {
    const windowId = (await chrome.windows.getCurrent()).id;
    // Clear the hand-made groups first: applyRules deliberately won't touch
    // tabs sitting in a group it doesn't manage.
    const all = await chrome.tabs.query({ windowId });
    const grouped = all.filter((t) => t.groupId !== -1).map((t) => t.id);
    if (grouped.length) await chrome.tabs.ungroup(grouped);
    await new Promise((r) => setTimeout(r, 400));

    // A rule whose tabs are ALREADY grouped — the case that used to silently
    // skip the colour update because no tabs needed moving.
    const rules = [{
      id: 'colour', name: 'example.com', color: 'red', enabled: true,
      patterns: ['example.com']
    }];
    await chrome.storage.local.set({ rules });
    await chrome.runtime.sendMessage({ type: 'apply-rules', windowId, rules });
    await new Promise((r) => setTimeout(r, 600));
    const first = (await chrome.tabGroups.query({ windowId }))
      .find((g) => g.title === 'example.com');

    // Second pass moves nothing; only the colour differs.
    rules[0].color = 'cyan';
    await chrome.storage.local.set({ rules });
    const res = await chrome.runtime.sendMessage({ type: 'apply-rules', windowId, rules });
    await new Promise((r) => setTimeout(r, 700));
    const second = (await chrome.tabGroups.query({ windowId }))
      .find((g) => g.title === 'example.com');

    const chip = [...document.querySelectorAll('.gjump-list .gjump')]
      .find((c) => c.title.startsWith('example.com'));
    return {
      firstColor: first && first.color,
      secondColor: second && second.color,
      moved: res && res.n,
      chipColor: chip && chip.style.getPropertyValue('--gc')
    };
  });
  check(recolour.firstColor === 'red', 'rule sets its group colour', String(recolour.firstColor));
  check(recolour.secondColor === 'cyan',
    'changing a rule colour recolours an already-grouped set',
    `${recolour.firstColor} → ${recolour.secondColor}, moved=${recolour.moved}`);
  check(recolour.moved === 0, 'the recolour pass still moves no tabs', String(recolour.moved));
  check(recolour.chipColor === 'var(--g-cyan)',
    'jump-bar chip picks up the new colour', String(recolour.chipColor));

  // --------------------------------------------------- overflow menu contents
  const overflow = await panel.evaluate(async () => {
    document.getElementById('gmenu').click();
    await new Promise((r) => setTimeout(r, 200));
    const labels = [...document.querySelectorAll('#ctxmenu button')].map((b) => b.textContent);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return labels;
  });
  check(['Group tabs by domain', 'Ungroup all tabs', 'Save window as a Space']
    .every((l) => overflow.includes(l)),
    'overflow menu carries Group, Ungroup and Save', JSON.stringify(overflow));
  const footIds = await panel.evaluate(() =>
    [...document.querySelectorAll('#foot button')].map((b) => b.id));
  check(!footIds.includes('act-group') && !footIds.includes('act-ungroup') &&
        !footIds.includes('act-save'),
    'those three are gone from the footer', JSON.stringify(footIds));

  // The bar (and so the menu) must exist even with no groups at all.
  await clickMenu(panel, 'Ungroup all tabs');
  await panel.waitForTimeout(700);
  const barWithoutGroups = await panel.evaluate(() => ({
    chips: document.querySelectorAll('.gjump-list .gjump').length,
    menu: !!document.getElementById('gmenu')
  }));
  check(barWithoutGroups.chips === 0 && barWithoutGroups.menu,
    'menu still reachable when there are no groups', JSON.stringify(barWithoutGroups));

  await clickMenu(panel, 'Ungroup all tabs');
  await panel.waitForTimeout(600);

  // ------------------------------------------------------- flicker regression
  // A busy tab firing repeated updates must not tear down the whole list.
  const flicker = await panel.evaluate(async () => {
    const rows = () => [...document.querySelectorAll('#view-tabs .tab-row[data-id]')];
    const before = rows();
    if (before.length < 3) return { skipped: true };
    const target = before[0];
    const bystander = before[before.length - 1];
    const targetId = Number(target.dataset.id);

    // Two separate things are worth knowing: whether rows are torn down and
    // rebuilt (the flicker itself), and how much incidental churn an update
    // costs. Only the first is a flat guarantee; the second scales with the
    // number of rows on screen, so the budget has to as well.
    let mutations = 0;
    let rowChurn = 0;
    const detail = {};
    const obs = new MutationObserver((list) => {
      mutations += list.length;
      for (const m of list) {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const key = `${m.type}:${m.attributeName || ''}:${t ? (t.className || t.tagName) : '?'}`;
        detail[key] = (detail[key] || 0) + 1;
        if (m.type !== 'childList') continue;
        const touched = [...m.addedNodes, ...m.removedNodes];
        if (touched.some((n) => n.nodeType === 1 && /\btab-row\b/.test(n.className || ''))) rowChurn++;
      }
    });
    obs.observe(document.getElementById('view-tabs'),
      { childList: true, subtree: true, characterData: true, attributes: true });

    for (let i = 0; i < 4; i++) {
      await chrome.tabs.update(targetId, { muted: i % 2 === 0 });
      await new Promise((r) => setTimeout(r, 200));
    }
    obs.disconnect();

    const after = rows();
    return {
      rows: after.length,
      sameTarget: after.includes(target),
      sameBystander: after.includes(bystander),
      mutations,
      rowChurn,
      detail
    };
  });

  if (flicker.skipped) {
    ok('flicker regression skipped (too few rows)');
  } else {
    check(flicker.sameTarget && flicker.sameBystander,
      'row DOM nodes are reused across updates', JSON.stringify(flicker));
    check(flicker.rowChurn === 0,
      'no tab row is added or removed by a repeated update',
      `${flicker.rowChurn} row insertions/removals`);
    check(flicker.mutations < 8 + flicker.rows * 5,
      'repeated tab updates cause minimal DOM churn',
      `${flicker.mutations} mutations for ${flicker.rows} rows ${JSON.stringify(flicker.detail)}`);
  }

  // -------------------------------------------------------------- rule engine
  const ruleLib = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const plain = lib.compileRule({ patterns: ['booking.com', 'easyjet.com'] });
    const glob = lib.compileRule({ patterns: ['*.expedia.*'] });
    const rx = lib.compileRule({ patterns: ['/^https:\\/\\/(www\\.)?airbnb\\./i'] });
    const kw = lib.compileRule({ patterns: ['jira'] });
    return {
      plainHit: lib.ruleMatches(plain, 'https://www.booking.com/hotel/mt/x.html'),
      plainHit2: lib.ruleMatches(plain, 'https://easyjet.com/en/booking'),
      subdomain: lib.ruleMatches(plain, 'https://secure.booking.com/login'),
      pathMiss: lib.ruleMatches(plain, 'https://github.com/booking'),
      queryMiss: lib.ruleMatches(plain, 'https://elsewhere.com/?ref=booking.com'),
      lookalikeMiss: lib.ruleMatches(plain, 'https://notbooking.com/'),
      keyword: lib.ruleMatches(kw, 'https://acme.atlassian.net/jira/board/1'),
      globHit: lib.ruleMatches(glob, 'https://www.expedia.co.uk/trips'),
      rxHit: lib.ruleMatches(rx, 'https://www.airbnb.co.uk/trips/v1'),
      rxMiss: lib.ruleMatches(rx, 'https://notairbnb.com/'),
      activeCount: lib.activeRules([
        { enabled: true, patterns: ['a'] },
        { enabled: false, patterns: ['b'] },
        { enabled: true, patterns: ['  '] }
      ]).length
    };
  });
  check(ruleLib.plainHit && ruleLib.plainHit2 && ruleLib.globHit && ruleLib.rxHit,
    'rule patterns match (domain, glob, regex)', JSON.stringify(ruleLib));
  check(ruleLib.subdomain, 'bare domain also matches subdomains');
  check(ruleLib.keyword, 'dotless pattern matches anywhere in the URL');
  check(!ruleLib.pathMiss && !ruleLib.queryMiss && !ruleLib.lookalikeMiss,
    'bare domain does not over-match paths, query strings or lookalikes',
    `path=${ruleLib.pathMiss} query=${ruleLib.queryMiss} lookalike=${ruleLib.lookalikeMiss}`);
  check(!ruleLib.rxMiss, 'anchored regex does not over-match');
  check(ruleLib.activeCount === 1, 'disabled and empty rules are inert', String(ruleLib.activeCount));

  // Real grouping through the background worker.
  const ruleRun = await panel.evaluate(async () => {
    const rules = [{
      id: 'travel', name: 'Travel', color: 'green', enabled: true,
      patterns: ['example.org', 'example.net']
    }];
    await chrome.storage.local.set({ rules });
    const r = await chrome.runtime.sendMessage({
      type: 'apply-rules',
      windowId: (await chrome.windows.getCurrent()).id,
      rules
    });
    await new Promise((res) => setTimeout(res, 500));
    const groups = await chrome.tabGroups.query({});
    return { moved: r && r.n, groups: groups.map((g) => ({ t: g.title, c: g.color })) };
  });
  check(ruleRun.moved > 0, 'rule pass moved tabs', String(ruleRun.moved));
  check(ruleRun.groups.some((g) => g.t === 'Travel' && g.c === 'green'),
    'named group created with the chosen colour', JSON.stringify(ruleRun.groups));

  // Idempotence: a second pass must be a no-op, otherwise auto-apply would loop.
  const second = await panel.evaluate(async () => {
    const { rules } = await chrome.storage.local.get('rules');
    const r = await chrome.runtime.sendMessage({
      type: 'apply-rules', windowId: (await chrome.windows.getCurrent()).id, rules
    });
    return r && r.n;
  });
  check(second === 0, 'second rule pass is a no-op', String(second));

  // A hand-named group must survive a rule pass untouched.
  const manual = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
    const victim = tabs.find((t) => /example\.org/.test(t.url));
    if (!victim) return { skipped: true };
    const gid = await chrome.tabs.group({ tabIds: [victim.id] });
    await chrome.tabGroups.update(gid, { title: 'My own group', color: 'pink' });
    const { rules } = await chrome.storage.local.get('rules');
    await chrome.runtime.sendMessage({
      type: 'apply-rules', windowId: (await chrome.windows.getCurrent()).id, rules
    });
    await new Promise((res) => setTimeout(res, 400));
    const after = await chrome.tabs.get(victim.id);
    const g = await chrome.tabGroups.get(after.groupId).catch(() => null);
    return { title: g && g.title };
  });
  check(manual.skipped || manual.title === 'My own group',
    'manual groups are left alone by rules', JSON.stringify(manual));

  // ------------------------------------------- renaming a rule-made group
  // A rule names its group after itself. Renaming only the group would be
  // undone by the next pass, which would rebuild the old group and take these
  // tabs back — so the rename has to carry the rule with it.
  const renameGroup = await panel.evaluate(async () => {
    const windowId = (await chrome.windows.getCurrent()).id;
    await chrome.storage.local.set({ groupOrder: ['t:travel', 't:something-else'] });
    await new Promise((r) => setTimeout(r, 400));

    __goBrowse();
    await new Promise((r) => setTimeout(r, 500));

    const head = [...document.querySelectorAll('#view-tabs .group-head')]
      .find((h) => /Travel/.test(h.querySelector('.gname')?.textContent || ''));
    if (!head) return { skipped: true };

    head.dispatchEvent(new MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    await new Promise((r) => setTimeout(r, 250));
    const labels = [...document.querySelectorAll('#ctxmenu button')].map((b) => b.textContent);
    const item = [...document.querySelectorAll('#ctxmenu button')]
      .find((b) => /Rename group/.test(b.textContent));
    if (!item) return { labels, offered: false };

    item.click();
    await new Promise((r) => setTimeout(r, 400));
    const warned = document.getElementById('dialog-body').textContent;
    const prefilled = document.querySelector('#dialog-body input[type="text"]').value;
    document.querySelector('#dialog-body input[type="text"]').value = 'Holidays';
    [...document.querySelectorAll('#dialog-actions button')]
      .find((b) => /Rename/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 1200));

    const groups = await chrome.tabGroups.query({ windowId });
    const rules = (await chrome.storage.local.get('rules')).rules || [];
    const order = (await chrome.storage.local.get('groupOrder')).groupOrder || [];

    // And the rename must survive the rules running again.
    await chrome.runtime.sendMessage({ type: 'apply-rules', windowId, rules });
    await new Promise((r) => setTimeout(r, 800));
    const settled = (await chrome.tabGroups.query({ windowId })).map((g) => g.title);

    return {
      labels, offered: true, warned, prefilled, order, settled,
      titles: groups.map((g) => g.title),
      ruleNames: rules.map((r) => r.name)
    };
  });
  check(renameGroup.skipped || renameGroup.offered,
    'right-clicking a group offers Rename group', JSON.stringify(renameGroup.labels));
  check(renameGroup.skipped || renameGroup.prefilled === 'Travel',
    'the rename box starts from the current name', renameGroup.prefilled);
  check(renameGroup.skipped || /rule/i.test(renameGroup.warned || ''),
    'renaming says the rule is renamed too', (renameGroup.warned || '').slice(0, 60));
  check(renameGroup.skipped || renameGroup.titles.includes('Holidays'),
    'the group takes the new name', JSON.stringify(renameGroup.titles));
  check(renameGroup.skipped || renameGroup.ruleNames.includes('Holidays'),
    'the rule behind it is renamed to match', JSON.stringify(renameGroup.ruleNames));
  check(renameGroup.skipped || !renameGroup.settled.includes('Travel'),
    'the next rule pass does not rebuild the old group', JSON.stringify(renameGroup.settled));
  check(renameGroup.skipped || renameGroup.order[0] === 't:holidays',
    'the jump-bar position follows the rename', JSON.stringify(renameGroup.order));

  // Put the name back, so the rules-view checks below still describe a rule
  // called Travel — and confirm the rename round-trips.
  const renamedBack = await panel.evaluate(async () => {
    const windowId = (await chrome.windows.getCurrent()).id;
    const rules = (await chrome.storage.local.get('rules')).rules || [];
    rules.forEach((r) => { if (r.name === 'Holidays') r.name = 'Travel'; });
    await chrome.storage.local.set({ rules, groupOrder: ['t:travel', 't:something-else'] });
    for (const g of await chrome.tabGroups.query({ windowId })) {
      if (g.title === 'Holidays') await chrome.tabGroups.update(g.id, { title: 'Travel' });
    }
    await new Promise((r) => setTimeout(r, 700));
    return ((await chrome.storage.local.get('rules')).rules || []).map((r) => r.name);
  });
  check(renamedBack.includes('Travel'), 'rule name restored for the checks that follow',
    JSON.stringify(renamedBack));

  // ------------------------------------------------------------- rules view
  await openManage(panel, 'rules');
  await panel.waitForTimeout(400);
  const ruleCards = await panel.locator('#view-rules .rule-card').count();
  check(ruleCards === 1, 'rules view renders the saved rule', `${ruleCards} cards`);
  const ruleName = await panel.locator('#view-rules .rule-name').first().inputValue();
  check(ruleName === 'Travel', 'rule name is editable and populated', ruleName);
  const swatches = await panel.locator('#view-rules .palette .swatch').count();
  check(swatches === 9, 'colour palette offers all Chrome group colours', `${swatches}`);
  const countText = await panel.locator('#view-rules .rule-count').first().textContent();
  check(/Show the \d+ open tab/.test(countText || '') ||
        /Nothing open matches/.test(countText || ''),
    'rule shows a live match count, phrased as the control it is', countText);

  // Typing in the pattern box must not be interrupted by a background redraw.
  const typing = await panel.evaluate(async () => {
    const ta = document.querySelector('#view-rules .rule-pats');
    ta.focus();
    const node = ta;
    await chrome.tabs.create({ url: 'https://example.com/churn' });
    await new Promise((r) => setTimeout(r, 500));
    return {
      stillFocused: document.activeElement === node,
      sameNode: document.querySelector('#view-rules .rule-pats') === node
    };
  });
  check(typing.stillFocused && typing.sameNode,
    'editing a rule survives tab churn', JSON.stringify(typing));

  // Both actions are on the card, and the space menu lists real spaces (0.14.0).
  const ruleActions = await panel.evaluate(async () => {
    const card = document.querySelector('#view-rules .rule-card');
    const sel = card.querySelector('.ract-sel');
    const gcb = card.querySelector('.ract input[type="checkbox"]');
    const opts = [...sel.options].map((o) => o.value);
    const before = document.querySelector('#view-rules .rule-doing').textContent;

    // Choose a space and check it persists to storage as an action on the rule.
    const target = opts.find((v) => v);
    sel.value = target;
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    const saved = ((await chrome.storage.local.get('rules')).rules || [])[0];
    // One run button, not three (0.21.0). "File open tabs now" and the per-rule
    // "Apply now" both ran an all-rules pass that overlapped almost completely
    // with "Apply to this window"; nothing in the labels distinguished them.
    const runBtns = [...document.querySelectorAll('#view-rules button')]
      .map((b) => b.textContent)
      .filter((t) => /File open tabs|Apply to this window|Apply now|Run rules now/.test(t));

    return {
      hasSelect: !!sel, hasCheckbox: !!gcb, groupOn: gcb.checked,
      firstIsNone: opts[0] === '', optCount: opts.length, target,
      savedSpace: saved && saved.spaceId,
      doing: document.querySelector('#view-rules .rule-doing').textContent,
      before, runBtns
    };
  });
  check(ruleActions.hasSelect && ruleActions.hasCheckbox,
    'a rule card offers both actions — file into a space, and group',
    JSON.stringify(ruleActions));
  check(ruleActions.firstIsNone && ruleActions.optCount >= 2,
    'the space menu leads with "don’t move them" and lists the spaces',
    `${ruleActions.optCount} options`);
  check(ruleActions.savedSpace === ruleActions.target,
    'choosing a space persists as an action on the rule', JSON.stringify(ruleActions));
  check(/moves them to/.test(ruleActions.doing) && /groups them/.test(ruleActions.doing),
    'the card says in words what the rule will do', ruleActions.doing);
  check(/^In plain terms/.test(ruleActions.doing),
    'and that sentence sits under the controls it describes, not three elements below',
    ruleActions.doing);
  check(ruleActions.runBtns.length === 1 && ruleActions.runBtns[0] === 'Run rules now',
    'there is exactly one way to run rules, and it says so',
    JSON.stringify(ruleActions.runBtns));

  // Switching grouping off must leave the rule alive, not delete it.
  const groupOff = await panel.evaluate(async () => {
    const card = document.querySelector('#view-rules .rule-card');
    const gcb = card.querySelector('.ract input[type="checkbox"]');
    gcb.checked = false;
    gcb.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    const saved = ((await chrome.storage.local.get('rules')).rules || [])[0];
    const doing = document.querySelector('#view-rules .rule-doing').textContent;
    // put it back for the checks that follow
    gcb.checked = true;
    gcb.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    return { group: saved && saved.group, spaceId: saved && saved.spaceId, doing };
  });
  check(groupOff.group === false && !!groupOff.spaceId,
    'grouping can be switched off while the filing action stays', JSON.stringify(groupOff));
  check(/moves them to/.test(groupOff.doing) && !/groups them/.test(groupOff.doing),
    'and the summary drops the group clause', groupOff.doing);

  // Clear the filing action again so later grouping checks are unaffected.
  await panel.evaluate(async () => {
    const sel = document.querySelector('#view-rules .rule-card .ract-sel');
    sel.value = '';
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
  });

  await backToBrowse(panel);
  await panel.waitForTimeout(300);

  // ------------------------------------------------- pinned drag reorder
  const pinDrag = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const two = tabs.filter((t) => /^https?:/.test(t.url)).slice(0, 2);
    if (two.length < 2) return { skipped: true };
    for (const t of two) await chrome.tabs.update(t.id, { pinned: true });
    await new Promise((r) => setTimeout(r, 600));

    const chips = [...document.querySelectorAll('.pin-chip')];
    const draggable = chips.every((c) => c.draggable);
    if (chips.length < 2) return { draggable, skipped: true };

    // Simulate the drop: chip[1] dropped onto chip[0]'s slot.
    const before = (await chrome.tabs.query({ currentWindow: true, pinned: true }))
      .sort((a, b) => a.index - b.index).map((t) => t.id);
    const dt = new DataTransfer();
    dt.setData('text/plain', String(before[1]));
    chips[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 700));
    const after = (await chrome.tabs.query({ currentWindow: true, pinned: true }))
      .sort((a, b) => a.index - b.index).map((t) => t.id);
    return { draggable, reordered: before[0] !== after[0], before, after };
  });
  check(pinDrag.draggable !== false, 'pinned chips are draggable');
  check(pinDrag.skipped || pinDrag.reordered,
    'dragging a pinned chip reorders it', JSON.stringify(pinDrag));

  // -------------------------------------------------- page-text reading
  // The reported symptom was single tabs taking >10s. The in-page read is
  // wall-clock bounded, and the extension side has a hard per-tab timeout.
  const heavy = await ctx.newPage();
  await heavy.setContent('<html><body><nav>NAVWORD</nav><div id="root"></div></body></html>');
  await heavy.waitForLoadState('domcontentloaded');
  await heavy.evaluate(() => {
    // ~80k text nodes: a stand-in for a big SPA like a YouTube watch page.
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 80000; i++) {
      const s = document.createElement('span');
      s.textContent = `filler node ${i} lorem ipsum dolor sit amet `;
      frag.appendChild(s);
    }
    // The needle goes FIRST. This page carries ~3.2MB of text and the reader
    // keeps the first 300K characters of a page, so a needle at the end would
    // be testing the cap, not the read. The cap is asserted separately below.
    const needle = document.createElement('p');
    needle.textContent = 'the special MARKERWORD appears here exactly once';
    frag.prepend(needle);
    document.body.appendChild(frag);
  });

  // The page can't import from the extension origin, so inject the source.
  const scanSrc = fs.readFileSync(path.join(EXT, 'common.js'), 'utf8');
  // Slice from PAGE_TEXT to the end, stripping every `export` — other helpers
  // live below it and would otherwise break the Function() wrapper.
  const fnSrc = scanSrc.slice(scanSrc.indexOf('export function PAGE_TEXT'))
    .replace(/^export /gm, '');

  const budgeted = await heavy.evaluate(({ src }) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${src}; return PAGE_TEXT;`)();
    // A zero budget must trip at the first clock check, whatever the machine.
    // (The old test used 40ms and passed or failed with the CPU it ran on.)
    const tight = fn(0);
    const t1 = performance.now();
    const loose = fn(5000);
    const looseMs = performance.now() - t1;
    return {
      tight: { ready: tight.ready, partial: tight.partial, len: (tight.text || '').length },
      loose: { partial: loose.partial, len: loose.text.length,
        hasNeedle: /MARKERWORD/.test(loose.text), hasNav: /NAVWORD/.test(loose.text) },
      looseMs: Math.round(looseMs)
    };
  }, { src: fnSrc });

  check(budgeted.tight.ready === true && budgeted.tight.partial === true,
    'a zero budget returns partial at once rather than walking the whole page',
    JSON.stringify(budgeted.tight));
  check(budgeted.loose.hasNeedle && budgeted.loose.partial === true && budgeted.loose.len <= 300000,
    'an 80k-node page is read up to the 300K-character cap, needle included, and marked partial',
    JSON.stringify(budgeted.loose));
  check(!budgeted.loose.hasNav,
    'and leaves the page chrome out — nav, header, footer, aside', String(budgeted.loose.hasNav));
  check(budgeted.looseMs < 4000,
    'full read of an 80k-node page stays well under the per-tab timeout',
    `${budgeted.looseMs}ms`);

  // A page with no body yet, or still being parsed, is a glance, not a read.
  const glance = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    return {
      noBody: lib.PAGE_TEXT(100, { body: null, readyState: 'complete' }).ready,
      loading: lib.PAGE_TEXT(100, { body: {}, readyState: 'loading' }).ready
    };
  });
  check(glance.noBody === false && glance.loading === false,
    'a document with no body, or still loading, is a glance (ready:false), never an empty read',
    JSON.stringify(glance));

  // Pages that decline to be read say why — and a login BOX is not a login PAGE.
  const declines = await heavy.evaluate(({ src }) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${src}; return PAGE_TEXT;`)();
    const mk = (head, body) => {
      const d = document.implementation.createHTMLDocument('t');
      Object.defineProperty(d, 'readyState', { value: 'complete' });
      d.head.innerHTML = head;
      d.body.innerHTML = body;
      return d;
    };
    const long = 'content '.repeat(400);
    return {
      noindex: fn(400, mk('<meta name="robots" content="noindex, follow">', `<p>${long}</p>`)).skip,
      payment: fn(400, mk('', `<form><input autocomplete="cc-number"></form><p>${long}</p>`)).skip,
      login: fn(400, mk('', '<form><input type="password"></form><p>Sign in</p>')).skip,
      loginBox: fn(400, mk('', `<form><input type="password"></form><article>${long}</article>`)),
      chrome: fn(400, mk('', '<header>HEADWORD</header><nav>NAVWORD</nav><main>BODYWORD</main>' +
        '<aside>ASIDEWORD</aside><footer>FOOTWORD</footer><div aria-hidden="true">HIDDENWORD</div>' +
        '<div role="navigation">ROLEWORD</div>')).text
    };
  }, { src: fnSrc });
  check(declines.noindex === 'noindex' && declines.payment === 'payment' && declines.login === 'login',
    'noindex, payment and login pages decline to be read, and say why',
    JSON.stringify({ noindex: declines.noindex, payment: declines.payment, login: declines.login }));
  check(!declines.loginBox.skip && /content/.test(declines.loginBox.text || ''),
    'a public page with a login box on it is read — the box alone is not a reason',
    JSON.stringify({ skip: declines.loginBox.skip, len: (declines.loginBox.text || '').length }));
  check(declines.chrome === 'BODYWORD',
    'nav, header, footer, aside, aria-hidden and role=navigation are left out', declines.chrome);

  // The wake button says what it does, and no longer pretends to be a filter.
  const wakeLabel = fs.readFileSync(path.join(EXT, 'sidepanel.js'), 'utf8');
  check(/Wake \$\{discarded\.length\} sleeping tab/.test(wakeLabel) && /tabs\.reload\(tabId\)/.test(wakeLabel) &&
        /chrome\.tabs\.discard\(t\.id\)/.test(wakeLabel),
    'reading suspended tabs reloads them and puts them back — it used to inject into a discarded tab, which throws');

  // ------------------------------------------------- the never-read list
  const excl = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const { EXCLUDED_DOMAINS, EXCLUSIONS_META } = await import('./vendor/exclusions.js');
    const set = new Set(EXCLUDED_DOMAINS);
    const entry = { text: 'Alpha MCP beta mcp gamma', lower: 'alpha mcp beta mcp gamma' };
    return {
      count: EXCLUDED_DOMAINS.length, metaCount: EXCLUSIONS_META.count,
      gmail: set.has('mail.google.com'), monzo: set.has('monzo.com'), hsbc: set.has('hsbc.co.uk'),
      slack: set.has('slack.com'), example: set.has('example.com'),
      sub: lib.hostExcluded('online.business.hsbc.co.uk', set),
      www: lib.hostExcluded('www.monzo.com', set),
      lookalike: lib.hostExcluded('hsbc.co.uk.evil.example', set),
      tld: lib.hostExcluded('com', new Set(['com'])),
      hits: lib.searchText(entry, 'MCP'),
      none: lib.searchText(entry, 'zeta').count,
      phrase: lib.searchText(entry, 'beta mcp').count
    };
  });
  check(excl.count > 10000 && excl.metaCount === excl.count,
    'the built-in never-read list ships, and its metadata agrees with it', String(excl.count));
  check(excl.gmail && excl.monzo && excl.hsbc,
    'it knows webmail and UK banks, including the ones UT1 misses');
  check(!excl.slack && !excl.example, 'and leaves team chat and ordinary sites alone');
  check(excl.sub && excl.www, 'a listed domain covers its subdomains and www.');
  check(!excl.lookalike && !excl.tld,
    'a look-alike suffix does not match, and a bare TLD never can');

  // Three gates that are not lists (0.25.0): the address itself, the host's
  // first label, and search-engine results pages.
  const gate = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const s = lib.urlCarriesSecret, h = lib.hostLooksPrivate, q = lib.isSearchResultsPage;
    return {
      password: s('https://abi.example.co.uk/register.aspx?emailAddress=a%40b.c&password=hunter2'),
      token: s('https://insurer.example/api/my-details?Email=a%40b.c&token=' + 'x'.repeat(555)),
      code: s('https://app.example/sso/oauth?code=abc123&state=xyz'),
      fragment: s('https://app.example/cb#access_token=abc&token_type=bearer'),
      jwt: s('https://app.example/p?t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'),
      opaque: s('https://site.example/doc?ozla4bsklvl3amekpaqu6utf5u=' + 'a1B2'.repeat(18)),
      video: s('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'),
      query: s('https://kagi.com/search?q=how+do+tab+groups+work'),
      paged: s('https://shop.example/items?page=2&sort=price&coupon=SAVE10'),
      numeric: s('https://x.example/i/status/1234567890123456789012345678901234567890123456789012'),
      accounts: h('accounts.google.com'), myaccount: h('myaccount.admiral.com'), login: h('login.abi.bcis.co.uk'),
      www: h('www.example.com'), apex: h('login.com'), plain: h('developer.mozilla.org'),
      google: q('https://www.google.co.uk/search?q=siderail&sca_esv=1'), kagi: q('https://kagi.com/search?q=x'),
      ddg: q('https://duckduckgo.com/?q=x&t=h_'), bing: q('https://www.bing.com/search?q=x'),
      yt: q('https://www.youtube.com/results?search_query=x'),
      maps: q('https://www.google.com/maps/place/x'), kagiSettings: q('https://kagi.com/settings'),
      article: q('https://example.com/search-engines-explained')
    };
  });
  check(gate.password && gate.token && gate.code && gate.fragment && gate.jwt && gate.opaque,
    'an address carrying a password, token, OAuth code, fragment token, JWT or long opaque value is never read',
    JSON.stringify(gate));
  check(!gate.video && !gate.query && !gate.paged && !gate.numeric,
    'ordinary addresses — a video id, a search, a paged list, a long number — are not', JSON.stringify(gate));
  check(gate.accounts && gate.myaccount && gate.login && !gate.www && !gate.apex && !gate.plain,
    'a host whose first label is accounts, login or myaccount is private; www., an apex and ordinary hosts are not');
  check(gate.google && gate.kagi && gate.ddg && gate.bing && gate.yt && !gate.maps && !gate.kagiSettings && !gate.article,
    'search results pages are recognised by address, and only those');
  check(excl.hits.count === 2 && /MCP/.test(excl.hits.snippet) && excl.none === 0 && excl.phrase === 1,
    'searchText counts case-insensitively, phrase-matches, and cuts a snippet',
    JSON.stringify(excl.hits));

  // The user's own list lives in Settings and persists.
  const never = await panel.evaluate(async () => {
    __goManage('settings');
    await new Promise((r) => setTimeout(r, 500));
    const ta = document.querySelector('#view-settings .excl-list');
    const cb = [...document.querySelectorAll('#view-settings input[type=checkbox]')]
      .find((c) => (c.closest('.set-row')?.textContent || '').includes('Built-in list'));
    if (!ta) return { missing: true };
    ta.value = 'intranet.example.com\ntitle:Payslip';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const saved = ((await chrome.storage.local.get('settings')).settings || {}).excludeUser;
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    __goBrowse();
    return { hasBuiltinToggle: !!cb, builtinOn: !!(cb && cb.checked), saved };
  });
  check(!never.missing && never.hasBuiltinToggle && never.builtinOn,
    'Settings has the never-read card, with the built-in list on by default',
    JSON.stringify(never));
  check(JSON.stringify(never.saved) === JSON.stringify(['intranet.example.com', 'title:Payslip']),
    'and your own sites persist, one per line', JSON.stringify(never.saved));

  // A space can be marked Private from its card.
  const priv = await panel.evaluate(async () => {
    const saved = (await chrome.storage.local.get('spaces')).spaces || [];
    await chrome.storage.local.set({
      spaces: [...saved, { id: 'priv', name: 'Vault', emoji: '🔒', manifest: [] }]
    });
    await new Promise((r) => setTimeout(r, 600));
    __goManage('spaces');
    await new Promise((r) => setTimeout(r, 500));
    const card = document.querySelector('.space-card[data-id="priv"]');
    const btn = card && [...card.querySelectorAll('.card-actions button')]
      .find((b) => /^Private/.test(b.textContent));
    if (!btn) return { missing: true };
    btn.click();
    await new Promise((r) => setTimeout(r, 700));
    const after = ((await chrome.storage.local.get('spaces')).spaces || []).find((s) => s.id === 'priv');
    const badge = !!document.querySelector('.space-card[data-id="priv"] .badge.is-private');
    await chrome.storage.local.set({ spaces: saved });
    await new Promise((r) => setTimeout(r, 400));
    __goBrowse();
    return { private: !!(after && after.private), badge };
  });
  check(!priv.missing && priv.private && priv.badge,
    'a space marked Private persists the flag and shows it on the card', JSON.stringify(priv));

  // ------------------------------------------------- the on-disk index (0.23.0)
  const red = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    return {
      card: lib.redact('pay with 4111 1111 1111 1111 today'),
      cardDash: lib.redact('card 4012-8888-8888-1881 ok'),
      notCard: lib.redact('order 1234 5678 9012 3456 shipped'),   // fails Luhn
      iban: lib.redact('send to GB29 NWBK 6016 1331 9268 19 please'),
      sort: lib.redact('sort code 12-34-56 account 12345678 thanks'),
      phone: lib.redact('call 07700 900123 or 020 7946 0958'),
      year: lib.redact('in 2026 the 1,000,000th visitor'),
      hash: lib.textHash('abc') === lib.textHash('abc') && lib.textHash('abc') !== lib.textHash('abd')
    };
  });
  check(/\[card redacted\] today/.test(red.card) && /\[card redacted\] ok/.test(red.cardDash),
    'a Luhn-valid card number is redacted, with spaces or dashes', JSON.stringify([red.card, red.cardDash]));
  check(/1234 5678 9012 3456/.test(red.notCard),
    'a 16-digit number that fails Luhn is left alone', red.notCard);
  check(/\[iban redacted\]/.test(red.iban) && /\[account redacted\]/.test(red.sort),
    'IBANs and sort-code-and-account pairs are redacted', JSON.stringify([red.iban, red.sort]));
  check(/07700 900123/.test(red.phone) && /2026/.test(red.year) && /1,000,000/.test(red.year),
    'phone numbers, years and ordinary figures survive', JSON.stringify([red.phone, red.year]));
  check(red.hash, 'textHash is stable and discriminating');

  const red2 = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    return {
      ni: lib.redact('NI number AB 12 34 56 C on file'),
      niTight: lib.redact('ref AB123456A ok'),
      ssn: lib.redact('SSN 123-45-6789 here'),
      phone: lib.redact('call 555-123-4567 or 020 7946 0958'),
      order: lib.redact('order no. 12-34-5678 shipped'),
      word: lib.redact('the QUICK 12 34 56 brown fox')
    };
  });
  check(/\[ni redacted\] on file/.test(red2.ni) && /\[ni redacted\] ok/.test(red2.niTight) && /\[ssn redacted\] here/.test(red2.ssn),
    'National Insurance and Social Security numbers are redacted', JSON.stringify(red2));
  check(/555-123-4567/.test(red2.phone) && /12-34-5678/.test(red2.order) && /QUICK 12 34 56/.test(red2.word),
    'a 3-3-4 phone number, an order number and ordinary words with digits survive', JSON.stringify(red2));

  // ------------------------------------------------- nothing is stored (0.26.0)
  //
  // 0.23–0.25 kept read pages in IndexedDB so a closed page could be found
  // again. That is gone: a search reads open tabs into the panel's memory and
  // nothing else, and the old database is deleted the first time 0.26 runs.
  const gone = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const names = async () => (await indexedDB.databases()).map((d) => d.name);
    const before = await names();
    await new Promise((res) => {
      const r = indexedDB.open('siderail-index', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pages');
      r.onsuccess = () => { r.result.close(); res(); };
      r.onerror = () => res();
    });
    const planted = (await names()).includes('siderail-index');
    const removed = await lib.removeOldIndexStore();
    const after = await names();
    await chrome.storage.local.set({ settings: { ...((await chrome.storage.local.get('settings')).settings || {}), indexKeepDays: 7, indexPaused: true } });
    __goManage('settings');
    await new Promise((r) => setTimeout(r, 400));
    const labels = [...document.querySelectorAll('#view-settings .set-row label')].map((l) => l.firstChild.textContent);
    const cards = [...document.querySelectorAll('#view-settings .card-name')].map((n) => n.textContent.trim());
    const nums = document.querySelectorAll('#view-settings input.num').length;
    __goBrowse();
    const localDump = JSON.stringify(await chrome.storage.local.get(null));
    return { before, planted, removed, after, labels, cards, nums, markerInLocal: /MARKERWORD/.test(localDump),
      exports: Object.keys(lib).filter((k) => /^index/i.test(k) || /^tokenise$/.test(k)) };
  });
  check(!gone.markerInLocal, 'text read from a page never reaches chrome.storage.local, so Export never carries it');
  check(!gone.before.includes('siderail-index'), 'the panel creates no IndexedDB database', JSON.stringify(gone.before));
  check(gone.planted && gone.removed && !gone.after.includes('siderail-index'),
    'a database left behind by 0.23–0.25 is deleted by removeOldIndexStore', JSON.stringify({ planted: gone.planted, after: gone.after }));
  check(!gone.cards.includes('What has been read') && gone.nums === 0 &&
        !gone.labels.some((l) => /Read pages as I browse|Pause reading|Keep for|Keep at most/.test(l)),
    'Settings offers no retention, as-you-browse or pause controls', JSON.stringify(gone.cards));
  check(gone.exports.length === 0, 'common.js exports no index-store functions', JSON.stringify(gone.exports));
  check(!fs.existsSync(path.join(EXT, 'index-worker.js')), 'index-worker.js is gone');
  // The retention settings a 0.25 profile carries are dropped the next time a
  // panel boots. A second panel page, so the one the rest of the suite drives
  // keeps its state.
  const bootPage = await ctx.newPage();
  await bootPage.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  await bootPage.waitForTimeout(1500);
  const settingsNow = await bootPage.evaluate(async () => (await chrome.storage.local.get('settings')).settings || {});
  const dbsNow = await bootPage.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  await bootPage.close();
  check(!('indexKeepDays' in settingsNow) && !('indexPaused' in settingsNow),
    'old retention settings are removed from the settings record on boot', JSON.stringify(Object.keys(settingsNow)));
  check(!dbsNow.includes('siderail-index'), 'and a booting panel still creates no database', JSON.stringify(dbsNow));

  // The zip is built from an allow-list, so what ships can be asserted.
  const pkg = (() => {
    const cp = require('child_process');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'srpkg-'));
    try {
      cp.execFileSync('node', [path.join(EXT, 'tools', 'package.mjs'), '--out', out, '--store'], { stdio: 'pipe' });
      cp.execFileSync('node', [path.join(EXT, 'tools', 'package.mjs'), '--out', out], { stdio: 'pipe' });
      const zips = fs.readdirSync(out).filter((f) => f.endsWith('.zip')).sort();
      const list = (z) => cp.execFileSync('unzip', ['-Z1', path.join(out, z)], { encoding: 'utf8' }).trim().split('\n');
      const store = zips.find((z) => /-store\.zip$/.test(z));
      const plain = zips.find((z) => !/-store\.zip$/.test(z));
      const storeManifest = JSON.parse(cp.execFileSync('unzip', ['-p', path.join(out, store), 'manifest.json'], { encoding: 'utf8' }));
      return { storeEntries: list(store), plainEntries: list(plain), storeManifest, plain };
    } catch (e) {
      return { error: String(e.stderr || e).trim() };
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  })();
  const zipNames = pkg.storeEntries || [];
  const inZip = (n) => zipNames.includes(n);
  check(!pkg.error && inZip('manifest.json') && inZip('LICENSE') && inZip('NOTICE') && inZip('PRIVACY.md') &&
    inZip('THIRD-PARTY-NOTICES.md') && !inZip('index-worker.js') && inZip('vendor/exclusions.js') && inZip('icons/icon128.png'),
    'the package carries the code, the licences and the privacy note',
    pkg.error || zipNames.filter((n) => !n.includes('/')).join(' '));
  check(!pkg.error && !zipNames.some((n) => /^(HANDOVER\.md|STORE-READINESS\.md|SECURITY\.md|package\.json|package-lock\.json)$|^(test|tools|node_modules|\.git|\.github|dist)\/|\/\./.test(n)),
    'and nothing else: no handover, no tests, no tooling, no dotfiles',
    zipNames.filter((n) => /HANDOVER|STORE-READ|test\/|tools\/|\/\./.test(n)).join(' '));
  check(!pkg.error && pkg.storeManifest && !('key' in pkg.storeManifest) &&
    pkg.storeManifest.version === JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8')).version,
    'the store build drops the manifest key and its version matches package.json');
  check(!pkg.error && pkg.plainEntries.every((n) => n.startsWith(`SideRail-${pkg.storeManifest.version}/`)),
    'the unpacked build unzips into one folder to point Chrome at', (pkg.plainEntries || []).slice(0, 2).join(' '));

  await heavy.close();

  // ------------------------------------------------------------ defuddle
  const defuddleMeta = JSON.parse(
    fs.readFileSync(path.join(EXT, 'vendor', 'defuddle-version.json'), 'utf8'));
  check(!!defuddleMeta.version, 'Defuddle is vendored with a recorded version', defuddleMeta.version);
  check(fs.existsSync(path.join(EXT, 'vendor', 'defuddle.js')), 'Defuddle bundle ships in the package');

  // Prove the vendored bundle actually extracts an article, in a real page.
  const article = await ctx.newPage();
  await article.setContent(`<html><head><title>Test Article</title></head><body>
    <nav>NAVIGATION JUNK</nav><aside>SIDEBAR ADVERT</aside>
    <article><h1>The Real Headline</h1>
    <p>${'Genuine body prose that the extractor should keep hold of entirely. '.repeat(14)}</p>
    <p>${'A second substantial paragraph of real article content for scoring. '.repeat(14)}</p>
    </article><footer>FOOTER JUNK</footer></body></html>`);
  await article.addScriptTag({ path: path.join(EXT, 'vendor', 'defuddle.js') });
  const extracted = await article.evaluate(() => {
    const Cls = window.Defuddle && (window.Defuddle.Defuddle || window.Defuddle.default || window.Defuddle);
    const r = new Cls(document).parse();
    return {
      title: r.title, words: r.wordCount,
      keptBody: /Genuine body prose/.test(r.content || ''),
      droppedNav: !/NAVIGATION JUNK/.test(r.content || ''),
      droppedFooter: !/FOOTER JUNK/.test(r.content || '')
    };
  });
  check(extracted.keptBody && extracted.droppedNav && extracted.droppedFooter,
    'Defuddle keeps the article and drops the chrome', JSON.stringify(extracted));

  await article.close();

  // ------------------------------------------------------------ archive.is
  const archiveUrl = await panel.evaluate(() => {
    const u = 'https://www.example.com/some/article?x=1';
    return `https://archive.is/${u}`;
  });
  check(archiveUrl === 'https://archive.is/https://www.example.com/some/article?x=1',
    'archive.is URL is built by prefixing the full URL', archiveUrl);

  // Both page actions live on the footer now, not behind a menu.
  //
  // The panel is a real tab in this harness (it is not in a real side panel),
  // so it can itself be the active tab, and the counts settle a beat after a
  // tab event. Both checks therefore drive the state they need and then wait
  // for the panel to agree, rather than sampling once and hoping.
  const footBar = await panel.evaluate(async () => {
    const web = (await chrome.tabs.query({ currentWindow: true }))
      .find((t) => /^https?:/i.test(t.url || ''));
    if (web) await chrome.tabs.update(web.id, { active: true });

    let disabled = true;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      disabled = document.getElementById('act-defuddle').disabled;
      if (!disabled) break;
    }
    return {
      labels: [...document.querySelectorAll('#foot .foot-btn')]
        .filter((b) => !b.hidden)
        .map((b) => b.querySelector('.foot-label').textContent.replace(/ \(\d+\)$/, '')),
      noMenuButton: !document.getElementById('act-page'),
      defuddleDisabled: disabled,
      archiveDisabled: document.getElementById('act-archive').disabled,
      activeUrl: web ? web.url : ''
    };
  });
  check(footBar.labels.includes('Defuddle') && footBar.labels.includes('archive.is'),
    'Defuddle and archive.is are buttons on the footer', JSON.stringify(footBar.labels));
  check(footBar.noMenuButton, 'the page-actions ⋯ menu is gone');
  check(!footBar.defuddleDisabled && !footBar.archiveDisabled,
    'both are live when a web page is in front of them', footBar.activeUrl);

  // ...and go dead when it is a page they cannot touch.
  const footDead = await panel.evaluate(async () => {
    const blank = await chrome.tabs.create({ url: 'chrome://version', active: true });
    let disabled = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      disabled = document.getElementById('act-defuddle').disabled;
      if (disabled) break;
    }
    await chrome.tabs.remove(blank.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    return { disabled };
  });
  check(footDead.disabled, 'both go dead on a page they cannot touch');

  // The count moved into the search field when the nav row went, but it still
  // has to track the window.
  const tabCount = await panel.evaluate(async () => {
    let shown = '';
    let real = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      shown = document.getElementById('tab-count').textContent;
      real = (await chrome.tabs.query({ currentWindow: true })).length;
      if (shown === String(real)) break;
    }
    const el = document.getElementById('tab-count');
    const box = el.getBoundingClientRect();
    const field = document.getElementById('search').getBoundingClientRect();
    return {
      shown, real,
      inside: box.right <= field.right + 1 && box.left >= field.left,
      visible: !el.hidden
    };
  });
  check(tabCount.shown === String(tabCount.real) && tabCount.visible,
    'the live tab count is shown while browsing',
    `${tabCount.shown} vs ${tabCount.real} open`);
  check(tabCount.inside,
    'and it sits inside the search field rather than overhanging it',
    JSON.stringify(tabCount));

  // ------------------------------------------------------- backup round-trip
  const backup = await panel.evaluate(async () => {
    const lib = await import('./sidepanel.js').catch(() => null);
    return null;
  }).catch(() => null);

  const roundTrip = await panel.evaluate(async () => {
    // Seed something identifiable, snapshot it, wipe it, restore it.
    await chrome.storage.local.set({
      workspaces: [{ id: 'w1', name: 'Backup probe', createdAt: 1, updatedAt: 1, tabs: [], groups: [] }],
      rules: [{ id: 'r1', name: 'Probe', color: 'red', enabled: true, patterns: ['probe.example'] }],
      groupOrder: ['t:probe']
    });
    const dump = await chrome.storage.local.get(null);

    // A RAW storage dump — the shape the console snippet produces on the old build.
    const raw = JSON.parse(JSON.stringify(dump));
    // And the wrapped shape this build exports.
    const wrapped = { app: 'SideRail', version: '0.6.0', exportedAt: 'x', data: raw };

    await chrome.storage.local.remove(['workspaces', 'rules', 'groupOrder']);
    const emptied = await chrome.storage.local.get(['workspaces', 'rules', 'groupOrder']);

    // Restore from the wrapped form.
    await chrome.storage.local.set(wrapped.data);
    const afterWrapped = await chrome.storage.local.get(['workspaces', 'rules', 'groupOrder']);

    await chrome.storage.local.remove(['workspaces', 'rules', 'groupOrder']);
    // Restore from the raw form.
    await chrome.storage.local.set(raw);
    const afterRaw = await chrome.storage.local.get(['workspaces', 'rules', 'groupOrder']);

    return {
      emptied: Object.keys(emptied).length,
      wrappedName: afterWrapped.workspaces && afterWrapped.workspaces[0] && afterWrapped.workspaces[0].name,
      rawName: afterRaw.workspaces && afterRaw.workspaces[0] && afterRaw.workspaces[0].name,
      rawRule: afterRaw.rules && afterRaw.rules[0] && afterRaw.rules[0].name,
      order: (afterRaw.groupOrder || []).join(',')
    };
  });
  check(roundTrip.emptied === 0, 'storage really was cleared before restore');
  check(roundTrip.wrappedName === 'Backup probe',
    'restore works from an exported (wrapped) backup', String(roundTrip.wrappedName));
  check(roundTrip.rawName === 'Backup probe' && roundTrip.rawRule === 'Probe' &&
        roundTrip.order === 't:probe',
    'restore works from a raw console dump (old-build format)', JSON.stringify(roundTrip));

  // The Export / Import controls must be reachable. They moved out of Rules —
  // where they sat under the pattern-syntax help — into Settings, under "Your
  // data" (0.21.0).
  await openManage(panel, 'settings');
  await panel.waitForTimeout(400);
  const dataBtns = await panel.evaluate(() =>
    [...document.querySelectorAll('#view-settings .data-row button')].map((b) => b.textContent));
  check(dataBtns.includes('Export data') && dataBtns.includes('Import data'),
    'Settings offers Export and Import', JSON.stringify(dataBtns));
  const notInRules = await panel.evaluate(async () => {
    __goManage('rules');
    await new Promise((r) => setTimeout(r, 400));
    return document.querySelectorAll('#view-rules .data-row').length;
  });
  check(notInRules === 0, 'and Rules no longer carries them', String(notInRules));
  const menuData = await panel.evaluate(async () => {
    __goBrowse();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById('gmenu').click();
    await new Promise((r) => setTimeout(r, 200));
    const labels = [...document.querySelectorAll('#ctxmenu button')].map((b) => b.textContent);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return labels;
  });
  check(menuData.includes('Export data…') && menuData.includes('Import data…'),
    'overflow menu offers Export and Import', JSON.stringify(menuData));

  // ------------------------------------------------------------ hover card
  const hover = await panel.evaluate(async () => {
    const row = document.querySelector('#view-tabs .tab-row[data-id]');
    const pop = document.getElementById('tabpop');
    const id = Number(row.dataset.id);

    // Seed a thumbnail the way the service worker would.
    const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    await chrome.storage.session.set({ [`thumb:${id}`]: { d: px, at: Date.now(), url: 'x' } });

    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 200));
    const earlyHidden = pop.hidden;              // must not flash instantly
    await new Promise((r) => setTimeout(r, 500));

    const shown = !pop.hidden;
    const box = pop.getBoundingClientRect();
    const out = {
      earlyHidden,
      shown,
      hasImage: !!pop.querySelector('img.shot'),
      title: pop.querySelector('.pop-title')?.textContent || '',
      host: pop.querySelector('.pop-host span:last-child')?.textContent || '',
      chips: [...pop.querySelectorAll('.chip')].map((c) => c.textContent),
      onScreen: box.left >= 0 && box.top >= 0 &&
                box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
      ignoresPointer: getComputedStyle(pop).pointerEvents === 'none'
    };

    row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 120));
    out.hiddenAfterLeave = pop.hidden;
    await chrome.storage.session.remove(`thumb:${id}`);
    return out;
  });

  check(hover.earlyHidden, 'hover card waits rather than flashing on a passing cursor');
  check(hover.shown && hover.hasImage, 'hover card shows the cached thumbnail', JSON.stringify(hover.hasImage));
  check(hover.title.length > 0 && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hover.host),
    'hover card shows full title and domain', `"${hover.title.slice(0, 28)}" / ${hover.host}`);
  check(hover.onScreen, 'hover card is clamped on screen');
  check(hover.ignoresPointer, 'hover card does not steal the pointer');
  check(hover.hiddenAfterLeave, 'hover card hides on mouseleave');

  // Fallback when nothing has been captured for that tab yet.
  const noShot = await panel.evaluate(async () => {
    const rows = [...document.querySelectorAll('#view-tabs .tab-row[data-id]')];
    const row = rows[rows.length - 1];
    await chrome.storage.session.remove(`thumb:${row.dataset.id}`);
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 700));
    const pop = document.getElementById('tabpop');
    const out = { shown: !pop.hidden, placeholder: !!pop.querySelector('.shot-none'),
                  text: pop.querySelector('.shot-none')?.textContent || '' };
    row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    return out;
  });
  check(noShot.shown && noShot.placeholder,
    'hover card explains itself when no thumbnail exists yet', noShot.text.slice(0, 50));

  // ------------------------------------------------- thumbnail cache tidying
  const tidy = await panel.evaluate(async () => {
    const live = await chrome.tabs.query({});
    const liveId = live[0].id;

    // One live tab, plus 3 orphans whose tabs no longer exist.
    const seed = { [`thumb:${liveId}`]: { d: 'x', at: Date.now() } };
    for (const ghost of [900001, 900002, 900003]) {
      seed[`thumb:${ghost}`] = { d: 'x', at: Date.now() - 60000 };
    }
    await chrome.storage.session.set(seed);
    const before = Object.keys(await chrome.storage.session.get(null))
      .filter((k) => k.startsWith('thumb:')).length;

    const res = await chrome.runtime.sendMessage({ type: 'tidy-thumbs' });
    const after = Object.keys(await chrome.storage.session.get(null))
      .filter((k) => k.startsWith('thumb:'));

    return {
      before,
      afterCount: after.length,
      orphansGone: !after.some((k) => k.startsWith('thumb:9000')),
      liveKept: after.includes(`thumb:${liveId}`),
      reported: res && res.removed
    };
  });
  check(tidy.before === 4 && tidy.afterCount === 1,
    'tidy drops thumbnails whose tabs are gone', JSON.stringify(tidy));
  check(tidy.orphansGone && tidy.liveKept,
    'orphans removed, the live tab’s thumbnail kept');

  // Overwriting must not accumulate: one record per tab, always.
  const overwrite = await panel.evaluate(async () => {
    const id = (await chrome.tabs.query({}))[0].id;
    for (let i = 0; i < 5; i++) {
      await chrome.storage.session.set({ [`thumb:${id}`]: { d: `v${i}`, at: Date.now() + i } });
    }
    const keys = Object.keys(await chrome.storage.session.get(null))
      .filter((k) => k === `thumb:${id}`);
    const rec = (await chrome.storage.session.get(`thumb:${id}`))[`thumb:${id}`];
    await chrome.storage.session.remove(`thumb:${id}`);
    return { keys: keys.length, value: rec.d };
  });
  check(overwrite.keys === 1 && overwrite.value === 'v4',
    'repeated captures overwrite in place rather than accumulating', JSON.stringify(overwrite));

  // A tab closing must take its thumbnail with it.
  const onClose = await panel.evaluate(async () => {
    const t = await chrome.tabs.create({ url: 'https://example.net/thumbtest', active: false });
    await chrome.storage.session.set({ [`thumb:${t.id}`]: { d: 'x', at: Date.now() } });
    await chrome.tabs.remove(t.id);
    await new Promise((r) => setTimeout(r, 500));
    const still = (await chrome.storage.session.get(`thumb:${t.id}`))[`thumb:${t.id}`];
    return { cleared: !still };
  });
  check(onClose.cleared, 'closing a tab removes its cached thumbnail');

  // Navigating invalidates the old picture.
  const onNav = await panel.evaluate(async () => {
    const t = await chrome.tabs.create({ url: 'https://example.net/one', active: false });
    await new Promise((r) => setTimeout(r, 800));
    await chrome.storage.session.set({ [`thumb:${t.id}`]: { d: 'stale', at: Date.now() } });
    await chrome.tabs.update(t.id, { url: 'https://example.net/two' });
    await new Promise((r) => setTimeout(r, 1200));
    const rec = (await chrome.storage.session.get(`thumb:${t.id}`))[`thumb:${t.id}`];
    await chrome.tabs.remove(t.id).catch(() => {});
    return { cleared: !rec || rec.d !== 'stale' };
  });
  check(onNav.cleared, 'navigating away invalidates the cached thumbnail');

  // ------------------------------------------------- recovering pinned tabs
  // Snapshots record pinned state, so a lost pinned tab is recoverable without
  // dragging the whole snapshot back.
  const repin = await panel.evaluate(async () => {
    const windowId = (await chrome.windows.getCurrent()).id;
    const snap = {
      id: 'snapPin', at: Date.now(), reason: 'manual', sig: 'pin-test',
      windows: [{
        tabs: [
          { url: 'https://example.com/pinned-a', title: 'pa', pinned: true, muted: false, groupKey: null },
          { url: 'https://example.com/pinned-b', title: 'pb', pinned: true, muted: false, groupKey: null },
          { url: 'https://example.com/loose-1', title: 'l1', pinned: false, muted: false, groupKey: null }
        ],
        groups: []
      }],
      tabCount: 3
    };
    await chrome.storage.local.set({ snapshots: [snap] });
    await new Promise((r) => setTimeout(r, 500));

    __goManage('rewind');
    await new Promise((r) => setTimeout(r, 400));

    const labels = [...document.querySelectorAll('#view-rewind .card-actions button')]
      .map((b) => b.textContent);
    const btn = [...document.querySelectorAll('#view-rewind .card-actions button')]
      .find((b) => /Re-pin/.test(b.textContent));
    if (!btn) return { labels, offered: false };

    const winsBefore = (await chrome.windows.getAll()).length;
    btn.click();
    await new Promise((r) => setTimeout(r, 3000));
    const here = await chrome.tabs.query({ windowId });
    const pinnedNow = here.filter((t) => t.pinned).map((t) => t.url).sort();

    // A second press must not double them up.
    btn.click();
    await new Promise((r) => setTimeout(r, 2500));
    const after = (await chrome.tabs.query({ windowId })).filter((t) => t.pinned).length;

    for (const t of here.filter((x) => /pinned-[ab]/.test(x.url || ''))) {
      await chrome.tabs.remove(t.id).catch(() => {});
    }
    return {
      labels, offered: true, pinnedNow, after,
      winsSame: (await chrome.windows.getAll()).length === winsBefore,
      loose: here.some((t) => /loose-1/.test(t.url || ''))
    };
  });
  check(repin.offered, 'a snapshot holding pinned tabs offers to re-pin them',
    JSON.stringify(repin.labels));
  check(repin.pinnedNow.filter((u) => /pinned-[ab]/.test(u)).length === 2,
    'both pinned tabs come back pinned', JSON.stringify(repin.pinnedNow));
  check(!repin.loose, 'only the pinned tabs are restored, not the whole snapshot');
  check(repin.winsSame, 're-pinning opens no new window');
  check(repin.after === repin.pinnedNow.length,
    'pressing it twice does not duplicate them', `${repin.pinnedNow.length} → ${repin.after}`);

  await backToBrowse(panel);
  await panel.waitForTimeout(300);

  // ------------------------------------- rebuilding membership on restart
  // Tab ids do not survive a browser restart and Chromium has no
  // sessions.setTabValue, so membership is rebuilt by matching each space's
  // saved URL list against the order the browser restored tabs in. This is the
  // single most load-bearing function in the feature: get it wrong and the
  // answer to "where did my tabs go" is "nowhere good".
  const restart = await panel.evaluate(async () => {
    const { assignSpaces, UNSORTED } = await import('./common.js');
    const spaces = [
      { id: 'work', manifest: [{ url: 'https://a.example/1' }, { url: 'https://shared.example/x' }] },
      { id: 'play', manifest: [{ url: 'https://b.example/2' }, { url: 'https://shared.example/x' }] }
    ];

    // Restored in strip order, ids all brand new.
    const plain = assignSpaces([
      { id: 101, url: 'https://a.example/1' },
      { id: 102, url: 'https://b.example/2' },
      { id: 103, url: 'https://nobody.example/z' }
    ], spaces);

    // A URL both spaces claim goes to the space of the tab before it — runs of
    // tabs from one space stay together, which is what a restored window is.
    const ambiguousAfterWork = assignSpaces([
      { id: 201, url: 'https://a.example/1' },
      { id: 202, url: 'https://shared.example/x' }
    ], spaces);
    const ambiguousAfterPlay = assignSpaces([
      { id: 301, url: 'https://b.example/2' },
      { id: 302, url: 'https://shared.example/x' }
    ], spaces);

    // Tracking parameters must not stop a match — the URL moved on, the page didn't.
    const tracked = assignSpaces(
      [{ id: 401, url: 'https://a.example/1?utm_source=news' }], spaces);

    // Pinned tabs carry a space like any other tab, but they sit in their own
    // run at the head of the strip, so they must not seed the continuity rule.
    const pinnedFirst = assignSpaces([
      { id: 501, url: 'https://b.example/2', pinned: true },
      { id: 502, url: 'https://shared.example/x' }
    ], spaces);

    const empty = assignSpaces([], spaces);
    const noSpaces = assignSpaces([{ id: 601, url: 'https://a.example/1' }], []);

    return {
      plain: plain.byTab, plainUnsorted: plain.unsorted, plainMatched: plain.matched,
      afterWork: ambiguousAfterWork.byTab[202],
      afterPlay: ambiguousAfterPlay.byTab[302],
      tracked: tracked.byTab[401],
      pinnedRun: pinnedFirst.byTab[502],
      empty: Object.keys(empty.byTab).length,
      noSpaces: noSpaces.byTab[601],
      UNSORTED
    };
  });

  check(restart.plain[101] === 'work' && restart.plain[102] === 'play',
    'a URL only one space claims goes to that space', JSON.stringify(restart.plain));
  check(restart.plain[103] === restart.UNSORTED && restart.plainUnsorted === 1,
    'an unclaimed tab goes to Unsorted, never nowhere', JSON.stringify(restart.plain));
  check(restart.plainMatched === 2, 'the matched count is reported', String(restart.plainMatched));
  check(restart.afterWork === 'work' && restart.afterPlay === 'play',
    'a URL two spaces claim follows the tab before it',
    `${restart.afterWork} / ${restart.afterPlay}`);
  check(restart.tracked === 'work',
    'a tracking parameter picked up since the save still matches', restart.tracked);
  // 501 is pinned and matches Play, but must not make 502 — claimed by both —
  // follow it. With no unpinned tab before it, 502 falls to the first claimant.
  check(restart.pinnedRun === 'work',
    'a pinned tab does not seed the continuity rule for the tabs after it',
    restart.pinnedRun);
  check(restart.empty === 0, 'no tabs means no assignments');
  check(restart.noSpaces === restart.UNSORTED,
    'with no spaces defined everything is Unsorted, not lost');

  // --------------------------------------- the restart path, end to end
  // Clearing storage.session is exactly what a browser restart does to us: tab
  // ids are new, membership is gone, only the manifests survive. Reload the
  // panel against live tabs and it must put everything back.
  const restartLive = await panel.evaluate(async () => {
    const { makeLiveSpace } = await import('./common.js');
    const wid = (await chrome.windows.getCurrent()).id;
    const tabs = (await chrome.tabs.query({ windowId: wid, pinned: false }))
      .filter((t) => /^https?:/i.test(t.url || ''));
    if (tabs.length < 3) return { skipped: true };

    const alpha = makeLiveSpace({ name: 'Alpha', emoji: '🅰️' });
    const beta = makeLiveSpace({ name: 'Beta', emoji: '🅱️' });
    // Manifests naming real, currently-open URLs — as a live session would have
    // written moments before the browser closed.
    alpha.manifest = tabs.slice(0, 2).map((t) => ({ url: t.url, title: t.title || '' }));
    beta.manifest = tabs.slice(2, 3).map((t) => ({ url: t.url, title: t.title || '' }));
    await chrome.storage.local.set({ spaces: [alpha, beta] });

    // The restart itself. Membership is one key per tab now, so removing the
    // old single key would leave every placement standing and the panel would
    // take the same-session path instead of rebuilding from the manifests.
    await __clearMembership();
    await new Promise((r) => setTimeout(r, 400));
    return {
      alpha: alpha.id, beta: beta.id,
      wantAlpha: tabs.slice(0, 2).map((t) => t.id),
      wantBeta: tabs.slice(2, 3).map((t) => t.id)
    };
  });

  if (restartLive.skipped) {
    ok('restart rebuild skipped (too few tabs)');
  } else {
    await panel.reload({ waitUntil: 'load' });
    await panel.waitForTimeout(2500);

    const rebuilt = await panel.evaluate(async () => {
      const spaceOf = await __readSpaceOf();
      return {
        spaceOf,
        chips: [...document.querySelectorAll('.space-bar .schip .nm')].map((n) => n.textContent)
      };
    });
    const got = (ids) => ids.map((id) => rebuilt.spaceOf[id]);
    check(got(restartLive.wantAlpha).every((v) => v === restartLive.alpha),
      'after a restart, tabs are matched back to their space by URL',
      JSON.stringify(got(restartLive.wantAlpha)));
    check(got(restartLive.wantBeta).every((v) => v === restartLive.beta),
      'and the second space is rebuilt too', JSON.stringify(got(restartLive.wantBeta)));
    check(rebuilt.chips[0] === 'Main',
      'Main is always the first space in the bar', JSON.stringify(rebuilt.chips));
    check(Object.values(rebuilt.spaceOf).some((v) => v === 'unsorted'),
      'tabs no space claims land in Main rather than vanishing');
  }

  // ------------------------------------------ one group per (rule, space)
  // A tab belongs to exactly one native group, so a shared "Travel" group would
  // put every space's Travel tabs in one collapsible unit with one shared
  // collapse state. Two groups may carry the same title — group identity is an
  // opaque token — so each space gets its own.
  const perSpace = await panel.evaluate(async () => {
    const { planRuleGroups } = await import('./common.js');
    const rules = [{ id: 'r1', name: 'Travel', color: 'green', enabled: true,
      patterns: ['travel.example'] }];
    const tabs = [
      { id: 1, url: 'https://travel.example/a', groupId: -1 },
      { id: 2, url: 'https://travel.example/b', groupId: -1 },
      { id: 3, url: 'https://other.example/c', groupId: -1 }
    ];
    const spaceOf = { 1: 'work', 2: 'play', 3: 'work' };
    const plan = planRuleGroups(tabs, rules, spaceOf, []);

    // Once they exist, a matching tab already in the right group is left alone,
    // and one in the WRONG space's group is moved out.
    const groups = [{ id: 11, title: 'Travel', color: 'green' },
                    { id: 12, title: 'Travel', color: 'green' }];
    const settled = planRuleGroups(
      [{ id: 1, url: 'https://travel.example/a', groupId: 11 },
       { id: 2, url: 'https://travel.example/b', groupId: 12 }],
      rules, spaceOf, groups);
    const strayed = planRuleGroups(
      [{ id: 1, url: 'https://travel.example/a', groupId: 11 },
       { id: 2, url: 'https://travel.example/b', groupId: 11 }],
      rules, { 1: 'work', 2: 'play' }, [{ id: 11, title: 'Travel', color: 'green' }]);

    // A group the user made by hand is never raided.
    const manual = planRuleGroups(
      [{ id: 1, url: 'https://travel.example/a', groupId: 99 }],
      rules, spaceOf, [{ id: 99, title: 'My own group', color: 'pink' }]);

    return {
      count: plan.length,
      spaces: plan.map((p) => p.spaceId).sort(),
      names: [...new Set(plan.map((p) => p.ruleName))],
      tabIds: plan.map((p) => p.tabIds).flat().sort(),
      settled: settled.length,
      strayed: strayed.map((p) => ({ space: p.spaceId, ids: p.tabIds })),
      manual: manual.length
    };
  });
  check(perSpace.count === 2 && JSON.stringify(perSpace.spaces) === JSON.stringify(['play', 'work']),
    'one Travel group per space, not one shared group', JSON.stringify(perSpace));
  check(JSON.stringify(perSpace.names) === JSON.stringify(['Travel']),
    'both carry the same rule name', JSON.stringify(perSpace.names));
  check(JSON.stringify(perSpace.tabIds) === JSON.stringify([1, 2]),
    'the non-matching tab is left ungrouped', JSON.stringify(perSpace.tabIds));
  check(perSpace.settled === 0,
    'a second pass over settled tabs is a no-op', String(perSpace.settled));
  check(perSpace.strayed.length === 1 && perSpace.strayed[0].space === 'play',
    'a tab in the wrong space’s group is moved to its own',
    JSON.stringify(perSpace.strayed));
  check(perSpace.manual === 0,
    'a hand-made group is never raided by the rules', String(perSpace.manual));

  // ------------------------------------------------- title matching (0.14.0)
  const byTitle = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const t = lib.compileRule({ patterns: ['title:SideRail'] });
    const trx = lib.compileRule({ patterns: ['title:/^Inbox/i'] });
    const u = lib.compileRule({ patterns: ['url:booking.com'] });
    const bare = lib.compileRule({ patterns: ['booking.com'] });
    const mixed = lib.compileRule({ patterns: ['title:invoice', 'stripe.com'] });
    return {
      hit: lib.ruleMatches(t, 'https://github.com/x', 'SideRail — vertical tabs'),
      caseless: lib.ruleMatches(t, 'https://github.com/x', 'siderail issue #4'),
      // the same word in the URL must NOT satisfy a title: pattern
      urlDoesNotCount: lib.ruleMatches(t, 'https://siderail.example/', 'Something else'),
      rx: lib.ruleMatches(trx, 'https://mail.example/', 'Inbox (12)'),
      rxAnchored: lib.ruleMatches(trx, 'https://mail.example/', 'Your Inbox'),
      // url: is explicit but must behave exactly like a bare pattern
      explicit: lib.ruleMatches(u, 'https://www.booking.com/x', 'Hotels'),
      explicitSame: lib.ruleMatches(bare, 'https://www.booking.com/x', 'Hotels'),
      // a dotted string in a title is text, not a hostname
      titleDotted: lib.ruleMatches(
        lib.compileRule({ patterns: ['title:foo.com'] }),
        'https://elsewhere.example/', 'ref foo.com here'),
      mixA: lib.ruleMatches(mixed, 'https://elsewhere.example/', 'Invoice 41'),
      mixB: lib.ruleMatches(mixed, 'https://stripe.com/pay', 'Pay'),
      mixMiss: lib.ruleMatches(mixed, 'https://elsewhere.example/', 'Nothing'),
      // no title at all must not throw or match
      noTitle: lib.ruleMatches(t, 'https://github.com/x'),
      // whitespace after the colon is forgiven
      spaced: lib.ruleMatches(lib.compileRule({ patterns: ['title: SideRail'] }),
        'https://x.example/', 'SideRail')
    };
  });
  check(byTitle.hit && byTitle.caseless, 'title: matches the tab title, case-insensitively',
    JSON.stringify(byTitle));
  check(!byTitle.urlDoesNotCount,
    'title: does not fall back to matching the URL', String(byTitle.urlDoesNotCount));
  check(byTitle.rx && !byTitle.rxAnchored, 'title:/regex/ anchors work',
    `hit=${byTitle.rx} anchored=${byTitle.rxAnchored}`);
  check(byTitle.explicit && byTitle.explicitSame,
    'url: is explicit but identical to a bare pattern — old rules are unaffected');
  check(byTitle.titleDotted, 'a dotted pattern on a title is text, not a hostname');
  check(byTitle.mixA && byTitle.mixB && !byTitle.mixMiss,
    'one rule can mix title: and url: patterns', JSON.stringify(byTitle));
  check(!byTitle.noTitle, 'a title: pattern on a tab with no title is a miss');
  check(byTitle.spaced, 'whitespace after the field prefix is forgiven');

  // --------------------------------------------- filing into spaces (0.14.0)
  const filing = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const rules = [
      { id: 'r1', name: 'Tube', enabled: true, group: false,
        patterns: ['youtube.com'], spaceId: 'fun' },
      { id: 'r2', name: 'Docs', enabled: true, patterns: ['title:SideRail'], spaceId: 'work' },
      { id: 'r3', name: 'Nothing', enabled: true, patterns: ['news.example'] }
    ];
    const tabs = [
      { id: 1, url: 'https://www.youtube.com/watch', title: 'A video' },
      { id: 2, url: 'https://github.com/r/s', title: 'SideRail — issues' },
      { id: 3, url: 'https://news.example/', title: 'News' },       // rule with no filing action
      { id: 4, url: 'https://www.youtube.com/feed', title: 'Feed' }, // already in fun
      { id: 5, url: 'https://www.youtube.com/x', title: 'Hand-placed' },
      { id: 6, url: 'https://www.youtube.com/y', title: 'The one you are reading' },
      { id: 7, url: 'https://www.youtube.com/z', title: 'Pinned', pinned: true },
      { id: 8, url: 'chrome://settings', title: 'Settings' }
    ];
    const spaceOf = { 1: 'unsorted', 2: 'unsorted', 3: 'unsorted', 4: 'fun',
      5: 'work', 6: 'unsorted', 7: 'unsorted', 8: 'unsorted' };
    const opts = { pinned: { 5: true }, skip: [6], spaceIds: ['fun', 'work'] };

    const plan = lib.planFiling(tabs, rules, spaceOf, opts);
    // The same pass run twice must be a no-op the second time.
    const after = { ...spaceOf, ...plan };
    const again = lib.planFiling(tabs, rules, after, opts);
    // A rule pointing at a deleted space files nothing.
    const orphan = lib.planFiling(tabs, rules, spaceOf, { ...opts, spaceIds: ['work'] });
    // The sweep (no skip list) does move the tab you are looking at.
    const sweep = lib.planFiling(tabs, rules, spaceOf, { ...opts, skip: [] });
    // group:false rules never produce a group.
    const groupPlan = lib.planRuleGroups(tabs, rules, spaceOf, []);

    return {
      plan,
      againCount: Object.keys(again).length,
      orphanIds: Object.keys(orphan),
      sweepHasActive: sweep[6] === 'fun',
      groupNames: groupPlan.map((g) => g.ruleName)
    };
  });
  check(filing.plan[1] === 'fun' && filing.plan[2] === 'work',
    'a filing rule moves matching tabs — by URL and by title', JSON.stringify(filing.plan));
  check(filing.plan[3] === undefined,
    'a rule with no space action files nothing', JSON.stringify(filing.plan));
  check(filing.plan[4] === undefined,
    'a tab already in the right space is not touched again');
  check(filing.plan[5] === undefined,
    'a tab you placed by hand outranks the rule that would move it');
  check(filing.plan[6] === undefined,
    'the tab you are looking at is never filed away from under you');
  check(filing.plan[7] === undefined && filing.plan[8] === undefined,
    'pinned tabs and internal pages are left alone');
  check(filing.againCount === 0,
    'filing settles — a second pass moves nothing', String(filing.againCount));
  check(filing.orphanIds.length === 1 && filing.orphanIds[0] === '2',
    'a rule pointing at a deleted space is ignored, the others still run',
    JSON.stringify(filing.orphanIds));
  check(filing.sweepHasActive,
    'the explicit sweep does move the active tab — you asked for it');
  check(JSON.stringify(filing.groupNames) === JSON.stringify(['Docs', 'Nothing']),
    'a rule with grouping switched off makes no group', JSON.stringify(filing.groupNames));

  // Both actions on one rule, and neither.
  const bothNeither = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const both = { id: 'b', name: 'Travel', enabled: true, patterns: ['t.example'], spaceId: 'trips' };
    const neither = { id: 'n', name: 'Idle', enabled: true, patterns: ['t.example'], group: false };
    const tabs = [{ id: 1, url: 'https://t.example/x', title: 'T', groupId: -1 }];
    return {
      bothFiles: Object.keys(lib.planFiling(tabs, [both], {}, { spaceIds: ['trips'] })).length,
      bothGroups: lib.planRuleGroups(tabs, [both], {}, []).length,
      neitherActive: lib.activeRules([neither]).length,
      legacyStillGroups: lib.ruleGroups({ name: 'Old', patterns: ['x'] })
    };
  });
  check(bothNeither.bothFiles === 1 && bothNeither.bothGroups === 1,
    'one rule can both file into a space and make a group',
    JSON.stringify(bothNeither));
  check(bothNeither.neitherActive === 0,
    'a rule with both actions switched off is inert rather than half-applied');
  check(bothNeither.legacyStillGroups,
    'a rule saved before 0.14.0 still groups — absent means yes');

  // The whole engine, through the service worker: a rule that files, a real
  // tab that navigates, and membership changing without the panel doing it.
  const liveFiling = await panel.evaluate(async () => {
    const wid = (await chrome.windows.getCurrent()).id;
    const savedRules = (await chrome.storage.local.get('rules')).rules || [];
    const savedSpaces = (await chrome.storage.local.get('spaces')).spaces || [];

    await chrome.storage.local.set({
      spaces: [...savedSpaces, { id: 'filed', name: 'Filed', emoji: '📥', manifest: [] }],
      rules: [{ id: 'file-me', name: 'Filed', enabled: true, group: false,
        patterns: ['url:filing.example', 'title:FileMeByTitle'], spaceId: 'filed' }]
    });

    // A background tab that matches by URL, and the active tab, which must not
    // move however well it matches.
    const bg = await chrome.tabs.create({ url: 'https://filing.example/a', active: false });
    const fg = await chrome.tabs.create({ url: 'https://filing.example/b', active: true });
    await new Promise((r) => setTimeout(r, 2200));

    const after = await __readSpaceOf();

    // Now say this one was placed by hand, put it back, and prove the rule
    // does not undo the decision.
    const pinnedTab = await chrome.tabs.create({ url: 'https://filing.example/c', active: false });
    await new Promise((r) => setTimeout(r, 2200));
    const sess = (await chrome.storage.session.get(['spaceOf'])).spaceOf || {};
    sess[pinnedTab.id] = 'unsorted';
    await __writeSpaceOf(sess);
    await chrome.storage.session.set({ [`sph:${pinnedTab.id}`]: 1 });
    await chrome.tabs.update(pinnedTab.id, { url: 'https://filing.example/d' });
    await new Promise((r) => setTimeout(r, 2200));
    const held = await __readSpaceOf();

    // The explicit sweep is allowed to move even the active tab.
    const swept = await chrome.runtime.sendMessage({
      type: 'file-tabs', windowId: wid, includeActive: true });
    const post = await __readSpaceOf();

    for (const id of [bg.id, fg.id, pinnedTab.id]) await chrome.tabs.remove(id).catch(() => {});
    await __clearPinnedFlags();
    await chrome.storage.local.set({ rules: savedRules, spaces: savedSpaces });
    await new Promise((r) => setTimeout(r, 300));

    return {
      background: after[bg.id], foreground: after[fg.id],
      handPlaced: held[pinnedTab.id], sweptForeground: post[fg.id],
      sweptCount: swept && swept.n
    };
  });
  check(liveFiling.background === 'filed',
    'the worker files a background tab into the space its rule names',
    JSON.stringify(liveFiling));
  check(liveFiling.foreground !== 'filed',
    'the tab in front of you stays put — the panel follows it, so filing it would jump spaces',
    String(liveFiling.foreground));
  check(liveFiling.handPlaced === 'unsorted',
    'a hand-placed tab survives a navigation that matches a filing rule',
    String(liveFiling.handPlaced));
  check(liveFiling.sweptForeground === 'filed',
    'the explicit sweep does file the active tab', JSON.stringify(liveFiling));


  // --------------------------------------------------------- settings view
  const settings = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const cog = document.getElementById('manage-open');
    if (!cog) return { missing: true };
    const cogLabel = cog.getAttribute('aria-label');
    const cogInBrowse = !cog.hidden;

    __goManage('settings');
    await new Promise((r) => setTimeout(r, 400));

    // Management sections, in order. Browsing is deliberately not among them.
    const order = [...document.querySelectorAll('.view-btn')].map((b) => b.dataset.view);
    const visible = document.getElementById('view-settings').classList.contains('is-active');
    const searchHidden = document.querySelector('.head-row').hidden;
    const backLabel = document.getElementById('manage-back').getAttribute('aria-label');
    const manageTitle = document.getElementById('manage-title').textContent;

    const root = document.documentElement;
    const range = document.querySelector('#view-settings input[type="range"]');
    const select = document.querySelector('#view-settings select');
    const wrapBox = document.querySelector('#view-settings input[type="checkbox"]');
    const readVar = (n) => root.style.getPropertyValue(n).trim();

    // Size.
    range.value = '17';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const size = readVar('--title-size');
    const sizeStored = (await chrome.storage.local.get('settings')).settings.titleSize;

    // Font, including the custom field appearing only when chosen.
    select.value = 'serif';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const serif = readVar('--title-font');
    const customHiddenForSerif = document.querySelectorAll('#view-settings .set-row')[2].hidden;

    select.value = 'custom';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const customShown = !document.querySelectorAll('#view-settings .set-row')[2].hidden;
    const custom = document.querySelector('#view-settings input[type="text"]');
    custom.value = 'Iosevka Term';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const customFont = readVar('--title-font');

    // Wrapping: the preview row carries a deliberately long title.
    const previewRow = () => document.querySelector('#view-settings .set-preview .tab-row');
    const flat = previewRow().getBoundingClientRect().height;
    wrapBox.checked = true;
    wrapBox.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    const wrapped = previewRow().getBoundingClientRect().height;
    const bodyWraps = document.body.classList.contains('wrap-titles');

    // Reset.
    [...document.querySelectorAll('#view-settings .card-actions button')]
      .find((b) => /Reset/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 500));
    const afterReset = {
      size: readVar('--title-size'),
      wraps: document.body.classList.contains('wrap-titles'),
      stored: (await chrome.storage.local.get('settings')).settings
    };

    __goBrowse();
    await new Promise((r) => setTimeout(r, 300));

    return {
      order, visible, searchHidden, cogLabel, cogInBrowse, backLabel, manageTitle,
      searchBackAfterLeaving: !document.querySelector('.head-row').hidden,
      size, sizeStored, serif, customHiddenForSerif, customShown, customFont,
      flat, wrapped, bodyWraps, afterReset,
      // Pure helpers, checked directly.
      clampHigh: lib.readAppearance({ titleSize: 99 }).titleSize,
      clampLow: lib.readAppearance({ titleSize: 2 }).titleSize,
      clampJunk: lib.readAppearance({ titleSize: 'big' }).titleSize,
      unknownFont: lib.readAppearance({ titleFont: 'comic' }).titleFont,
      hasMetrics: /document .*\d+px .*list .*\d+px/i.test(
        [...document.querySelectorAll('#view-settings .hint')].map((n) => n.textContent).join(' ')),
      hasEdges: [...document.querySelectorAll('#view-settings .adv button')]
        .some((b) => /Show edges/.test(b.textContent)),
      edgesAreFolded: !!document.querySelector('#view-settings details.adv') &&
        !document.querySelector('#view-settings details.adv').open,
      hasGrant: [...document.querySelectorAll('#view-settings button')]
        .some((b) => /^(Grant|Revoke)$/.test(b.textContent.trim())),
      grantLabel: [...document.querySelectorAll('#view-settings button')]
        .map((b) => b.textContent).filter((t) => /^(Grant|Revoke)$/.test(t.trim())),
      sanitised: lib.fontStackFor({ titleFont: 'custom', customFont: 'Ev;il"{}' }),
      emptyCustom: lib.fontStackFor({ titleFont: 'custom', customFont: '  ' })
    };
  });

  check(!settings.missing && settings.cogInBrowse && settings.cogLabel === 'Manage SideRail',
    'browsing offers one Manage SideRail cog',
    `${settings.cogLabel} · visible=${settings.cogInBrowse}`);
  check(JSON.stringify(settings.order) ===
        JSON.stringify(['spaces', 'rules', 'rewind', 'settings']),
    'management holds exactly Spaces, Rules, Rewind, Settings — and no Tabs',
    JSON.stringify(settings.order));
  check(settings.manageTitle === 'Manage SideRail' && settings.backLabel === 'Back to browsing',
    'the management header names itself and its way out',
    `${settings.manageTitle} / ${settings.backLabel}`);
  check(settings.visible, 'the cog opens the settings view');
  check(settings.searchHidden && settings.searchBackAfterLeaving,
    'the search box hides in settings and comes back on leaving');
  check(settings.size === '17px', 'title size drives a CSS variable', settings.size);
  check(settings.sizeStored === 17, 'title size is persisted', String(settings.sizeStored));
  check(/Georgia/.test(settings.serif), 'font choice drives a CSS variable', settings.serif);
  check(settings.customHiddenForSerif && settings.customShown,
    'the custom font field appears only when Custom is chosen');
  check(/^"Iosevka Term",/.test(settings.customFont),
    'a typed font name is quoted and falls back behind it', settings.customFont);
  check(settings.bodyWraps && settings.wrapped > settings.flat,
    'wrapping makes a long-titled row taller', `${settings.flat}px → ${settings.wrapped}px`);
  check(settings.afterReset.size === '13px' && !settings.afterReset.wraps,
    'reset restores the defaults', JSON.stringify(settings.afterReset.stored));
  check(settings.afterReset.stored.autoApply !== undefined,
    'resetting appearance leaves other settings alone',
    JSON.stringify(settings.afterReset.stored));
  check(settings.clampHigh === 18 && settings.clampLow === 11 && settings.clampJunk === 13,
    'a nonsense size in storage is clamped to something drawable',
    `${settings.clampHigh}/${settings.clampLow}/${settings.clampJunk}`);
  check(settings.unknownFont === 'system', 'an unknown font key falls back to System');
  check(settings.hasGrant,
    'settings offers a page-access control, so a missing grant is fixable there',
    JSON.stringify(settings.grantLabel));
  check(settings.edgesAreFolded,
    'developer instrumentation is folded away, not sitting in the open (0.21.0)',
    String(settings.edgesAreFolded));
  check(settings.hasMetrics && settings.hasEdges,
    'settings reports the panel measurements and can flash the document edge',
    JSON.stringify({ metrics: settings.hasMetrics, edges: settings.hasEdges }));
  // The fallback stack legitimately quotes "Segoe UI", so check the typed name
  // itself, plus the characters that could end or start a declaration.
  check(/^"Evil",/.test(settings.sanitised) && !/[;{}]/.test(settings.sanitised),
    'a typed font name cannot break out of the CSS declaration', settings.sanitised);
  check(/system-ui/.test(settings.emptyCustom) && !/""/.test(settings.emptyCustom),
    'an empty custom name falls back rather than emitting an empty family');

  // ------------------------------------------- nothing draws over the panel
  // The popover that kept "appearing on top of the siderail" was never the
  // hover card: it was the browser's own tooltip, from a `title` attribute on
  // the row. Native tooltips are drawn by the OS, so they spill outside the
  // panel and land on top of it — and they appear a beat AFTER the hover card,
  // so a correctly-placed card was still followed by a plain box over the rail.
  // Four attempts were aimed at the wrong popover. This pins it down.
  const tooltips = await panel.evaluate(async () => {
    __goBrowse();
    await new Promise((r) => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('#view-tabs .tab-row[data-id]')];
    const offenders = [];
    for (const row of rows) {
      const bad = [row, ...row.querySelectorAll('*')]
        .filter((n) => n.hasAttribute('title') && !n.classList.contains('close'));
      for (const n of bad) {
        offenders.push(`${n.className || n.tagName}="${n.getAttribute('title').slice(0, 30)}"`);
      }
    }
    return { rows: rows.length, offenders: offenders.slice(0, 5) };
  });
  check(tooltips.rows > 0, 'there are rows to check', `${tooltips.rows} rows`);
  check(tooltips.offenders.length === 0,
    'no tab row carries a native tooltip that would draw over the panel',
    JSON.stringify(tooltips.offenders));

  // ----------------------------------------------------- no scrollbar gutter
  // A styled ::-webkit-scrollbar is a *classic* scrollbar in Blink: it reserves
  // its width permanently, scrolling or not. On a panel that can't go below
  // ~360px that is width taken from every tab title, so the native bar is gone
  // and an overlay indicator is drawn over the content instead.
  // A real side panel is ~360px wide and not very tall. Without forcing that
  // here the list simply fits, and every check below would pass by never
  // running — which is exactly how the in-page card checks stayed hollow for
  // three versions.
  // Short enough that a single space's worth of tabs still overflows. This was
  // 260 until 0.17 removed the persistent nav row: the header got shorter, the
  // list got taller, and the content started fitting — which would have made
  // every check below pass without running. The assertion two lines down is
  // what caught that, and is why it is there.
  await panel.setViewportSize({ width: 360, height: 200 });
  await panel.waitForTimeout(500);

  const gutter = await panel.evaluate(async () => {
    __goBrowse();
    await new Promise((r) => setTimeout(r, 400));
    const main = document.getElementById('main');
    const thumb = document.getElementById('scrollthumb');

    const before = {
      gutter: main.offsetWidth - main.clientWidth,
      overflows: main.scrollHeight > main.clientHeight,
      thumbShown: thumb.classList.contains('show')
    };

    // Scrolling should surface the indicator, positioned over the content.
    main.scrollTop = Math.max(0, main.scrollHeight - main.clientHeight);
    main.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 250));

    const box = thumb.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    const shown = thumb.classList.contains('show');
    const style = getComputedStyle(thumb);

    // ...and fade back out when scrolling stops.
    let faded = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (!thumb.classList.contains('show')) { faded = true; break; }
    }

    return {
      ...before,
      shown,
      faded,
      insideMain: box.top >= mainBox.top - 1 && box.bottom <= mainBox.bottom + 1,
      atBottom: box.bottom > mainBox.bottom - 8,
      overlaps: box.right > mainBox.right - 10,
      ignoresPointer: style.pointerEvents === 'none',
      height: Math.round(box.height)
    };
  });

  check(gutter.gutter === 0,
    'the scroller reserves no width for a scrollbar', `${gutter.gutter}px gutter`);
  check(gutter.overflows,
    'the list really does overflow, so the checks below mean something',
    JSON.stringify({ overflows: gutter.overflows }));
  check(!gutter.overflows || gutter.shown,
    'scrolling shows the overlay indicator', JSON.stringify(gutter));
  check(!gutter.overflows || gutter.insideMain,
    'the indicator stays within the scrolling area', JSON.stringify(gutter));
  check(!gutter.overflows || gutter.atBottom,
    'it tracks the scroll position', JSON.stringify(gutter));
  check(!gutter.overflows || gutter.height >= 28,
    'it never shrinks to an invisible sliver', `${gutter.height}px`);
  check(gutter.ignoresPointer,
    'it ignores pointer events, so it cannot swallow a click on a row');

  // The list must span the document — anything narrower is width this panel is
  // wasting, as opposed to width the browser's own chrome is taking.
  const spans = await panel.evaluate(() => {
    const main = document.getElementById('main');
    return {
      doc: document.documentElement.clientWidth,
      list: main.clientWidth,
      docGutter: window.innerWidth - document.documentElement.clientWidth
    };
  });
  check(spans.list === spans.doc,
    'the list spans the full width of the document', JSON.stringify(spans));
  check(spans.docGutter === 0,
    'the document itself reserves no scrollbar either', `${spans.docGutter}px`);
  check(gutter.overlaps,
    'the indicator sits over the content, not in a column beside it',
    JSON.stringify({ overlaps: gutter.overlaps }));
  check(!gutter.overflows || gutter.faded,
    'it fades out once scrolling stops', JSON.stringify(gutter));

  await panel.setViewportSize({ width: 900, height: 900 });
  await panel.waitForTimeout(300);

  // -------------------------------------------- the shortcut can still open
  // sidePanel.open() needs a user gesture and the gesture does not survive an
  // await. The listener must therefore call it synchronously, before anything
  // else — a rule that is invisible at runtime and silently broke the shortcut
  // entirely, so it is pinned statically instead.
  const gesture = await panel.evaluate(async () => {
    const src = await fetch(chrome.runtime.getURL('background.js')).then((r) => r.text());
    const listener = src.slice(src.indexOf('chrome.commands.onCommand.addListener'));
    const raw = listener.slice(0, listener.indexOf('\n});') + 4);
    // Strip comments first — a comment explaining the rule would otherwise
    // trip the rule, which is exactly what happened when this was written.
    const body = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const openAt = body.indexOf('sidePanel.open');
    const awaitBefore = openAt !== -1 && body.slice(0, openAt).includes('await');
    const cmds = chrome.runtime.getManifest().commands;
    return {
      head: body.slice(0, Math.max(0, openAt)).replace(/\s+/g, ' ').slice(-120),
      foundOpen: openAt !== -1,
      asyncListener: /addListener\(\s*async/.test(body),
      awaitBefore,
      suggested: Object.values(cmds).filter((c) => c.suggested_key).length,
      mac: Object.entries(cmds)
        .filter(([, c]) => c.suggested_key && c.suggested_key.mac)
        .map(([k, c]) => `${k}=${c.suggested_key.mac}`)
    };
  });
  check(!gesture.asyncListener,
    'the command listener is not async — an async listener loses the user gesture');
  check(gesture.foundOpen, 'the listener does call sidePanel.open at all');
  check(!gesture.awaitBefore,
    'nothing is awaited before sidePanel.open(), or the panel silently refuses to open',
    gesture.head);
  check(gesture.suggested <= 4,
    'at most four suggested shortcuts — a fifth stops the extension loading at all',
    `${gesture.suggested} suggested`);
  check(gesture.mac.length >= 1,
    'macOS gets its own bindings, since Alt is Option there', JSON.stringify(gesture.mac));

  // ------------------------------------------------ rules that clash (0.16.0)
  const clashUnit = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const tabs = [
      { id: 1, url: 'https://github.com/a/b', title: 'Repo' },
      { id: 2, url: 'https://gitlab.com/x', title: 'Elsewhere' }
    ];
    const work = { id: 'work', name: 'Work', enabled: true, patterns: ['github.com'] };
    const code = { id: 'code', name: 'Code', enabled: true, patterns: ['github.com'] };
    const same = { id: 'same', name: 'Work', enabled: true, patterns: ['github.com'] };
    const files = { id: 'files', name: 'Filer', enabled: true, group: false,
      patterns: ['github.com'], spaceId: 'dev' };
    const filesToo = { id: 'files2', name: 'Filer2', enabled: true, group: false,
      patterns: ['github.com'], spaceId: 'ops' };

    return {
      // two grouping rules over the same tab, wanting different groups
      pair: lib.ruleConflicts([work, code], tabs),
      // order decides, so swapping them swaps who wins
      swapped: lib.ruleConflicts([code, work], tabs),
      // same outcome is agreement, not conflict
      agree: lib.ruleConflicts([work, same], tabs).length,
      // one groups, one files — they compose, which is the whole design
      compose: lib.ruleConflicts([work, files], tabs).length,
      // two filing rules pointing at different spaces DO clash
      spaces: lib.ruleConflicts([files, filesToo], tabs),
      // no shared tab, no warning
      apart: lib.ruleConflicts(
        [work, { id: 'lab', name: 'Lab', enabled: true, patterns: ['gitlab.com'] }], tabs).length,
      // a disabled rule is not a party to anything
      off: lib.ruleConflicts([work, { ...code, enabled: false }], tabs).length
    };
  });
  check(clashUnit.pair.length === 1 && clashUnit.pair[0].winner === 'work' &&
        clashUnit.pair[0].kind === 'group' && clashUnit.pair[0].tabIds.length === 1,
    'two rules wanting different groups for the same tab are reported, higher one winning',
    JSON.stringify(clashUnit.pair));
  check(clashUnit.swapped.length === 1 && clashUnit.swapped[0].winner === 'code',
    'order decides the winner, and reordering flips it', JSON.stringify(clashUnit.swapped));
  check(clashUnit.agree === 0,
    'two rules that would do the same thing are not a conflict', String(clashUnit.agree));
  check(clashUnit.compose === 0,
    'a grouping rule and a filing rule over one tab compose — not a conflict',
    String(clashUnit.compose));
  check(clashUnit.spaces.length === 1 && clashUnit.spaces[0].kind === 'space',
    'two rules filing the same tab into different spaces clash too',
    JSON.stringify(clashUnit.spaces));
  check(clashUnit.apart === 0 && clashUnit.off === 0,
    'rules that share no tab, and disabled rules, raise nothing',
    `apart=${clashUnit.apart} off=${clashUnit.off}`);

  // The warning has to reach the screen, and the fix has to work from there.
  const clashUI = await panel.evaluate(async () => {
    const saved = (await chrome.storage.local.get('rules')).rules || [];
    const t = await chrome.tabs.create({ url: 'https://clash.example/x', active: false });
    await chrome.storage.local.set({
      rules: [
        { id: 'first', name: 'First', color: 'blue', enabled: true, patterns: ['clash.example'] },
        { id: 'second', name: 'Second', color: 'red', enabled: true, patterns: ['clash.example'] }
      ]
    });
    await new Promise((r) => setTimeout(r, 600));
    __goManage('rules');
    await new Promise((r) => setTimeout(r, 600));

    const warnOn = (id) => {
      const c = document.querySelector(`.rule-card[data-id="${id}"] .rule-clash`);
      return c ? c.textContent : '';
    };
    const before = { first: warnOn('first'), second: warnOn('second') };

    // Diagnose rather than throw: a null here used to take the whole suite down
    // with a TypeError, which tells you nothing about why the card was missing.
    const cardCount = document.querySelectorAll('.rule-card').length;
    const fixBtn = document.querySelector('.rule-card[data-id="second"] .rule-clash button');
    if (!fixBtn) {
      return { bail: true, cardCount, query: document.getElementById('search').value,
               clashes: document.querySelectorAll('.rule-clash').length, before };
    }
    fixBtn.click();
    await new Promise((r) => setTimeout(r, 900));
    const order = ((await chrome.storage.local.get('rules')).rules || []).map((r) => r.id);
    const after = { first: warnOn('first'), second: warnOn('second') };

    // The ↑ on the top card and ↓ on the bottom one must be dead ends.
    const cards = [...document.querySelectorAll('.rule-card')];
    const topUp = cards[0].querySelector('.rank').disabled;
    const bottomDown = [...cards[cards.length - 1].querySelectorAll('.rank')][1].disabled;

    await chrome.tabs.remove(t.id).catch(() => {});
    await chrome.storage.local.set({ rules: saved });
    await new Promise((r) => setTimeout(r, 300));
    return { before, after, order, topUp, bottomDown };
  });
  check(!clashUI.bail,
    'the clash fixture actually rendered two rule cards',
    JSON.stringify(clashUI));
  check(/also match/.test(clashUI.before?.second || '') && clashUI.before?.first === '',
    'the rule that loses says so on its card; the one that wins stays quiet',
    JSON.stringify(clashUI.before));
  check(/“First”/.test(clashUI.before?.second || ''),
    'and it names the rule beating it', clashUI.before?.second);
  check(clashUI.order?.[0] === 'second',
    '“Put this rule first” reorders the rules', JSON.stringify(clashUI.order));
  check(clashUI.after?.second === '' && /also match/.test(clashUI.after?.first || ''),
    'and the warning moves to whichever rule now loses', JSON.stringify(clashUI.after));
  check(clashUI.topUp && clashUI.bottomDown,
    'the reorder arrows are disabled at the ends rather than doing nothing',
    JSON.stringify({ topUp: clashUI.topUp, bottomDown: clashUI.bottomDown }));

  // ------------------------- a rule's groups do not outlive it (0.16.0)
  const teardown = await panel.evaluate(async () => {
    const wid = (await chrome.windows.getCurrent()).id;
    const saved = (await chrome.storage.local.get('rules')).rules || [];
    const savedOrder = (await chrome.storage.local.get('groupOrder')).groupOrder || [];

    const made = [];
    for (const u of ['https://teardown.example/a', 'https://teardown.example/b']) {
      made.push((await chrome.tabs.create({ url: u, active: false })).id);
    }
    await chrome.storage.local.set({
      rules: [{ id: 'td', name: 'Teardown', color: 'cyan', enabled: true,
        patterns: ['teardown.example'] }],
      groupOrder: ['t:teardown', 't:other']
    });
    await new Promise((r) => setTimeout(r, 500));
    await chrome.runtime.sendMessage({ type: 'apply-rules', windowId: wid });
    await new Promise((r) => setTimeout(r, 700));

    const titles = () => chrome.tabGroups.query({ windowId: wid })
      .then((gs) => gs.map((g) => (g.title || '').toLowerCase()));
    const grouped = (await titles()).filter((t) => t === 'teardown').length;

    // Switching grouping off must take the existing group apart, not just stop
    // making new ones — that was the bug.
    __goManage('rules');
    await new Promise((r) => setTimeout(r, 500));
    const card = document.querySelector('.rule-card[data-id="td"]');
    const gcb = card.querySelector('.ract input[type="checkbox"]');
    gcb.checked = false;
    gcb.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 900));
    const afterUntick = (await titles()).filter((t) => t === 'teardown').length;
    // And a full rules pass must not put it back — "stops making new ones" is
    // the other half of the bug.
    await chrome.runtime.sendMessage({ type: 'apply-rules', windowId: wid });
    await new Promise((r) => setTimeout(r, 700));
    const afterRepass = (await titles()).filter((t) => t === 'teardown').length;
    const stillOpen = (await Promise.all(made.map((id) =>
      chrome.tabs.get(id).then(() => 1).catch(() => 0)))).reduce((a, b) => a + b, 0);
    const orderAfter = (await chrome.storage.local.get('groupOrder')).groupOrder || [];

    // Re-group, then delete the rule and choose "delete and ungroup".
    gcb.checked = true;
    gcb.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 900));
    const regrouped = (await titles()).filter((t) => t === 'teardown').length;

    document.querySelector('.rule-card[data-id="td"] .icon-btn:last-child').click();
    await new Promise((r) => setTimeout(r, 400));
    const buttons = [...document.querySelectorAll('#dialog-actions button')].map((b) => b.textContent);
    const both = [...document.querySelectorAll('#dialog-actions button')]
      .find((b) => /ungroup/i.test(b.textContent));
    both.click();
    await new Promise((r) => setTimeout(r, 900));
    const afterDelete = (await titles()).filter((t) => t === 'teardown').length;
    const ruleGone = !((await chrome.storage.local.get('rules')).rules || [])
      .some((r) => r.id === 'td');
    const survivors = (await Promise.all(made.map((id) =>
      chrome.tabs.get(id).then(() => 1).catch(() => 0)))).reduce((a, b) => a + b, 0);

    for (const id of made) await chrome.tabs.remove(id).catch(() => {});
    await chrome.storage.local.set({ rules: saved, groupOrder: savedOrder });
    await new Promise((r) => setTimeout(r, 300));

    return { grouped, afterUntick, afterRepass, stillOpen, orderAfter, regrouped,
      buttons, afterDelete, ruleGone, survivors };
  });
  check(teardown.grouped === 1,
    'the rule made its group, so the checks below mean something',
    String(teardown.grouped));
  check(teardown.afterUntick === 0,
    'switching grouping off takes the existing group apart, not just future ones',
    String(teardown.afterUntick));
  check(teardown.afterRepass === 0,
    'and a full rules pass does not rebuild it — grouping is off, so no group',
    String(teardown.afterRepass));
  check(teardown.stillOpen === 2,
    'ungrouping closes nothing — every tab is still open', String(teardown.stillOpen));
  check(!teardown.orderAfter.includes('t:teardown') && teardown.orderAfter.includes('t:other'),
    'and the jump-bar square goes with it, leaving other groups’ slots alone',
    JSON.stringify(teardown.orderAfter));
  check(teardown.regrouped === 1, 'ticking it back on rebuilds the group');
  check(teardown.buttons.length === 3 && teardown.buttons.some((b) => /keep the groups/i.test(b)),
    'deleting a rule that holds tabs offers to keep the groups as well',
    JSON.stringify(teardown.buttons));
  check(teardown.afterDelete === 0 && teardown.ruleGone,
    'deleting a rule takes its groups with it when you ask',
    JSON.stringify({ groups: teardown.afterDelete, ruleGone: teardown.ruleGone }));
  check(teardown.survivors === 2, 'and still closes nothing', String(teardown.survivors));

  // ------------------------------------------------- URL vs search (0.15.0)
  const intent = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const r = (s) => lib.readIntent(s);
    return {
      slashed: r('bbc.co.uk/news'),
      spaced: r('bbc.co.uk news'),
      scheme: r('https://example.com/a?b=c'),
      words: r('how do tab groups work'),
      localhost: r('localhost:3000/api'),
      ip: r('192.168.1.1'),
      // things that look like hosts but aren't places to go
      version: r('v1.2.3'),
      decimal: r('3.5'),
      email: r('someone@example.com'),
      eg: r('e.g'),
      titleRule: r('title:SideRail'),
      note: r('note: buy milk'),
      chromeUrl: r('chrome://extensions'),
      empty: r('   ')
    };
  });
  check(intent.slashed.open === 'https://bbc.co.uk/news' && intent.slashed.whole,
    'a bare host with a path is a whole URL — “Open” comes first',
    JSON.stringify(intent.slashed));
  check(intent.spaced.open === 'https://bbc.co.uk' && !intent.spaced.whole &&
        intent.spaced.search === 'bbc.co.uk news',
    'a host followed by words offers both readings, not a guess',
    JSON.stringify(intent.spaced));
  check(intent.scheme.open === 'https://example.com/a?b=c' && intent.scheme.host === 'example.com',
    'an explicit scheme is taken as written', JSON.stringify(intent.scheme));
  check(!intent.words.open && intent.words.search === 'how do tab groups work',
    'a sentence is a search, with nothing to open', JSON.stringify(intent.words));
  check(intent.localhost.open === 'https://localhost:3000/api' && intent.ip.open === 'https://192.168.1.1',
    'localhost and IP addresses are places', JSON.stringify(intent));
  check(!intent.version.open && !intent.decimal.open && !intent.eg.open,
    'a dotted string with no plausible TLD is not a URL',
    `v=${intent.version.open} d=${intent.decimal.open} eg=${intent.eg.open}`);
  check(!intent.email.open, 'an email address is not somewhere to navigate');
  check(!intent.titleRule.open && !intent.note.open,
    'a scheme-like prefix that is not a real scheme stays a search',
    `title=${intent.titleRule.open} note=${intent.note.open}`);
  check(intent.chromeUrl.open === 'chrome://extensions', 'chrome:// URLs are openable');
  check(!intent.empty.open && intent.empty.search === '', 'blank input asks for nothing');

  // ------------------------------------------------- the palette (0.15.0)
  // Park the caret somewhere else first. Opening the palette must take it —
  // a palette you have to click before you can type defeats the shortcut.
  const wasHidden = await panel.evaluate(() => {
    document.getElementById('search').focus();
    return document.getElementById('palette').hidden;
  });
  // Sent from the worker, exactly as pressing the shortcut does — a page cannot
  // deliver runtime.sendMessage to itself, so faking it from the panel proves
  // nothing about the path that actually runs.
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'open-palette' }).catch(() => {}));
  await panel.waitForTimeout(400);

  const palette = await panel.evaluate(async () => {
    const opened = !document.getElementById('palette').hidden;
    const input = document.getElementById('pal-input');
    const focused = document.activeElement === input;
    const idle = [...document.querySelectorAll('#pal-list .pal-sec')].map((n) => n.textContent);

    const type = async (text) => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 60));
      return [...document.querySelectorAll('#pal-list .pal-row')].map((r) => ({
        title: r.querySelector('.pal-title').textContent,
        sub: (r.querySelector('.pal-sub') || {}).textContent || '',
        badge: (r.querySelector('.pal-badge') || {}).textContent || '',
        sel: r.classList.contains('is-sel')
      }));
    };

    const url = await type('example.com/deep/path');
    const words = await type('ungroup');

    // Arrow keys move the selection and wrap.
    const key = (k) => input.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const before = [...document.querySelectorAll('#pal-row, #pal-list .pal-row')]
      .findIndex((r) => r.classList.contains('is-sel'));
    key('ArrowDown');
    const after = [...document.querySelectorAll('#pal-list .pal-row')]
      .findIndex((r) => r.classList.contains('is-sel'));
    key('ArrowUp'); key('ArrowUp');
    const wrapped = [...document.querySelectorAll('#pal-list .pal-row')]
      .findIndex((r) => r.classList.contains('is-sel'));
    const count = document.querySelectorAll('#pal-list .pal-row').length;

    // Escape closes it and leaves the panel as it was.
    const viewBefore = document.querySelector('.view.is-active').id;
    key('Escape');
    await new Promise((r) => setTimeout(r, 120));
    const closed = document.getElementById('palette').hidden;
    const viewAfter = document.querySelector('.view.is-active').id;

    return { opened, focused, idle, url, words,
      before, after, wrapped, count, closed, viewBefore, viewAfter };
  });
  check(wasHidden, 'the palette starts hidden — it is an overlay, not a view');
  check(palette.opened && palette.focused,
    'the worker’s shortcut message opens it with the caret already in the box, ' +
    'even when focus was elsewhere',
    JSON.stringify({ opened: palette.opened, focused: palette.focused }));

  // Typing straight after the shortcut, with no click in between, must land in
  // the palette — this is the whole point of it.
  const blindType = await panel.evaluate(async () => {
    document.getElementById('pal-input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    document.querySelector('#view-tabs').focus?.();
    document.body.focus();
    return document.activeElement === document.getElementById('pal-input');
  });
  check(!blindType, 'focus really was elsewhere before the next check');
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'open-palette' }).catch(() => {}));
  await panel.waitForTimeout(250);
  await panel.keyboard.type('zzq');
  await panel.waitForTimeout(150);
  const typed = await panel.evaluate(() => ({
    value: document.getElementById('pal-input').value,
    focused: document.activeElement === document.getElementById('pal-input')
  }));
  check(typed.value === 'zzq' && typed.focused,
    'keystrokes after the shortcut go into the palette without a click first',
    JSON.stringify(typed));
  await panel.keyboard.press('Escape');
  await panel.waitForTimeout(150);

  // Focus DRIFT, which is the way this actually failed in the wild. Chrome
  // hands the side panel its focus some milliseconds after sidePanel.open()
  // resolves, and whatever it focuses then replaced the caret we had just
  // placed. The first fix won the race once and stopped; this asserts the
  // caret comes back however late something else takes it.
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'open-palette' }).catch(() => {}));
  await panel.waitForTimeout(250);
  const drift = await panel.evaluate(async () => {
    const input = document.getElementById('pal-input');
    const steal = document.getElementById('search');
    const out = [];
    // Steal it repeatedly, at increasing delays, exactly as the browser does.
    for (const wait of [0, 120, 400, 900]) {
      await new Promise((r) => setTimeout(r, wait));
      steal.focus();
      await new Promise((r) => setTimeout(r, 120));
      out.push(document.activeElement === input);
    }
    return out;
  });
  check(drift.every(Boolean),
    'the palette takes the caret back whenever something else steals it',
    JSON.stringify(drift));

  // And it must let go the moment the palette closes, or the panel becomes
  // impossible to type in anywhere else.
  const released = await panel.evaluate(async () => {
    document.getElementById('pal-input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const search = document.getElementById('search');
    search.focus();
    await new Promise((r) => setTimeout(r, 400));
    return document.activeElement === search;
  });
  check(released,
    'and releases it once the palette is closed', String(released));
  check(palette.idle.length > 0,
    'an empty palette still offers something — recent tabs and commands',
    JSON.stringify(palette.idle));
  check(palette.url[0] && /example\.com\/deep\/path/.test(palette.url[0].title) &&
        palette.url[0].badge === 'url',
    'typing a URL puts Open at the top, badged as a URL',
    JSON.stringify(palette.url.slice(0, 2)));
  check(palette.url.some((r) => r.badge === 'web'),
    'searching the web is still offered underneath it');
  check(palette.words.some((r) => /Ungroup all tabs/.test(r.title)),
    'commands are matched by name', JSON.stringify(palette.words.slice(0, 3)));
  check(palette.words[0] && palette.words[0].badge !== 'web',
    'a plain word selects a tab or command first, not a web search — ↵ must not ' +
    'search for something already open',
    JSON.stringify(palette.words[0]));
  check(palette.words[palette.words.length - 1].badge === 'web',
    'the web search is still there, at the bottom where it belongs');
  check(palette.after === 1 && palette.wrapped === palette.count - 1,
    'arrows move the selection and wrap around the ends',
    JSON.stringify({ after: palette.after, wrapped: palette.wrapped, count: palette.count }));
  check(palette.closed && palette.viewBefore === palette.viewAfter,
    'escape closes it and leaves the view underneath untouched',
    `${palette.viewBefore} → ${palette.viewAfter}`);

  // Enter on a tab result switches to that tab rather than opening a copy.
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'open-palette' }).catch(() => {}));
  await panel.waitForTimeout(300);
  const palRun = await panel.evaluate(async () => {
    const before = (await chrome.tabs.query({ currentWindow: true })).length;
    const target = (await chrome.tabs.query({ currentWindow: true, active: false }))[0];
    const input = document.getElementById('pal-input');
    input.value = target.title || target.url;
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 120));

    // Walk to the first row that is actually a tab, skipping Go actions.
    const rows = [...document.querySelectorAll('#pal-list .pal-row')];
    const secs = [...document.querySelectorAll('#pal-list > *')];
    let idx = 0, seenTabs = false;
    for (const n of secs) {
      if (n.classList.contains('pal-sec')) { seenTabs = /Tabs/.test(n.textContent); continue; }
      if (seenTabs) break;
      idx++;
    }
    for (let i = 0; i < idx; i++) {
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowDown', bubbles: true, cancelable: true }));
    }
    input.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));

    const after = (await chrome.tabs.query({ currentWindow: true })).length;
    const active = (await chrome.tabs.query({ currentWindow: true, active: true }))[0];
    return { before, after, hit: active.id === target.id,
      closed: document.getElementById('palette').hidden, rows: rows.length };
  });
  check(palRun.after === palRun.before,
    'running a tab result opens no new tab — it switches to the one you have',
    `${palRun.before} → ${palRun.after}`);
  check(palRun.hit, 'and it switches to the right tab', JSON.stringify(palRun));
  check(palRun.closed, 'the palette closes once it has run something');

  // ------------------------------ shortcut settings, and no palette key (0.21.0)
  //
  // The in-panel palette key is gone, and so is the browser-wide
  // `command-palette` command. Every keyboard route into the box was either
  // broken (Chrome will not move focus into a side panel) or redundant (the
  // in-panel key needed you to have clicked in first). What replaces both is a
  // visible button beside the search field.
  const keys = await panel.evaluate(async () => {
    __goManage('settings');
    await new Promise((r) => setTimeout(r, 400));
    return {
      capture: document.querySelectorAll('.key-capture').length,
      keyTest: document.querySelectorAll('.key-test').length,
      rows: [...document.querySelectorAll('.key-row')].map((r) => r.textContent),
      link: [...document.querySelectorAll('#view-settings button')]
        .some((b) => /Change in Chrome/.test(b.textContent))
    };
  });
  check(keys.capture === 0 && keys.keyTest === 0,
    'the in-panel palette key and its test harness are gone',
    JSON.stringify({ capture: keys.capture, test: keys.keyTest }));
  check(keys.link && keys.rows.length >= 2,
    'settings still lists the live browser bindings and links to Chrome’s page',
    JSON.stringify(keys.rows));
  check(!keys.rows.some((r) => /palette/i.test(r)),
    'and the palette is no longer among them — the command was removed',
    JSON.stringify(keys.rows));

  const manifestCmds = Object.keys(
    JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).commands || {});
  check(!manifestCmds.includes('command-palette'),
    'the manifest no longer declares a palette shortcut', manifestCmds.join(', '));

  // The button is the whole entry point now, so it had better work — and it
  // must carry whatever is already typed rather than starting again.
  const palBtn = await panel.evaluate(async () => {
    __goBrowse();
    await new Promise((r) => setTimeout(r, 300));
    const btn = document.getElementById('open-palette');
    if (!btn) return { missing: true };
    const search = document.getElementById('search');
    search.value = 'exam';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    btn.click();
    await new Promise((r) => setTimeout(r, 250));
    const opened = !document.getElementById('palette').hidden;
    const carried = document.getElementById('pal-input').value;
    document.getElementById('pal-input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { opened, carried, closed: document.getElementById('palette').hidden };
  });
  check(!palBtn.missing && palBtn.opened,
    'the button beside the search box opens the palette', JSON.stringify(palBtn));
  check(palBtn.carried === 'exam',
    'and brings what you had already typed with it', String(palBtn.carried));

  // A bare letter must never open it, or typing anywhere becomes a minefield —
  // and now that no chord opens it either, nothing on the keyboard should.
  const noKeyOpens = await panel.evaluate(async () => {
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
    const press = (init) => document.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    press({ key: 'k' });
    press({ key: 'k', [isMac ? 'metaKey' : 'ctrlKey']: true });
    await new Promise((r) => setTimeout(r, 250));
    return document.getElementById('palette').hidden;
  });
  check(noKeyOpens, 'no keystroke opens the palette any more — neither ⌘K nor a bare letter');

  // The one failure we cannot fix, made visible. If Chrome has left keyboard
  // focus on the page, the palette says so rather than silently eating the
  // typing — and one click anywhere in the box takes the caret.
  const noFocus = await panel.evaluate(async () => {
    const note = document.getElementById('pal-nofocus');
    const present = !!note;
    // The notice is driven purely by document.hasFocus(), which a test page
    // always has — so drive the reporting path directly instead of faking the
    // browser state, and check the copy names the cause.
    const input = document.getElementById('pal-input');
    document.getElementById('manage-open').click();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById('manage-back').click();
    await new Promise((r) => setTimeout(r, 250));
    return { present, hiddenWhenFocused: note.hidden, hasFocus: document.hasFocus(),
      inputExists: !!input };
  });
  check(noFocus.present, 'the palette carries a place to explain a focus failure');
  check(!noFocus.hasFocus || noFocus.hiddenWhenFocused,
    'and says nothing while focus is where it should be',
    `hasFocus=${noFocus.hasFocus} hidden=${noFocus.hiddenWhenFocused}`);

  // The two shortcuts can no longer be confused for each other, because there is
  // only one of them: the in-panel key and its test harness were removed in
  // 0.21.0. What must survive is the honest account of WHY no key opens the
  // palette — that is the thing users would otherwise report as a bug.
  const keyCopy = await panel.evaluate(async () => {
    document.getElementById('manage-open').click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('.view-btn[data-view="settings"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const text = document.getElementById('view-settings').textContent;
    const out = {
      text,
      hasTest: !!document.querySelector('.key-test'),
      hasCapture: !!document.querySelector('.key-capture')
    };
    document.getElementById('manage-back').click();
    await new Promise((r) => setTimeout(r, 250));
    return out;
  });
  check(!keyCopy.hasTest && !keyCopy.hasCapture,
    'the in-panel key setting and its test harness are gone',
    JSON.stringify({ test: keyCopy.hasTest, capture: keyCopy.hasCapture }));
  check(/does not let an extension move keyboard focus/i.test(keyCopy.text),
    'but settings still explains why no key opens the palette');
  check(/Chromium 151/.test(keyCopy.text),
    'and dates that claim to a version someone actually checked');
  check(!/fixed in Chrome \d+/i.test(keyCopy.text),
    'without promising a version that fixes it — the last such claim was wrong');

  // A picture, so a broken overlay is visible rather than merely untested.
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'open-palette' }).catch(() => {}));
  await panel.waitForTimeout(300);
  await panel.evaluate(() => {
    const i = document.getElementById('pal-input');
    i.value = 'example.com/news';
    i.dispatchEvent(new Event('input'));
  });
  await panel.waitForTimeout(200);
  const shotDir = path.join(EXT, 'test', 'shots');
  fs.mkdirSync(shotDir, { recursive: true });
  await panel.screenshot({ path: path.join(shotDir, 'palette.png') }).catch(() => {});
  const palShot = await panel.evaluate(() => {
    const box = document.getElementById('pal-box').getBoundingClientRect();
    const list = document.getElementById('pal-list').getBoundingClientRect();
    const rows = document.querySelectorAll('#pal-list .pal-row').length;
    return { w: Math.round(box.width), doc: document.documentElement.clientWidth,
      listH: Math.round(list.height), rows,
      inside: box.left >= 0 && box.right <= document.documentElement.clientWidth + 1 };
  });
  await panel.evaluate(() => document.getElementById('pal-input').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  check(palShot.inside && palShot.w > 0 && palShot.listH > 40 && palShot.rows > 0,
    'the palette fits inside the panel and has drawn its rows',
    JSON.stringify(palShot));

  // ------------------- a pinned tab stays in its space (0.19.1)
  //
  // rebuildMembership() REPLACES state.spaceOf and then persists it. It used to
  // skip pinned tabs while doing so — left over from when a pin was global and
  // had no space of its own — which silently deleted every pinned tab's
  // placement on every panel boot. The panel's `|| MAIN` fallback then drew it
  // in Main, so a pin filed into another space migrated back on its own.
  const pinStays = await panel.evaluate(async () => {
    const savedSpaces = (await chrome.storage.local.get('spaces')).spaces || [];
    await chrome.storage.local.set({
      spaces: [...savedSpaces, { id: 'work', name: 'Work', emoji: '🎨', manifest: [] }]
    });
    await new Promise((r) => setTimeout(r, 600));

    // Explicitly in the panel's own window: by this point other tests have
    // created windows, and a tab in one of those would never be drawn here —
    // which would make the UI check below quietly meaningless.
    const wid = (await chrome.windows.getCurrent()).id;
    const t = await chrome.tabs.create({ windowId: wid, url: 'https://pinnedhere.example/', active: false });
    await chrome.tabs.update(t.id, { pinned: true });
    await new Promise((r) => setTimeout(r, 700));

    const sess = await __readSpaceOf();
    sess[t.id] = 'work';
    await __writeSpaceOf(sess);
    await new Promise((r) => setTimeout(r, 500));
    const before = (await __readSpaceOf())[t.id];

    return { tabId: t.id, before, savedSpaces, wid, pinned: (await chrome.tabs.get(t.id)).pinned };
  });
  check(pinStays.before === 'work' && pinStays.pinned,
    'a pinned tab can be filed into a space',
    `${pinStays.before} · pinned=${pinStays.pinned}`);

  // The rebuild happens on panel boot, so reload it — that is the exact path
  // that was eating the placement.
  await panel.reload({ waitUntil: 'load' });
  await panel.waitForTimeout(1600);

  const afterBoot = await panel.evaluate(async (tabId) => {
    const stored = await __readSpaceOf();
    return { stored: stored[tabId], keys: Object.keys(stored).length };
  }, pinStays.tabId);
  check(afterBoot.stored === 'work',
    'and it is STILL in that space after the panel rebuilds membership',
    `${afterBoot.stored} (${afterBoot.keys} placements)`);

  // And it must be drawn in that space's pinned strip and not in Main's —
  // switching spaces the way a user does, by clicking the chip.
  const drawnIn = await panel.evaluate(async (tabId) => {
    const chipFor = (name) => [...document.querySelectorAll('.schip')]
      .find((c) => c.querySelector('.nm').textContent === name);
    const pinsNow = () => [...document.querySelectorAll('.pin-chip')]
      .map((c) => Number(c.dataset.id));

    // Diagnose rather than throw: after the reload the chips may not be drawn yet.
    for (let i = 0; i < 30 && !(chipFor('Work') && chipFor('Main')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!chipFor('Work') || !chipFor('Main')) {
      return { inWork: false, inMain: false, sawTabId: Number.isFinite(tabId),
        chips: [...document.querySelectorAll('.schip .nm')].map((n) => n.textContent) };
    }
    chipFor('Work').click();
    await new Promise((r) => setTimeout(r, 700));
    const inWork = pinsNow().includes(tabId);

    chipFor('Main').click();
    await new Promise((r) => setTimeout(r, 700));
    const inMain = pinsNow().includes(tabId);

    // Guard: `includes(undefined)` is false for both, which would make the
    // check below pass or fail for reasons unrelated to spaces.
    return { inWork, inMain, sawTabId: Number.isFinite(tabId) };
  }, pinStays.tabId);
  check(drawnIn.sawTabId, 'the pin-strip check is looking at a real tab id');
  check(drawnIn.inWork && !drawnIn.inMain,
    'and it is drawn in Work’s pinned strip, not Main’s',
    JSON.stringify(drawnIn));

  await panel.evaluate(async (info) => {
    await chrome.tabs.remove(info.tabId).catch(() => {});
    await chrome.storage.local.set({ spaces: info.savedSpaces });
    await new Promise((r) => setTimeout(r, 500));
  }, pinStays);

  // ------- a tab opened by the panel lands in the panel's window (0.20.1)
  //
  // `chrome.tabs.create({url})` with no windowId targets the "current" window,
  // and from inside a side panel that is not reliably the window whose tabs the
  // panel is drawing. A tab landing in another window is placed by THAT
  // window's space — which reads as "it opened in the wrong space".
  const opensWhere = await panel.evaluate(async () => {
    const wid = (await chrome.windows.getCurrent()).id;
    const other = await chrome.windows.create({ url: 'https://elsewhere.example/', focused: true });
    await new Promise((r) => setTimeout(r, 900));

    // With another window focused, ask the panel to open something.
    const before = (await chrome.tabs.query({ windowId: wid })).length;
    const rows = [...document.querySelectorAll('#view-tabs .tab-row[data-id]')];
    // Drive the real path: the palette's "open this address" row.
    const created = await new Promise(async (res) => {
      const seen = (t) => { chrome.tabs.onCreated.removeListener(seen); res(t); };
      chrome.tabs.onCreated.addListener(seen);
      setTimeout(() => res(null), 4000);
      await chrome.runtime.sendMessage({ type: 'open-palette' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      const input = document.getElementById('pal-input');
      input.value = 'panelopened.example/x';
      input.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 400));
      input.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 900));

    const landedIn = created ? (await chrome.tabs.get(created.id)).windowId : null;
    if (created) await chrome.tabs.remove(created.id).catch(() => {});
    await chrome.windows.remove(other.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    return { wid, landedIn, before, rows: rows.length };
  }).catch((e) => ({ error: String(e) }));
  check(!opensWhere.error && opensWhere.landedIn === opensWhere.wid,
    'a tab the panel opens lands in the panel’s own window, not whichever is focused',
    JSON.stringify(opensWhere));

  // ------------- concurrent writers must not erase each other (0.20.0)
  //
  // This is the bug three releases failed to fix. Membership lived in ONE
  // storage key that both the panel and the service worker read, patched and
  // wrote back — with no atomic read-modify-write in chrome.storage. The
  // worker's filing pass runs on every tab creation and every navigation, so
  // any placement written between that pass's read and its write vanished.
  // One key per tab removes the class: two writers touching different tabs are
  // no longer writing the same key.
  const race = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    await lib.dropMembership([90001, 90002, 90003]);

    // Writer A reads, then stalls — exactly the worker's window of exposure.
    const seenByA = await lib.readMembership();

    // Writer B places a tab while A is thinking.
    await lib.writeMembership({ 90002: 'work' });

    // A now writes its own change, knowing nothing about B's.
    await lib.writeMembership({ 90001: 'work' });

    const after = await lib.readMembership();

    // And a whole-map write of A's stale view — the OLD behaviour — for contrast.
    const staleWouldHaveKept = { ...seenByA.spaceOf, 90001: 'work' };

    await lib.dropMembership([90001, 90002, 90003]);
    const cleared = await lib.readMembership();

    return {
      bSurvived: after.spaceOf['90002'] === 'work',
      aSurvived: after.spaceOf['90001'] === 'work',
      staleWouldHaveLostB: staleWouldHaveKept['90002'] === undefined,
      droppedBoth: cleared.spaceOf['90001'] === undefined &&
                   cleared.spaceOf['90002'] === undefined
    };
  });
  check(race.aSurvived && race.bSurvived,
    'two writers interleaving keep both placements',
    JSON.stringify(race));
  check(race.staleWouldHaveLostB,
    'and the old whole-map write really would have lost one — the check has teeth',
    String(race.staleWouldHaveLostB));
  check(race.droppedBoth, 'closing a tab removes its placement');

  // ------------- a new tab opens in the space you are looking at (0.20.0)
  const opensHere = await panel.evaluate(async () => {
    const savedSpaces = (await chrome.storage.local.get('spaces')).spaces || [];
    await chrome.storage.local.set({
      spaces: [...savedSpaces, { id: 'here', name: 'Here', emoji: '📍', manifest: [] }]
    });
    await new Promise((r) => setTimeout(r, 700));

    // Sit in that space, the way you would before opening something.
    const chip = [...document.querySelectorAll('.schip')]
      .find((c) => c.querySelector('.nm').textContent === 'Here');
    if (!chip) return { error: 'no chip' };
    chip.click();
    await new Promise((r) => setTimeout(r, 600));

    const wid = (await chrome.windows.getCurrent()).id;
    const made = [];
    for (let i = 0; i < 3; i++) {
      made.push((await chrome.tabs.create({
        windowId: wid, url: `https://opened${i}.example/`, active: false
      })).id);
      await new Promise((r) => setTimeout(r, 400));
    }
    // Long enough for the worker's debounced filing pass to have run.
    await new Promise((r) => setTimeout(r, 2500));

    const spaceOf = await __readSpaceOf();
    const landed = made.map((id) => spaceOf[id]);

    for (const id of made) await chrome.tabs.remove(id).catch(() => {});
    [...document.querySelectorAll('.schip')]
      .find((c) => c.querySelector('.nm').textContent === 'Main').click();
    await chrome.storage.local.set({ spaces: savedSpaces });
    await new Promise((r) => setTimeout(r, 600));
    return { landed };
  });
  check(!opensHere.error && opensHere.landed.every((v) => v === 'here'),
    'a tab opened while showing a space lands in THAT space, not Main',
    JSON.stringify(opensHere.landed));

  // ------------- ...even when the browser hands the tab an opener (0.20.3)
  //
  // This is the shape the reporter actually hits, and nothing in the suite could
  // produce it before. A tab made by `chrome.tabs.create({openerTabId})` shows
  // up in `onCreated` with NO opener, so every API-driven test exercised the
  // no-opener path. Only a tab the BROWSER creates carries one — measured on
  // Helium/Chromium 151, where such a tab reports `openerTabId` set, `url: ''`
  // and no `pendingUrl` at all. So this drives a real target=_blank click with
  // the opener parked in a different space from the one on screen, which is
  // what ⌘T-after-a-space-switch looks like from inside the extension: the
  // active tab still belongs to the space you just left, and Chromium offers
  // it up as the new tab's opener.
  const openerSetup = await panel.evaluate(async () => {
    const savedSpaces = (await chrome.storage.local.get('spaces')).spaces || [];
    await chrome.storage.local.set({
      spaces: [...savedSpaces, { id: 'here', name: 'Here', emoji: '📍', manifest: [] }]
    });
    await new Promise((r) => setTimeout(r, 700));
    return { savedSpaces, wid: (await chrome.windows.getCurrent()).id };
  });

  const host = await ctx.newPage();
  await host.goto('https://example.com/opener-host',
    { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await host.setContent('<a id="go" href="https://child.example/" target="_blank">go</a>');
  // Front it BEFORE choosing the space: bringing a tab forward makes the panel
  // follow it, which would undo the switch we are about to make.
  await host.bringToFront();
  await panel.waitForTimeout(700);

  const hostId = await panel.evaluate(async () => {
    const t = (await chrome.tabs.query({})).find((x) => /opener-host/.test(x.url || ''));
    if (!t) return null;
    await __writeSpaceOf({ [t.id]: 'unsorted' });
    // Poll, don't wait: the chip appears when the panel has absorbed the new
    // space, and the switch lands when it has absorbed the click. A fixed 700ms
    // was enough on every run but one.
    const showing = () => document.querySelector('.schip.is-on .nm')?.textContent;
    for (let i = 0; i < 60 && showing() !== 'Here'; i++) {
      const chip = [...document.querySelectorAll('.schip')]
        .find((c) => c.querySelector('.nm').textContent === 'Here');
      if (chip && showing() !== 'Here') chip.click();
      await new Promise((r) => setTimeout(r, 100));
    }
    return t.id;
  });
  const showingBefore = await panel.evaluate(() =>
    document.querySelector('.schip.is-on .nm')?.textContent || null);

  await host.click('#go').catch(() => {});
  // Long enough for the worker's debounced filing pass to have run too.
  await panel.waitForTimeout(2500);

  const openerCase = await panel.evaluate(async (id) => {
    const spaceOf = await __readSpaceOf();
    const kids = (await chrome.tabs.query({})).filter((t) => t.openerTabId === id);
    const child = kids[kids.length - 1] || null;
    return {
      hostSpace: spaceOf[id] || null,
      childOpener: child ? child.openerTabId : null,
      childSpace: child ? (spaceOf[child.id] || null) : null,
      childId: child ? child.id : null
    };
  }, hostId);

  check(!!openerCase.childId && openerCase.childOpener === hostId &&
        openerCase.hostSpace !== 'here' && showingBefore === 'Here',
    'the opener check has teeth: a browser-made tab, a real opener, another space',
    JSON.stringify({ ...openerCase, hostId, showingBefore }));
  check(openerCase.childSpace === 'here',
    'a new tab lands in the space on screen even when its opener belongs to another',
    `${openerCase.childSpace} vs here`);

  await panel.evaluate(async ({ savedSpaces, childId, hostId }) => {
    for (const id of [childId, hostId]) if (id) await chrome.tabs.remove(id).catch(() => {});
    [...document.querySelectorAll('.schip')]
      .find((c) => c.querySelector('.nm').textContent === 'Main')?.click();
    await chrome.storage.local.set({ spaces: savedSpaces });
    await new Promise((r) => setTimeout(r, 700));
  }, { savedSpaces: openerSetup.savedSpaces, childId: openerCase.childId, hostId });

  // ------------- membership survives a second window (0.19.2)
  //
  // `rebuildMembership()` REPLACES the membership map and then persists it. It
  // built that map from ONE window's tabs, so every boot deleted the placement
  // of every tab in every other window — and two panels wiped each other's on
  // every refresh. This is the case the earlier pinned-tab tests missed
  // entirely, because they only ever had one window.
  const twoWindows = await panel.evaluate(async () => {
    const savedSpaces = (await chrome.storage.local.get('spaces')).spaces || [];
    await chrome.storage.local.set({
      spaces: [...savedSpaces, { id: 'far', name: 'Far', emoji: '🛰', manifest: [] }]
    });
    await new Promise((r) => setTimeout(r, 600));

    // A tab in ANOTHER window, filed into a space.
    const other = await chrome.windows.create({ url: 'https://faraway.example/', focused: false });
    const stray = other.tabs[0];
    await new Promise((r) => setTimeout(r, 900));

    const sess = await __readSpaceOf();
    sess[stray.id] = 'far';
    await __writeSpaceOf(sess);
    await new Promise((r) => setTimeout(r, 600));
    const before = (await __readSpaceOf())[stray.id];

    return { strayId: stray.id, windowId: other.id, before, savedSpaces };
  });
  check(twoWindows.before === 'far',
    'a tab in another window can be filed into a space', String(twoWindows.before));

  // This panel rebuilding must not touch it.
  await panel.reload({ waitUntil: 'load' });
  await panel.waitForTimeout(1800);
  const survived = await panel.evaluate(async (id) =>
    (await __readSpaceOf())[id], twoWindows.strayId);
  check(survived === 'far',
    'and this window’s panel rebuilding its membership does not erase it',
    String(survived));

  await panel.evaluate(async (info) => {
    await chrome.windows.remove(info.windowId).catch(() => {});
    await chrome.storage.local.set({ spaces: info.savedSpaces });
    await new Promise((r) => setTimeout(r, 500));
  }, twoWindows);

  // ------------------------- Rewind remembers spaces (0.19)
  //
  // The point of the change: a snapshot used to record only browser state, so a
  // restore re-sorted tabs by URL against whatever the spaces looked like THEN
  // — which is exactly wrong for a feature whose job is to undo changes.
  const rewindSpaces = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const savedSpaces = (await chrome.storage.local.get('spaces')).spaces || [];
    const savedSnaps = (await chrome.storage.local.get('snapshots')).snapshots || [];

    const made = [];
    for (const u of ['https://rw1.example/a', 'https://rw2.example/b']) {
      made.push((await chrome.tabs.create({ url: u, active: false })).id);
    }
    // Wait for the URLs to actually land. A tab that is still at about:blank is
    // not saveable, so it is excluded from the capture — and the assertions
    // below would then be measuring an empty snapshot rather than a bug.
    for (let i = 0; i < 40; i++) {
      const urls = await Promise.all(made.map((id) =>
        chrome.tabs.get(id).then((t) => t.url).catch(() => '')));
      if (urls.every((u) => /rw[12]\.example/.test(u))) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await chrome.storage.local.set({
      spaces: [{ id: 'gonesoon', name: 'Doomed', emoji: '💀', manifest: [] }]
    });
    await new Promise((r) => setTimeout(r, 600));

    // Put one in the doomed space and one on the global pin.
    const sess = await __readSpaceOf();
    sess[made[0]] = 'gonesoon';
    sess[made[1]] = '*';
    await __writeSpaceOf(sess);
    await new Promise((r) => setTimeout(r, 400));

    const snap = (await chrome.runtime.sendMessage({ type: 'snapshot-now' })).snap;
    if (!snap) return { error: 'no snapshot taken — signature unchanged?' };
    const inSnap = (snap.windows || []).flatMap((w) => w.tabs || [])
      .filter((t) => /rw[12]\.example/.test(t.url))
      .map((t) => [t.url.replace(/^https:\/\//, ''), t.space]);
    const snapSpaces = (snap.spaces || []).map((sp) => sp.id);

    // Now delete the space, exactly as a user would regret doing.
    await chrome.storage.local.set({ spaces: [] });
    await new Promise((r) => setTimeout(r, 500));
    const missing = lib.missingSpacesIn(snap, []);
    // A tab carrying an id that was ALREADY gone when the snapshot was taken is
    // stale membership, not a space to resurrect.
    const stale = lib.missingSpacesIn(
      { spaces: [], windows: [{ tabs: [{ url: 'https://x.example/', space: 'never-existed' }] }] }, []);

    for (const id of made) await chrome.tabs.remove(id).catch(() => {});
    await chrome.storage.local.set({ spaces: savedSpaces, snapshots: savedSnaps });
    await new Promise((r) => setTimeout(r, 400));

    return { inSnap, snapSpaces, missing, stale: stale.length };
  });
  check(JSON.stringify(rewindSpaces.inSnap.sort()) ===
        JSON.stringify([['rw1.example/a', 'gonesoon'], ['rw2.example/b', '*']].sort()),
    'a snapshot records which space each tab was in, global pins included',
    JSON.stringify(rewindSpaces.inSnap));
  check(rewindSpaces.snapSpaces.includes('gonesoon'),
    'and the spaces themselves, so a deleted one can be named later',
    JSON.stringify(rewindSpaces.snapSpaces));
  const doomed = rewindSpaces.missing.find((sp) => sp.id === 'gonesoon');
  check(doomed && doomed.name === 'Doomed' && doomed.emoji === '💀',
    'after the space is deleted, the snapshot still knows its name and emoji',
    JSON.stringify(rewindSpaces.missing));
  check(rewindSpaces.stale === 0,
    'an id the snapshot never recorded is stale membership, not a space to offer back',
    `${rewindSpaces.stale} offered`);

  // Recreating must reuse the original id, or every tab that recorded it is
  // orphaned — which would defeat the whole exercise.
  const reborn = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const sp = lib.makeLiveSpace({ name: 'Doomed', emoji: '💀', id: 'gonesoon' });
    const fresh = lib.makeLiveSpace({ name: 'Other', emoji: '' });
    return { kept: sp.id, name: sp.name, generated: fresh.id !== 'gonesoon' && !!fresh.id };
  });
  check(reborn.kept === 'gonesoon' && reborn.name === 'Doomed',
    'recreating a space from a snapshot keeps its original id',
    JSON.stringify(reborn));
  check(reborn.generated,
    'while an ordinary new space still gets a fresh one');

  // ------------------------------------- the font covers the panel (0.18)
  const fontReach = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const s = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...s, titleFont: 'serif' } });
    await new Promise((r) => setTimeout(r, 400));

    const fam = (el) => el ? getComputedStyle(el).fontFamily : '';
    const out = {
      body: fam(document.body),
      title: fam(document.querySelector('#view-tabs .tab-row .title')),
      space: fam(document.querySelector('.schip .nm')),
      caption: fam(document.querySelector('.layer-cap')),
      search: fam(document.getElementById('search')),
      foot: fam(document.querySelector('.foot-label'))
    };
    await chrome.storage.local.set({ settings: { ...s, titleFont: 'system' } });
    await new Promise((r) => setTimeout(r, 400));
    out.afterReset = fam(document.querySelector('.schip .nm'));
    return out;
  });
  const serif = (v) => /Georgia/.test(v || '');
  check(serif(fontReach.body) && serif(fontReach.title) && serif(fontReach.space) &&
        serif(fontReach.caption) && serif(fontReach.search) && serif(fontReach.foot),
    'the chosen typeface reaches the whole panel, not just tab titles',
    JSON.stringify(fontReach));
  check(!serif(fontReach.afterReset),
    'and changing it back takes effect everywhere too', fontReach.afterReset);

  // ------------------------------------------- the emoji picker (0.18)
  const emoji = await panel.evaluate(async () => {
    const lib = await import('./vendor/emoji.js');
    const total = lib.EMOJI.length;
    return {
      total,
      groups: lib.EMOJI_GROUPS.length,
      // "ox" is two letters, so the floor is 2, not 3.
      hasNames: lib.EMOJI.every((e) => typeof e[1] === 'string' && e[1].length >= 2),
      rocket: lib.EMOJI.find((e) => e[1] === 'rocket'),
      // Skin-tone variants are deliberately excluded — five copies of every
      // gesture would bury everything else.
      noSkinTones: !lib.EMOJI.some((e) => /skin tone/.test(e[1]))
    };
  }).catch((e) => ({ error: String(e) }));
  check(!emoji.error && emoji.total > 1500,
    'the full Unicode emoji set is vendored', JSON.stringify({ total: emoji.total }));
  check(!emoji.error && emoji.hasNames && !!emoji.rocket,
    'every emoji carries its Unicode name, so search has something to match',
    JSON.stringify(emoji.rocket));
  check(!emoji.error && emoji.noSkinTones && emoji.groups >= 8,
    'skin-tone duplicates are excluded, and the groups survived',
    `${emoji.groups} groups`);

  // The picker itself: open the real dialog and search it.
  const picker = await panel.evaluate(async () => {
    __goManage('spaces');
    await new Promise((r) => setTimeout(r, 400));
    [...document.querySelectorAll('#view-spaces button')]
      .find((b) => /New space/i.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 350));

    const search = document.querySelector('.emoji-search');
    const before = document.querySelectorAll('.emoji-grid button').length;
    search.value = 'rocket';
    search.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 500));
    const hits = [...document.querySelectorAll('.emoji-grid button')].map((b) => b.textContent);

    // Enter picks the first hit rather than submitting an empty dialog.
    search.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const chosen = document.querySelector('.emoji-grid button.is-on');
    const stillOpen = !document.getElementById('dialog-back').hidden;

    // A miss should say so rather than showing an empty grid.
    search.value = 'zzzzqqq';
    search.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 500));
    const missNote = document.querySelector('.emoji-status').textContent;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    __goBrowse();
    await new Promise((r) => setTimeout(r, 300));
    return { before, hits, chosen: chosen ? chosen.textContent : null, stillOpen, missNote };
  });
  check(picker.before > 20,
    'the picker opens on a useful set rather than an empty grid',
    `${picker.before} tiles`);
  check(picker.hits.includes('🚀'),
    'searching by name finds the emoji', JSON.stringify(picker.hits.slice(0, 6)));
  check(picker.chosen === '🚀' && picker.stillOpen,
    'Enter picks the first hit instead of submitting the dialog',
    `${picker.chosen} · open=${picker.stillOpen}`);
  check(/Nothing matches/.test(picker.missNote),
    'and a search with no hits says so', picker.missNote);

  // ------------------------------------------------- browse/manage shell (0.17)
  // A panel-shaped viewport, so the tab list actually overflows and the
  // scroll-restore check below has something to restore.
  await panel.setViewportSize({ width: 360, height: 320 });
  await panel.waitForTimeout(300);

  const shell = await panel.evaluate(async () => {
    __goBrowse();
    await new Promise((r) => setTimeout(r, 300));

    const browse = {
      navHidden: document.getElementById('views').hidden,
      headHidden: document.getElementById('manage-head').hidden,
      cogShown: !document.getElementById('manage-open').hidden,
      footShown: !document.getElementById('foot').hidden,
      tabsActive: document.getElementById('view-tabs').classList.contains('is-active')
    };

    // Type a tab filter, then go and rummage in the rules.
    const search = document.getElementById('search');
    search.value = 'exam';
    search.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 450));

    __goManage('rules');
    await new Promise((r) => setTimeout(r, 450));
    const manage = {
      navShown: !document.getElementById('views').hidden,
      headShown: !document.getElementById('manage-head').hidden,
      cogHidden: document.getElementById('manage-open').hidden,
      footHidden: document.getElementById('foot').hidden,
      // The tab filter must NOT have followed us in.
      query: document.getElementById('search').value,
      tabsActive: document.getElementById('view-tabs').classList.contains('is-active')
    };

    // A filter typed here belongs to Rules alone.
    const s2 = document.getElementById('search');
    s2.value = 'trav';
    s2.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 400));

    __goManage('rewind');
    await new Promise((r) => setTimeout(r, 400));
    const rewindQuery = document.getElementById('search').value;

    __goManage('rules');
    await new Promise((r) => setTimeout(r, 400));
    const rulesQueryBack = document.getElementById('search').value;

    __goBrowse();
    await new Promise((r) => setTimeout(r, 500));
    const back = {
      query: document.getElementById('search').value,
      focused: document.activeElement === document.getElementById('manage-open'),
      tabsActive: document.getElementById('view-tabs').classList.contains('is-active'),
      footShown: !document.getElementById('foot').hidden
    };

    // Scroll position, separately: a filtered list may be too short to scroll
    // at all, and restoring 0 to 0 would prove nothing. Earlier tests close
    // tabs, so make our own rather than hoping enough survive.
    const s3 = document.getElementById('search');
    s3.value = '';
    s3.dispatchEvent(new Event('input'));
    const made = [];
    for (let i = 0; i < 10; i++) {
      made.push((await chrome.tabs.create({ url: `https://scroll${i}.example/`, active: false })).id);
    }
    await new Promise((r) => setTimeout(r, 900));
    const main = document.getElementById('main');
    main.scrollTop = Math.min(60, Math.max(0, main.scrollHeight - main.clientHeight));
    const scrolledTo = main.scrollTop;
    await new Promise((r) => setTimeout(r, 150));

    __goManage('spaces');
    await new Promise((r) => setTimeout(r, 400));
    __goBrowse();
    await new Promise((r) => setTimeout(r, 500));
    const scrollBack = document.getElementById('main').scrollTop;

    for (const id of made) await chrome.tabs.remove(id).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    return { browse, manage, rewindQuery, rulesQueryBack, back, scrolledTo, scrollBack };
  });
  check(shell.browse.navHidden && shell.browse.headHidden && shell.browse.cogShown &&
        shell.browse.footShown && shell.browse.tabsActive,
    'browsing shows the tab list, the footer and one cog — and no management nav',
    JSON.stringify(shell.browse));
  check(shell.manage.navShown && shell.manage.headShown && shell.manage.cogHidden &&
        shell.manage.footHidden && !shell.manage.tabsActive,
    'the cog swaps the whole shell: back arrow, section nav, no footer',
    JSON.stringify(shell.manage));
  check(shell.manage.query === '',
    'a tab filter does not follow you into management, where it would silently filter rules',
    `"${shell.manage.query}"`);
  check(shell.rewindQuery === '' && shell.rulesQueryBack === 'trav',
    'each management section keeps its own filter',
    `rewind="${shell.rewindQuery}" rules-again="${shell.rulesQueryBack}"`);
  check(shell.back.query === 'exam',
    'and going back restores the tab filter you left', `"${shell.back.query}"`);
  check(shell.scrolledTo > 0,
    'the tab list really can scroll, so the restore check means something',
    `${shell.scrolledTo}px`);
  check(shell.scrollBack === shell.scrolledTo,
    'and the scroll position survives a trip through management',
    `${shell.scrolledTo}px -> ${shell.scrollBack}px`);
  check(shell.back.focused,
    'focus lands back on the cog, so a keyboard user keeps their place');
  check(shell.back.tabsActive && shell.back.footShown,
    'and the tab list and footer are back', JSON.stringify(shell.back));

  await panel.setViewportSize({ width: 900, height: 900 });
  await panel.waitForTimeout(250);

  // --------------------------------------------------- the icon split (0.17)
  //
  // Two families, deliberately: the rich enamel tile is the extension's
  // identity in the management page and the store, but a full-bleed opaque
  // square reads as a sticker in a toolbar full of transparent glyphs. The
  // toolbar therefore gets a separately drawn flat mark with a real alpha
  // channel. Mixing them up is invisible until you look at the browser.
  const iconFiles = {
    action: manifest.action.default_icon,
    ext: manifest.icons
  };
  const missing = [];
  for (const map of Object.values(iconFiles)) {
    for (const rel of Object.values(map)) {
      if (!fs.existsSync(path.join(EXT, rel))) missing.push(rel);
    }
  }
  check(!missing.length, 'every icon the manifest names is actually present',
    missing.join(', '));
  check(Object.keys(iconFiles.action).join() === '16,32,48,128' &&
        Object.keys(iconFiles.ext).join() === '16,32,48,128',
    'both icon maps cover 16/32/48/128',
    JSON.stringify(Object.keys(iconFiles.action)));
  const shared = Object.values(iconFiles.action)
    .filter((f) => Object.values(iconFiles.ext).includes(f));
  check(!shared.length,
    'the toolbar and extension icons are different files, not one set reused',
    shared.join(', '));

  // Decoded in the extension's own context, which is the only place these URLs
  // resolve — and the only honest way to prove the alpha channel is real.
  const alpha = await panel.evaluate(async (maps) => {
    const read = async (rel) => {
      const img = new Image();
      img.src = chrome.runtime.getURL(rel);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let clear = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] === 0) clear++;
      return { w: c.width, h: c.height, clear, total: d.length / 4 };
    };
    const out = {};
    for (const [name, map] of Object.entries(maps)) {
      out[name] = {};
      for (const [size, rel] of Object.entries(map)) out[name][size] = await read(rel);
    }
    return out;
  }, iconFiles);

  const wrongSize = [];
  for (const [family, sizes] of Object.entries(alpha)) {
    for (const [size, m] of Object.entries(sizes)) {
      if (m.w !== Number(size) || m.h !== Number(size)) {
        wrongSize.push(`${family}/${size}=${m.w}x${m.h}`);
      }
    }
  }
  check(!wrongSize.length,
    'each icon is really the size its key claims — Chrome will not rescale for us',
    wrongSize.join(', '));

  const toolbarClear = Object.values(alpha.action).every((m) => m.clear > m.total * 0.05);
  const enamelOpaque = Object.values(alpha.ext).every((m) => m.clear === 0);
  check(toolbarClear,
    'the toolbar icons have a real transparent surround, so they sit among other glyphs',
    JSON.stringify(Object.fromEntries(
      Object.entries(alpha.action).map(([k, v]) => [k, `${v.clear}/${v.total} clear`]))));
  check(enamelOpaque,
    'the enamel tile stays fully opaque — the dark perimeter is its edge treatment',
    JSON.stringify(Object.fromEntries(
      Object.entries(alpha.ext).map(([k, v]) => [k, `${v.clear} clear`]))));

  // ----------------------------------------------------------- alarm exists
  const alarm = await panel.evaluate(() =>
    chrome.alarms.getAll().then((a) => a.map((x) => x.name)));
  check(alarm.includes('siderail-snapshot'), 'snapshot alarm scheduled', alarm.join(','));

  // ------------------------------------------------------ no stray requests
  check(panelErrors.length === 0, 'no JS errors during the run', panelErrors.slice(0, 3).join(' | '));

  await finish(ctx, userDataDir);
})();

async function finish(ctx, dir) {
  await ctx.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });

  const pass = results.filter((r) => r[0] === 'PASS').length;
  const fail = results.filter((r) => r[0] === 'FAIL').length;
  console.log('');
  for (const [status, name, detail] of results) {
    const mark = status === 'PASS' ? '  ok  ' : ' FAIL ';
    console.log(`${mark} ${name}${detail ? `  — ${detail}` : ''}`);
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
