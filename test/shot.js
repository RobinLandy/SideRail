// shot.js — renders the panel at real side-panel width for a visual check.
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

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navshot-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    executablePath: findBrowser(),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox']
  });

  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  const seed = [
    'https://example.com/', 'https://example.com/pricing', 'https://example.com/docs',
    'https://example.org/', 'https://example.org/research', 'https://example.org/research',
    'https://example.net/', 'https://iana.org/'
  ];
  for (const url of seed) {
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
  }

  // A rule to show off, mirroring the "Travel" example.
  const boot = await ctx.newPage();
  await boot.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  await boot.evaluate(() => chrome.storage.local.set({
    rules: [
      { id: 'travel', name: 'Travel', color: 'green', enabled: true,
        patterns: ['booking.com', 'easyjet.com', 'expedia.com', 'airbnb.co.uk'] },
      { id: 'research', name: 'Research', color: 'purple', enabled: true,
        patterns: ['example.org'] }
    ]
  }));
  await boot.close();

  const shots = {
    tabs: async (p) => {
      // Grouping moved off the footer into the window-actions menu in 0.17.
      await p.evaluate(async () => {
        const w = await chrome.windows.getCurrent();
        await chrome.runtime.sendMessage({ type: 'group-by-domain', windowId: w.id });
      });
      await p.waitForTimeout(900);
      await p.evaluate(async () => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const t = tabs.find((x) => /iana/.test(x.url));
        if (t) await chrome.tabs.update(t.id, { pinned: true });
      });
      await p.waitForTimeout(700);
    },
    rules: async (p) => {
      // Rules lives in the management shell now: cog, then the section.
      await p.click('#manage-open');
      await p.waitForTimeout(400);
      await p.click('.view-btn[data-view="rules"]');
      await p.waitForTimeout(500);
      await p.locator('#view-rules .rule-count').first().click();
      await p.waitForTimeout(300);
    },
    dedupe: async (p) => {
      // Always present since 0.17, but inert when there is nothing to dedupe.
      const btn = p.locator('#act-dedupe');
      if (await btn.isDisabled().catch(() => true)) return;
      await btn.click();
      await p.waitForTimeout(700);
    }
  };

  for (const scheme of ['light', 'dark']) {
    for (const [name, setup] of Object.entries(shots)) {
      const p = await ctx.newPage();
      await p.emulateMedia({ colorScheme: scheme });
      await p.setViewportSize({ width: 360, height: 700 });
      await p.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
      await p.waitForTimeout(700);
      await setup(p).catch(() => {});
      await p.screenshot({ path: path.join(EXT, `shot-${name}-${scheme}.png`) });
      await p.close();
    }
  }

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('screenshots written');
})();
