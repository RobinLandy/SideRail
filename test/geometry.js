// geometry.js — the vertical budget, asserted.
//
// The 0.17 redesign moves the everyday navigation around: it removes the
// persistent view row, enlarges the space switcher, and puts named captions
// above the pinned and jump layers. Every one of those changes costs height in
// the one place height is scarcest — above the first tab.
//
// The original contract was that the redesign must be NO TALLER than the build
// it replaced, measured from the top of the document to the first ordinary tab
// row. Those ceilings were measurements of 0.16.0, not aspirations:
//
//     250 px → 223 px      the narrow acceptance state
//     333 px → 206 px      the width the author actually runs
//     400 px → 175 px
//
// The redesign came in well under them — 192 px at both 250 and 333 — and the author
// then spent 12 px of that saving on deliberate breathing room: 4 px under the
// search field, 4 px above the pinned caption, 4 px above the jump caption.
// That is a choice, not a regression, so the ceilings below were RAISED to the
// measured result of that choice rather than the change being refused.
//
// What the test is for is unchanged: catching growth nobody asked for. Anything
// that pushes the list further down now has to come here and justify itself,
// which is exactly what happened.
//
// The ceilings hold at ANY rule count. That is the part worth pinning: the
// first draft of the redesign met them at exactly four groups and broke at
// five, and four is what the author has today. Hence the rule-count sweep, and hence
// the one-row invariant — the jump strip must never grow a second row, however
// many rules exist. It scrolls sideways instead.
//
// Run: CHROME_BIN=... node test/geometry.js

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.join(__dirname, '..');

/**
 * Ceiling on the height above the first tab, by panel width.
 *
 * Measured result of 0.17.0 plus 2px, which absorbs font-rendering variance
 * between machines without leaving room for a control to creep in.
 */
const CEILING = { 250: 211, 333: 211, 400: 179 };

/** Rule counts to sweep. 20 is well past anything sane, which is the point. */
const RULE_COUNTS = [0, 4, 5, 8, 20];

const PINS = 12;

const results = [];
const check = (ok, name, detail = '') => {
  results.push([ok ? 'PASS' : 'FAIL', name, detail]);
  return ok;
};

