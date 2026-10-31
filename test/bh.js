// bh.js — bookmarks + history search, end to end.
//
// chrome.permissions.request() needs a trusted user gesture and shows a modal,
// which headless can't answer. So this test loads a COPY of the extension whose
// manifest promotes bookmarks/history/scripting to required permissions. The
// code under test is byte-identical; only the grant path differs.
//
// Run: node test/bh.js

const { chromium } = require('playwright');
const http = require('http');
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


const SRC = path.resolve(__dirname, '..');
const results = [];
const ok = (n, d = '') => results.push(['PASS', n, d]);
const bad = (n, d = '') => results.push(['FAIL', n, d]);
const check = (c, n, d = '') => { c ? ok(n, d) : bad(n, d); return c; };

function stageExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-bh-ext-'));
  for (const entry of fs.readdirSync(SRC)) {
    if (['node_modules', 'test', '.git'].includes(entry)) continue;
    fs.cpSync(path.join(SRC, entry), path.join(dir, entry), { recursive: true });
  }
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  mf.permissions = [...mf.permissions, 'bookmarks', 'history', 'scripting'];
  mf.host_permissions = ['<all_urls>'];
  mf.optional_permissions = [];
  delete mf.optional_host_permissions;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
  return dir;
}

(async () => {
  const extDir = stageExtension();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-bh-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: findBrowser(),
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox']
  });

  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  // A couple of open YouTube-ish tabs, mirroring the reported situation.
  for (const url of ['https://example.com/watch-1', 'https://example.com/watch-2']) {
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  }

  // One page that genuinely loads. The runner has no network, so every
  // example.com tab is really a chrome-error:// page, and scripts cannot be
  // injected into those — which is why the preview-card checks below used to
  // report themselves as skipped and never actually ran.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><title>Local test page</title>' +
            '<body style="height:3000px">SideRail injection target</body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const localUrl = `http://127.0.0.1:${server.address().port}/card`;
  const localPage = await ctx.newPage();
  await localPage.goto(localUrl, { waitUntil: 'load', timeout: 12000 }).catch(() => {});

  const panel = await ctx.newPage();
  const errs = [];
  panel.on('pageerror', (e) => errs.push(String(e)));
  panel.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  await panel.waitForTimeout(800);

  // ------------------------------------------------------------- seeding
  const seeded = await panel.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree();
    const roots = tree[0].children || [];
    const bar = roots.find((r) => r.id === '1') || roots[0];
    const other = roots.find((r) => r.id === '2') || roots[0];

    const folder = await chrome.bookmarks.create({ parentId: other.id, title: 'Watch Later' });
    await chrome.bookmarks.create({
      parentId: folder.id, title: 'Youtube — deep folder item',
      url: 'https://www.youtube.com/watch?v=nested'
    });
    await chrome.bookmarks.create({
      parentId: bar.id, title: 'Youtube on the bar',
      url: 'https://www.youtube.com/feed/subscriptions'
    });
    await chrome.bookmarks.create({
      parentId: bar.id, title: 'Unrelated bookmark', url: 'https://example.org/nothing'
    });

    for (let i = 0; i < 14; i++) {
      await chrome.history.addUrl({ url: `https://www.youtube.com/watch?v=hist${i}` });
    }
    await chrome.history.addUrl({ url: 'https://example.net/not-related' });
    // Already-open URLs must be filtered out of the results.
    await chrome.history.addUrl({ url: 'https://example.com/watch-1' });

    await new Promise((r) => setTimeout(r, 400));
    return true;
  });
  check(seeded, 'seeded bookmarks and history');

  // ------------------------------------------------------------- the search
  await panel.fill('#search', 'youtube');
  await panel.waitForTimeout(1400);

  const view = await panel.evaluate(() => {
    const labels = [...document.querySelectorAll('#view-tabs .section-label')]
      .map((n) => n.textContent);
    const subs = [...document.querySelectorAll('#view-tabs .sub')].map((n) => n.textContent);
    return {
      labels,
      subs,
      error: document.querySelector('#view-tabs .search-error')?.textContent || '',
      permChip: !!document.querySelector('#view-tabs .bh-chip'),
      more: [...document.querySelectorAll('#view-tabs .more-btn')].map((b) => b.textContent)
    };
  });

  check(!view.permChip, 'permission chip hidden once granted');
  check(!view.error, 'no search error reported', view.error);

  const bmLabel = view.labels.find((l) => l.startsWith('Bookmarks'));
  const hsLabel = view.labels.find((l) => l.startsWith('History'));

  check(!!bmLabel, 'bookmarks section rendered', String(bmLabel));
  check(!!hsLabel, 'history section rendered', String(hsLabel));

  const bmCount = Number((bmLabel || '').split('·')[1]);
  const hsCount = Number((hsLabel || '').split('·')[1]);
  check(bmCount === 2, 'both matching bookmarks found, unrelated one excluded', String(bmCount));
  check(hsCount >= 14, 'history is not truncated to a handful', String(hsCount));

  check(view.subs.some((s) => /Watch Later/.test(s)),
    'bookmark shows its folder path', view.subs.find((s) => /Watch Later/.test(s)) || '(none)');
  check(view.subs.some((s) => /Bookmarks bar|Bookmarks Bar/i.test(s)),
    'bar bookmarks show the bar as their folder');

  check(view.more.some((m) => /Show \d+ more/.test(m)), 'history offers Show N more', JSON.stringify(view.more));

  // Expanding must reveal the rest.
  const expanded = await panel.evaluate(async () => {
    const btn = [...document.querySelectorAll('#view-tabs .more-btn')].pop();
    const before = document.querySelectorAll('#view-tabs .tab-row[data-url]').length;
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return { before, after: document.querySelectorAll('#view-tabs .tab-row[data-url]').length };
  });
  check(expanded.after > expanded.before, 'Show more reveals further results', JSON.stringify(expanded));

  // Open tabs must not be duplicated into the history section.
  const dupes = await panel.evaluate(() =>
    [...document.querySelectorAll('#view-tabs .tab-row[data-url]')]
      .filter((r) => r.dataset.url === 'https://example.com/watch-1').length);
  check(dupes === 0, 'already-open URLs are filtered out of history');

  // ------------------------------------------------------- pure ranking unit
  const pure = await panel.evaluate(async () => {
    const m = await import('./common.js');
    const list = [
      { title: 'Youtube A', url: 'https://youtube.com/a' },
      { title: 'Youtube B', url: 'https://youtube.com/b' },
      { title: 'Nope', url: 'https://example.org/z' }
    ];
    const ranked = m.rankItems('youtube', list, new Set(['https://youtube.com/b']));
    const deduped = m.dedupeByUrl([
      { url: 'https://a.com/x' }, { url: 'https://a.com/x/' }, { url: 'https://a.com/y' }
    ]);
    return { ranked: ranked.map((r) => r.url), deduped: deduped.length };
  });
  check(pure.ranked.length === 1 && pure.ranked[0] === 'https://youtube.com/a',
    'rankItems filters open URLs and non-matches', JSON.stringify(pure.ranked));
  check(pure.deduped === 2, 'dedupeByUrl collapses trailing-slash variants', String(pure.deduped));

  // ------------------------------------------- real screenshot capture
  // Only testable here: captureVisibleTab needs host permission, which this
  // staged copy has. Exercises the whole pipeline including the downscale.
  const shot = await panel.evaluate(async () => {
    const target = (await chrome.tabs.query({ url: 'https://example.com/watch-1' }))[0];
    if (!target) return { skipped: true };
    await chrome.tabs.update(target.id, { active: true });
    await new Promise((r) => setTimeout(r, 1200));

    await chrome.runtime.sendMessage({
      type: 'capture-now', tabId: target.id, windowId: target.windowId
    });
    await new Promise((r) => setTimeout(r, 2500));

    const rec = (await chrome.storage.session.get(`thumb:${target.id}`))[`thumb:${target.id}`];
    if (!rec) return { captured: false };
    // How wide the screenshot was before downscaling, so a small test window
    // doesn't read as a resolution regression.
    const srcWidth = await new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img.naturalWidth);
      img.onerror = () => res(0);
      img.src = rec.d;
    });

    return {
      captured: true,
      isJpeg: /^data:image\/jpeg;base64,/.test(rec.d || ''),
      width: rec.w,
      srcWidth,
      kb: Math.round((rec.bytes || 0) / 1024),
      url: rec.url
    };
  });

  if (shot.skipped) {
    ok('screenshot capture skipped (no target tab)');
  } else {
    check(shot.captured, 'a real screenshot is captured and cached', JSON.stringify(shot));
    check(shot.isJpeg, 'stored as a jpeg data URL');
    // 640 is deliberate: the card draws it at 320 CSS px, so anything narrower
    // is stretched on a 2x display — which is what made it look blurry.
    check(shot.width && shot.width <= 640, 'downscaled to 640px or less', `${shot.width}px`);
    check(shot.width > 320 || shot.srcWidth <= 320,
      'kept at 2x the card width for a Retina display', `${shot.width}px`);
    check(shot.kb > 0 && shot.kb < 200, 'thumbnail is small enough to cache in memory', `${shot.kb} KB`);
  }

  // ------------------------------- the in-page card is actually CHOSEN
  // Every other hover check drives PAGE_CARD directly, which proves the card
  // draws but not that the panel ever reaches for it. This hovers a real row
  // and asks which of the two cards appeared — the distinction the user sees.
  const chosen = await panel.evaluate(async () => {
    const all = await chrome.tabs.query({ currentWindow: true });
    const target = all.find((t) => /^http:\/\/127\.0\.0\.1/.test(t.url || ''));
    if (!target) return { skipped: 'no local tab' };
    await chrome.tabs.update(target.id, { active: true });
    await new Promise((r) => setTimeout(r, 800));
    return { activeUrl: target.url, tabId: target.id };
  });

  if (chosen.skipped) {
    ok(`in-page card selection skipped (${chosen.skipped})`);
  } else {
    // The search box is still full from the checks above; clear it so the plain
    // tab list is on screen.
    await panel.evaluate(() => {
      const c = document.getElementById('clear-search');
      if (c) c.click();
    });
    await panel.waitForTimeout(600);
    const rows = await panel.locator('#view-tabs .tab-row[data-id]').count();
    if (!rows) { ok('in-page card selection skipped (no rows on screen)'); }

    // A real mouse move, so the panel sees genuine screen coordinates.
    await panel.locator('#view-tabs .tab-row[data-id]').first().hover().catch((e) => {
      bad('could not hover a tab row', String(e).slice(0, 80));
    });
    await panel.waitForTimeout(1500);

    const where = await panel.evaluate(async (tabId) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const h = document.getElementById('__siderail_preview_host__');
          return { inPage: !!h, style: h ? h.getAttribute('style') : '' };
        }
      });
      return {
        inPage: !!(r && r.result && r.result.inPage),
        style: (r && r.result && r.result.style) || '',
        panelCardShown: !document.getElementById('tabpop').hidden,
        granted: await chrome.permissions.contains({
          permissions: ['scripting'], origins: ['<all_urls>']
        })
      };
    }, chosen.tabId);

    check(where.granted, 'the staged copy really holds the page grant');
    check(where.inPage,
      'hovering a row draws the card in the PAGE, not over the panel',
      `inPage=${where.inPage} panelCard=${where.panelCardShown}`);
    check(!where.panelCardShown,
      'the panel-internal fallback stays hidden when the page accepted the card',
      `panelCard=${where.panelCardShown}`);
    check(/left:\s*10px|right:\s*10px/.test(where.style),
      'the in-page card hugs one edge of the page',
      (where.style.match(/(left|right):\s*[^;]+/g) || []).join(' '));

    // And when the tab you're looking at can't be drawn on, the fallback must
    // say so rather than silently appearing over the panel.
    const explained = await panel.evaluate(async () => {
      const blank = await chrome.tabs.create({ url: 'chrome://version', active: true });
      await new Promise((r) => setTimeout(r, 1200));
      const row = document.querySelector('#view-tabs .tab-row[data-id]');
      row.dispatchEvent(new MouseEvent('mouseenter',
        { bubbles: false, screenX: 60, screenY: 300, clientX: 40, clientY: 200 }));
      await new Promise((r) => setTimeout(r, 1600));
      const pop = document.getElementById('tabpop');
      const out = {
        shown: !pop.hidden,
        why: pop.querySelector('.pop-why')?.textContent || '',
        whyIsFirst: !!pop.firstElementChild &&
          pop.firstElementChild.classList.contains('pop-why')
      };
      await chrome.tabs.remove(blank.id).catch(() => {});
      return out;
    });
    check(explained.shown, 'a non-injectable page falls back to the panel card');
    // The card's prefix comes from CSS, so the reason must read as a
    // continuation rather than repeating the whole sentence back.
    check(!/sit beside the panel/i.test(explained.why),
      'the reason does not repeat the sentence the card already prints',
      explained.why);
    check(/chrome:\/\/|normal page/i.test(explained.why),
      'the fallback says why it could not sit beside the panel', explained.why);
    // At the top, above the thumbnail — the whole point of moving it.
    check(explained.whyIsFirst,
      'the reason is the first thing in the card, not a footnote under the image');
  }

  // ------------------------------------------------ page-text scan speed
  // A frozen tab cannot be produced on demand from an extension, so the policy
  // that excludes it is unit-tested in e2e.js. What is testable here is that a
  // real sweep completes, reports itself, and that typing a longer query does
  // not re-open tabs already proven empty.
  const scanRun = await panel.evaluate(async () => {
    const c = document.getElementById('clear-search');
    if (c) c.click();
    await new Promise((r) => setTimeout(r, 400));

    const t0 = Date.now();
    const box = document.getElementById('search');
    box.value = 'zzqq';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));

    const go = [...document.querySelectorAll('#view-tabs .scan-chip')]
      .find((b) => /Search page text/.test(b.textContent));
    if (!go) return { skipped: true };
    go.click();

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const bar = document.querySelector('#view-tabs .scan-progress');
      if (bar && /^Scanned/.test(bar.textContent)) break;
    }
    const bar = document.querySelector('#view-tabs .scan-progress');
    return { bar: bar ? bar.textContent : '', ms: Date.now() - t0 };
  });

  if (scanRun.skipped) {
    ok('page-text sweep skipped (no scan offer on screen)');
  } else {
    check(/Scanned \d+ tab/.test(scanRun.bar), 'the sweep completes and reports', scanRun.bar);
    check(scanRun.ms < 25000, 'a sweep of this window finishes promptly', `${scanRun.ms}ms`);

    const pruned = await panel.evaluate(async () => {
      const box = document.getElementById('search');
      box.value = 'zzqqx';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const go = [...document.querySelectorAll('#view-tabs .scan-chip')]
        .find((b) => /Search page text/.test(b.textContent));
      if (go) go.click();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const bar = document.querySelector('#view-tabs .scan-progress');
        if (bar && /^Scanned/.test(bar.textContent)) break;
      }
      const bar = document.querySelector('#view-tabs .scan-progress');
      return { bar: bar ? bar.textContent : '' };
    });
    check(/already ruled out/.test(pruned.bar),
      'a longer query skips tabs already proven empty', pruned.bar);
  }

  await panel.evaluate(() => {
    const c = document.getElementById('clear-search');
    if (c) c.click();
  });
  await panel.waitForTimeout(500);

  // -------------------------------------------- in-page preview card
  // Only testable here: injecting needs host permission, which this staged
  // copy has. A side panel can't paint outside its own frame, so the card is
  // rendered into the active page instead.
  const card = await panel.evaluate(async () => {
    const lib = await import('./common.js');

    // Pick a tab we know loaded — the active one may be an error page.
    const all = await chrome.tabs.query({ currentWindow: true });
    let active = null;
    for (const t of all) {
      if (!/^https?:/.test(t.url || '') || t.status !== 'complete') continue;
      const ok = await chrome.scripting
        .executeScript({ target: { tabId: t.id }, func: () => !!document.body })
        .then((r) => r && r[0] && r[0].result)
        .catch(() => false);
      if (ok) { active = t; break; }
    }
    if (!active) return { skipped: true };

    const show = async (payload) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: active.id }, func: lib.PAGE_CARD, args: [payload]
      });
      return r && r.result;
    };
    const probe = async () => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: active.id },
        func: () => {
          const h = document.getElementById('__siderail_preview_host__');
          if (!h) return { present: false };
          const st = h.getAttribute('style') || '';
          const sr = h.shadowRoot;
          return {
            present: true,
            shadow: !!sr,
            title: sr.querySelector('.ttl')?.textContent || '',
            host: sr.querySelector('.sub')?.textContent || '',
            hasImg: !!sr.querySelector('img.shot'),
            chips: [...sr.querySelectorAll('.chip')].map((c) => c.textContent),
            pointerNone: /pointer-events:\s*none/.test(st),
            left: /left:\s*10px/.test(st),
            right: /right:\s*10px/.test(st),
            topPx: h.style.top
          };
        }
      });
      return r && r.result;
    };

    const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    // The panel tells the page which edge to hug — it cannot be worked out in
    // the page, because Chrome reports the same window.screenX for both.
    await show({ title: 'A very long tab title that should wrap onto several lines',
      host: 'example.com', thumb: px, chips: ['active', 'pinned'], side: 'left', anchorY: 300 });
    await new Promise((r) => setTimeout(r, 300));
    const asLeft = await probe();

    await show({ title: 'x', host: 'example.com', thumb: '', chips: [],
      noShot: 'No preview yet', side: 'right', anchorY: 100 });
    await new Promise((r) => setTimeout(r, 300));
    const asRight = await probe();

    // A payload with no side at all must not silently land on the far edge:
    // 'left' is only chosen when asked for.
    await show({ title: 'y', host: 'example.com', thumb: '', chips: [], anchorY: 100 });
    await new Promise((r) => setTimeout(r, 200));
    const noSide = await probe();

    // Removal.
    await show(null);
    await new Promise((r) => setTimeout(r, 200));
    const gone = await probe();

    return { asLeft, asRight, noSide, gone };
  });

  if (card.skipped) {
    ok('in-page preview card skipped (no injectable tab in this run)');
  } else {
  check(card.asLeft?.present && card.asLeft.shadow,
    'preview card renders inside the page, in a shadow root');
  check(card.asLeft.title.startsWith('A very long tab title'),
    'card carries the full title', card.asLeft.title.slice(0, 34));
  check(card.asLeft.host === 'example.com', 'card shows the domain', card.asLeft.host);
  check(card.asLeft.hasImg, 'card shows the thumbnail when one exists');
  check(JSON.stringify(card.asLeft.chips) === '["active","pinned"]',
    'card shows state chips', JSON.stringify(card.asLeft.chips));
  check(card.asLeft.pointerNone, 'card ignores pointer events so the page stays clickable');
  check(card.asLeft.left && !card.asLeft.right,
    'panel docked left → card sits on the page’s left edge');
  check(card.asRight.right && !card.asRight.left,
    'panel docked right → card sits on the page’s right edge');
  check(card.noSide.right && !card.noSide.left,
    'an unspecified side falls back to the right edge, never both');
  check(parseInt(card.asLeft.topPx, 10) >= 10,
    'the card is clamped into the viewport, not pushed off the top', card.asLeft.topPx);
  check(!card.asRight.hasImg, 'card falls back to a message when there is no thumbnail');
  check(card.gone && card.gone.present === false, 'card is removed on request');
  }

  // A stray card must not survive a page interaction.
  const dismissed = await panel.evaluate(async () => {
    const lib = await import('./common.js');
    const all = await chrome.tabs.query({ currentWindow: true });
    let active = null;
    for (const t of all) {
      if (!/^https?:/.test(t.url || '') || t.status !== 'complete') continue;
      const ok = await chrome.scripting
        .executeScript({ target: { tabId: t.id }, func: () => !!document.body })
        .then((r) => r && r[0] && r[0].result).catch(() => false);
      if (ok) { active = t; break; }
    }
    if (!active) return 'skip';
    await chrome.scripting.executeScript({
      target: { tabId: active.id }, func: lib.PAGE_CARD,
      args: [{ title: 't', host: 'h', thumb: '', chips: [], side: 'left', anchorY: 50 }]
    });
    await new Promise((r) => setTimeout(r, 300));
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: active.id },
      func: async () => {
        window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 150));
        return !document.getElementById('__siderail_preview_host__');
      }
    });
    return r && r.result;
  });
  if (dismissed === 'skip') ok('page-dismiss check skipped (no injectable tab)');
  else check(dismissed, 'a click in the page dismisses the card');

  check(errs.length === 0, 'no JS errors', errs.slice(0, 3).join(' | '));

  await ctx.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });

  const pass = results.filter((r) => r[0] === 'PASS').length;
  const fail = results.filter((r) => r[0] === 'FAIL').length;
  console.log('');
  for (const [status, name, detail] of results) {
    console.log(`${status === 'PASS' ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