const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderail-geom-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: process.env.CHROME_BIN,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-sandbox',
      '--no-first-run'
    ],
    headless: false
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  if (!check(!!sw, 'service worker registered')) return finish(ctx, userDataDir);
  const extId = new URL(sw.url()).host;

  // A panel with something in it: 12 tabs that will be pinned, and one tab per
  // rule so that every rule actually produces a group to jump to. A rule with
  // no matching tab draws no chip, and would make the sweep vacuous.
  const most = Math.max(...RULE_COUNTS);
  for (let i = 0; i < PINS; i++) {
    const p = await ctx.newPage();
    await p.goto(`https://pin${i}.example/`).catch(() => {});
  }
  for (let i = 0; i < most; i++) {
    const p = await ctx.newPage();
    await p.goto(`https://grp${i}.example/page`).catch(() => {});
  }

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForTimeout(1500);

  const pinnedOk = await panel.evaluate(async (n) => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const mine = tabs.filter((t) => /^https:\/\/pin\d+\.example/.test(t.url));
    for (const t of mine.slice(0, n)) await chrome.tabs.update(t.id, { pinned: true });
    return (await chrome.tabs.query({ currentWindow: true, pinned: true })).length;
  }, PINS);
  check(pinnedOk === PINS, `${PINS} pinned tabs staged`, `${pinnedOk} pinned`);

  for (const count of RULE_COUNTS) {
    const rules = Array.from({ length: count }, (_, i) => ({
      id: `g${i}`,
      // Deliberately long: a name that ellipsizes must not widen the row, and a
      // pill that grows to fit its text is the other way this budget is blown.
      name: `Group Number ${i} With A Long Name`,
      color: COLORS[i % COLORS.length],
      enabled: true,
      patterns: [`grp${i}.example`]
    }));

    await panel.evaluate(async (r) => {
      await chrome.storage.local.set({ rules: r, groupOrder: [] });
      const w = await chrome.windows.getCurrent();
      await chrome.runtime.sendMessage({ type: 'ungroup-all', windowId: w.id }).catch(() => {});
      await chrome.runtime.sendMessage({ type: 'apply-rules', windowId: w.id }).catch(() => {});
    }, rules);
    await panel.waitForTimeout(1400);

    for (const width of Object.keys(CEILING).map(Number)) {
      await panel.setViewportSize({ width, height: 900 });
      await panel.waitForTimeout(500);

      const m = await panel.evaluate(() => {
        // Scroll to the top first: the sticky header overlaps the list once you
        // scroll, and a mid-scroll measurement would flatter the result.
        const main = document.querySelector('#main');
        main.scrollTop = 0;

        // The boundary is the first piece of CONTENT — an ordinary tab row, or
        // a group's wrapper. The sticky header lives inside #view-tabs too, so
        // "first child" would measure the header's own top and always pass.
        const first = document.querySelector('#view-tabs .tab-row, #view-tabs .group');

        // Only chips that are actually drawn. A hidden one has a zero-size
        // rect, and counting those as a row at y=0 would report two rows for a
        // strip that plainly has one.
        const all = [...document.querySelectorAll('.gjump')];
        const visible = all.filter((b) => b.getBoundingClientRect().height > 0);
        const rows = new Set(visible.map((b) => Math.round(b.getBoundingClientRect().top)));
        const list = document.querySelector('.gjump-list');
        return {
          docWidth: document.documentElement.clientWidth,
          preTab: first ? Math.round(first.getBoundingClientRect().top) : null,
          jumpCount: all.length,
          shownCount: visible.length,
          jumpRows: rows.size,
          // What doesn't fit scrolls, so the row is "complete" when every chip
          // is laid out on it — reachable by scrolling, not hidden.
          scrolls: !!list && list.scrollWidth > list.clientWidth + 1,
          canScroll: !!list && getComputedStyle(list).overflowX === 'auto',
          overflowX: document.documentElement.scrollWidth >
                     document.documentElement.clientWidth + 1
        };
      });

      const ceiling = CEILING[width];
      const label = `${width}px · ${count} rule${count === 1 ? '' : 's'}`;

      check(m.docWidth === width, `${label}: viewport really is ${width}px`, `${m.docWidth}px`);
      check(m.preTab !== null && m.preTab <= ceiling,
        `${label}: chrome above the first tab is within ${ceiling}px`,
        `${m.preTab}px`);
      check(!m.overflowX, `${label}: nothing overflows horizontally`);

      // The invariant that matters as rules accumulate. Zero rules means zero
      // chips, which is one "row" of nothing — not a failure.
      check(m.jumpRows <= 1,
        `${label}: the group-jump strip stays on one row`,
        `${m.shownCount}/${m.jumpCount} chips over ${m.jumpRows} row(s)`);

      // ...and the cap must not be achieved by dropping groups. Every chip
      // stays on the row; the ones past the edge are reached by scrolling it,
      // the same gesture as the space switcher above.
      if (count > 0) {
        check(m.shownCount === m.jumpCount,
          `${label}: every group keeps a shortcut — none are hidden`,
          `${m.shownCount}/${m.jumpCount}`);
        check(m.canScroll,
          `${label}: the strip scrolls sideways rather than wrapping`);
      }
    }
  }

  // The spec's headline narrow-width promise, with names of the length people
  // actually use rather than the deliberately hostile ones swept above.
  const REAL = ['Youtube', 'LinkedIn', 'Github', 'Travel'];
  await panel.evaluate(async (names) => {
    await chrome.storage.local.set({
      rules: names.map((n, i) => ({
        id: `real${i}`, name: n, color: 'blue', enabled: true,
        patterns: [`grp${i}.example`]
      })),
      groupOrder: []
    });
    const w = await chrome.windows.getCurrent();
    await chrome.runtime.sendMessage({ type: 'ungroup-all', windowId: w.id }).catch(() => {});
    await chrome.runtime.sendMessage({ type: 'apply-rules', windowId: w.id }).catch(() => {});
  }, REAL);
  await panel.waitForTimeout(1400);

  await panel.setViewportSize({ width: 250, height: 900 });
  await panel.waitForTimeout(500);
  const narrow = await panel.evaluate(() => {
    const chips = [...document.querySelectorAll('.gjump')]
      .filter((b) => b.getBoundingClientRect().height > 0);
    return {
      shown: chips.length,
      names: chips.map((b) => b.querySelector('.gname').textContent),
      // Ellipsised names must still be recoverable.
      titled: chips.every((b) => (b.title || '').length > 0),
      rows: new Set(chips.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      widths: chips.map((b) => Math.round(b.getBoundingClientRect().width)),
      // A pill squeezed to its 54px floor has lost its name; one sized to its
      // text has not. Anything above the floor means no shrinking happened.
      readable: chips.every((b) => b.getBoundingClientRect().width > 55)
    };
  });
  check(narrow.shown === 4 && narrow.rows === 1,
    '250px: four real-world group names sit on one row, scrollable, none dropped',
    JSON.stringify(narrow));
  check(narrow.readable,
    'and each pill is wide enough to read its name rather than squeezed to a stub',
    JSON.stringify(narrow.widths));
  check(JSON.stringify(narrow.names) === JSON.stringify(REAL),
    'and they are the rules’ actual names, not initials',
    JSON.stringify(narrow.names));
  check(narrow.titled,
    'every pill keeps its full name in a tooltip, whatever the ellipsis does');

  // ------------------------------------------------------- text scaling
  //
  // Two independent knobs, both of which make text bigger without making the
  // panel wider — which is the direction that breaks layouts.
  //
  //   • SideRail's own title size, at its maximum, with wrapping on. This is
  //     the one users actually reach for, and the one that makes rows taller.
  //   • Browser zoom. The panel's CSS is in px, so zoom shrinks the panel in
  //     CSS pixels rather than growing the text — 333 device px at 1.5 is 222
  //     CSS px, narrower than the 250 acceptance state.
  //
  // Neither may produce overlapping rows, a wrapped footer, a wrapped space
  // switcher or horizontal overflow.
  await panel.evaluate(async () => {
    const s = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...s, titleSize: 18, wrapTitles: true } });
  });
  await panel.waitForTimeout(600);

  for (const [width, zoom] of [[333, 1], [333, 1.25], [333, 1.5], [250, 1.25]]) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
    await panel.waitForTimeout(500);

    const m = await panel.evaluate(() => {
      const rows = [...document.querySelectorAll('#view-tabs .tab-row')]
        .map((r) => r.getBoundingClientRect());
      let overlap = 0;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].top < rows[i - 1].bottom - 0.5) overlap++;
      }
      const rowsOf = (sel) => {
        const items = [...document.querySelectorAll(sel)]
          .filter((n) => n.getBoundingClientRect().height > 0);
        return new Set(items.map((n) => Math.round(n.getBoundingClientRect().top))).size;
      };
      // A title that wraps must still stop at two lines, and must not run under
      // the close button on its right.
      const title = document.querySelector('#view-tabs .tab-row .title');
      const close = document.querySelector('#view-tabs .tab-row .close');
      const collide = title && close &&
        title.getBoundingClientRect().right > close.getBoundingClientRect().left + 0.5;
      return {
        rowCount: rows.length,
        hasClose: !!close,
        overlap,
        footRows: rowsOf('#foot .foot-btn'),
        spaceRows: rowsOf('.schip'),
        jumpRows: rowsOf('.gjump'),
        collide: !!collide,
        overflowX: document.documentElement.scrollWidth >
                   document.documentElement.clientWidth + 1
      };
    });

    const label = `${width}px @ ${Math.round(zoom * 100)}% · 18px titles, wrapping on`;
    // Guard against the whole block passing because there was nothing to check.
    check(m.rowCount >= 3 && m.hasClose,
      `${label}: there are rows with close buttons to measure`,
      `${m.rowCount} rows, close=${m.hasClose}`);
    check(m.overlap === 0, `${label}: no tab row overlaps the one above it`,
      `${m.overlap} overlaps`);
    check(m.footRows <= 1, `${label}: the footer stays on one row`, `${m.footRows} rows`);
    check(m.spaceRows <= 1, `${label}: the space switcher stays on one row`,
      `${m.spaceRows} rows`);
    check(m.jumpRows <= 1, `${label}: the jump strip stays on one row`, `${m.jumpRows} rows`);
    check(!m.collide, `${label}: a wrapped title does not run under the close button`);
    check(!m.overflowX, `${label}: nothing overflows horizontally`);
  }

  await panel.evaluate(() => { document.documentElement.style.zoom = '1'; });

  await finish(ctx, userDataDir);
})();

async function finish(ctx, dir) {
  await ctx.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });

  const pass = results.filter((r) => r[0] === 'PASS').length;
  const fail = results.filter((r) => r[0] === 'FAIL').length;
  console.log('');
  for (const [status, name, detail] of results) {
    console.log(`${status === 'PASS' ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
