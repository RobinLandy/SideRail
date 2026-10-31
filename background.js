// background.js — SideRail service worker.
// Owns keyboard commands, the snapshot timer, and the bulk tab operations.

import {
  NONE, MAX_SNAPSHOTS, SNAPSHOT_ALARM,
  domainOf, isSaveable, normUrl, colorFor, uid, duplicateGroups,
  getStore, setStore, captureWindow, applyRules, activeRules, planFiling,
  readMembership, writeMembership
} from './common.js';

/* --------------------------------------------------------- error stamping */

// Same reasoning as in the panel: stamp the version so a stale entry in
// chrome://extensions is distinguishable from a fresh one.
const VERSION = chrome.runtime.getManifest().version;
self.addEventListener('error', (e) => {
  console.error(`[SideRail v${VERSION} sw] ${e.message} @ ${e.filename}:${e.lineno}`);
});
self.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  console.error(`[SideRail v${VERSION} sw] unhandled rejection: ${(r && r.stack) || r}`);
});

/* ------------------------------------------------------------- lifecycle */

function ensureAlarm() {
  chrome.alarms.get(SNAPSHOT_ALARM, (a) => {
    if (!a) chrome.alarms.create(SNAPSHOT_ALARM, { periodInMinutes: 5, delayInMinutes: 5 });
  });
}

function ensurePanelBehavior() {
  // Clicking the toolbar icon toggles the panel open/closed.
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => { ensurePanelBehavior(); ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensurePanelBehavior(); ensureAlarm(); });
ensurePanelBehavior();
ensureAlarm();

/* -------------------------------------------------------------- commands */

async function currentWindowId(tab) {
  if (tab && tab.windowId !== undefined) return tab.windowId;
  const w = await chrome.windows.getCurrent();
  return w.id;
}

/**
 * `sidePanel.open()` needs a user gesture, and the gesture does not survive an
 * `await`.
 *
 * The listener used to be `async` and awaited `currentWindowId(tab)` first.
 * That resolves instantly when the tab already carries a windowId — but it
 * still yields a microtask, which is enough for Chrome to decide the gesture is
 * spent. The panel then silently refused to open and the shortcut did nothing
 * at all, with no error anywhere the user could see.
 *
 * So: open FIRST, synchronously, straight off the event. Everything that can
 * wait, waits.
 *
 * @see https://issues.chromium.org/issues/344767733
 */
chrome.commands.onCommand.addListener((command, tab) => {
  const wants = command === 'open-panel';
  if (wants && tab && tab.windowId !== undefined) {
    // No await before this line, and no await inside it.
    chrome.sidePanel.open({ windowId: tab.windowId })
      .catch((e) => console.warn('[SideRail] sidePanel.open refused', e));
  }
  runCommand(command, tab).catch((e) =>
    console.warn('[SideRail] command failed', command, e));
});

async function runCommand(command, tab) {
  const windowId = await currentWindowId(tab);
  switch (command) {
    case 'open-panel':
      // Fallback for the rare case the synchronous path had no windowId.
      if (!tab || tab.windowId === undefined) {
        await chrome.sidePanel.open({ windowId }).catch(() => {});
      }
      break;
    case 'group-by-domain':
      await groupByDomain(windowId);
      break;
    case 'ungroup-all':
      await ungroupAll(windowId);
      break;
  }
}

/* --------------------------------------------------------------- actions */

/**
 * Group currently-ungrouped tabs by domain. Existing groups are left alone;
 * if a group already carries the domain as its title we merge into it rather
 * than creating a duplicate.
 */
export async function groupByDomain(windowId) {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId, pinned: false }),
    chrome.tabGroups.query({ windowId })
  ]);

  const existing = new Map();
  for (const g of groups) if (g.title) existing.set(g.title.toLowerCase(), g.id);

  const buckets = new Map();
  for (const t of tabs) {
    if (t.groupId !== NONE) continue; // don't disturb manual groups
    const d = domainOf(t.url);
    if (!d) continue;
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(t.id);
  }

  let grouped = 0;
  for (const [domain, ids] of buckets) {
    const target = existing.get(domain.toLowerCase());
    if (!target && ids.length < 2) continue; // a lone tab isn't worth a group
    try {
      if (target) {
        await chrome.tabs.group({ tabIds: ids, groupId: target });
      } else {
        const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
        await chrome.tabGroups.update(gid, { title: domain, color: colorFor(domain) });
      }
      grouped += ids.length;
    } catch (e) {
      console.warn('[SideRail] group failed for', domain, e);
    }
  }
  return grouped;
}

export async function ungroupAll(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const ids = tabs.filter((t) => t.groupId !== NONE).map((t) => t.id);
  if (ids.length) await chrome.tabs.ungroup(ids).catch(() => {});
  return ids.length;
}

/**
 * Report duplicate tabs for review. This deliberately closes nothing — the
 * panel shows the list and the user decides.
 *
 * Returns [{ key, url, tabs: [{id,title,url,active,index,keep}] }], where the
 * suggested keeper is the active tab if there is one, else the leftmost.
 */
export async function findDuplicates(windowId) {
  const tabs = await chrome.tabs.query(windowId ? { windowId } : {});
  return duplicateGroups(tabs);
}

/* ------------------------------------------------------------ thumbnails */

// captureVisibleTab can only photograph the ACTIVE tab — there is no API for
// background tabs. So each tab is snapshotted as you visit it and the image is
// cached, keyed by tab id.
//
// The cache lives in chrome.storage.session: memory-backed, wiped on browser
// restart, so thumbnails of your browsing never touch disk. It tidies itself
// three ways — one record per tab (overwritten in place), removal when a tab
// closes or navigates, and an LRU cap.

const THUMB_PREFIX = 'thumb:';
const THUMB_MAX = 50;       // newest N kept; the rest are dropped
const THUMB_WIDTH = 640;    // 2x the 320px card, so it stays sharp on a Retina display
const THUMB_QUALITY = 0.78;
const THUMB_BUDGET = 4_500_000; // bytes; storage.session's quota is 10MB
const CAPTURE_GAP_MS = 900; // captureVisibleTab is rate-limited by Chrome

let lastCapture = 0;
let captureTimer = null;

const thumbKey = (tabId) => `${THUMB_PREFIX}${tabId}`;

async function mayCapture() {
  return chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
}

/**
 * Downscale a full-size screenshot to something worth keeping in memory.
 *
 * The card draws this at 320 CSS px, so on a 2x display anything narrower than
 * 640 is being stretched — which is what made the first version look soft. The
 * screenshot itself is captured losslessly (see captureThumb) so this is the
 * only lossy step, rather than the second one.
 */
async function shrink(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_WIDTH / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return { d: `data:image/jpeg;base64,${btoa(s)}`, w, h, bytes: bytes.length };
}

function scheduleThumb(tabId, windowId, delay = 600) {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => captureThumb(tabId, windowId), delay);
}

async function captureThumb(tabId, windowId) {
  try {
    if (!(await mayCapture())) return;

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.active || tab.discarded || !/^https?:/i.test(tab.url || '')) return;

    const gap = Date.now() - lastCapture;
    if (gap < CAPTURE_GAP_MS) return scheduleThumb(tabId, windowId, CAPTURE_GAP_MS - gap);
    lastCapture = Date.now();

    // PNG, not JPEG: this image is thrown away a line later, and capturing it
    // lossily meant the stored thumbnail carried two generations of JPEG
    // artefacts instead of one.
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (!shot) return;

    const small = await shrink(shot);
    // One record per tab, overwritten in place.
    await chrome.storage.session.set({
      [thumbKey(tabId)]: { ...small, at: Date.now(), url: tab.url, title: tab.title || '' }
    });
    await tidyThumbs();
  } catch {
    /* capture is best-effort: restricted pages, races, rate limits */
  }
}

/**
 * Drop thumbnails for tabs that have gone, then trim to what's worth keeping.
 *
 * Two caps, because one isn't enough: a count, and a byte budget. At 640px a
 * thumbnail is roughly four times the size it used to be, and
 * `chrome.storage.session` has a hard 10MB quota — a count alone could sail
 * past it and start failing writes silently.
 */
export async function tidyThumbs() {
  const all = await chrome.storage.session.get(null).catch(() => ({}));
  const keys = Object.keys(all).filter((k) => k.startsWith(THUMB_PREFIX));
  if (!keys.length) return { removed: 0, kept: 0 };

  const live = new Set((await chrome.tabs.query({})).map((t) => String(t.id)));
  const dead = keys.filter((k) => !live.has(k.slice(THUMB_PREFIX.length)));

  const alive = keys
    .filter((k) => !dead.includes(k))
    .sort((a, b) => (all[b]?.at || 0) - (all[a]?.at || 0));

  const keep = [];
  let bytes = 0;
  for (const k of alive) {
    // The stored form is a base64 data URL, so the string is what costs, not
    // the decoded image: measure that rather than the reported byte count.
    const size = (all[k] && all[k].d ? all[k].d.length : 0) || (all[k]?.bytes || 0);
    if (keep.length >= THUMB_MAX || bytes + size > THUMB_BUDGET) break;
    bytes += size;
    keep.push(k);
  }
  const excess = alive.slice(keep.length);

  const remove = [...dead, ...excess];
  if (remove.length) await chrome.storage.session.remove(remove).catch(() => {});
  return { removed: remove.length, kept: keep.length, bytes };
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => scheduleThumb(tabId, windowId));

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(thumbKey(tabId)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // A navigation makes the cached image wrong — bin it immediately.
  if (info.url) chrome.storage.session.remove(thumbKey(tabId)).catch(() => {});
  if (info.status === 'complete' && tab && tab.active) scheduleThumb(tabId, tab.windowId, 900);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [t] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (t) scheduleThumb(t.id, windowId);
});

/* ------------------------------------------------------------- snapshots */

function signatureOf(windows) {
  return windows
    .map((w) => w.tabs.map((t) => t.url).join('|'))
    .join('#');
}

export async function takeSnapshot(reason = 'auto') {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  // Space membership lives in storage.session; the identity of the spaces
  // themselves lives in storage.local. A snapshot needs both, because a
  // restore has to be able to put a tab back into a space you have since
  // deleted — and "unsorted" is not the same answer as "the space is gone".
  const spaceOf = await readSpaceOf();
  const spaces = await getStore('spaces', []);

  const captured = [];
  for (const w of wins) {
    const payload = await captureWindow(w.id, { spaceOf });
    if (payload.tabs.length) captured.push(payload);
  }
  if (!captured.length) return null;

  const sig = signatureOf(captured);
  const snapshots = await getStore('snapshots', []);
  // Don't fill the buffer with 50 identical states while the machine idles.
  if (snapshots.length && snapshots[0].sig === sig) return null;

  const snap = {
    id: uid(),
    at: Date.now(),
    reason,
    sig,
    windows: captured,
    // Names and emoji only — enough to offer to recreate one, not a second copy
    // of every space's saved URL list.
    spaces: (spaces || []).map((sp) => ({ id: sp.id, name: sp.name, emoji: sp.emoji || '' })),
    tabCount: captured.reduce((n, w) => n + w.tabs.length, 0)
  };

  snapshots.unshift(snap);
  await setStore('snapshots', snapshots.slice(0, MAX_SNAPSHOTS));
  return snap;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SNAPSHOT_ALARM) takeSnapshot('auto').catch(() => {});
});

/* ----------------------------------------------------------- auto-rules */

// Grouping a tab fires more tab events, so only genuine navigations and new
// tabs re-trigger the pass, and a per-window lock stops overlapping runs.
const pending = new Map();
const running = new Set();

async function scheduleRules(windowId) {
  if (windowId === undefined || windowId === chrome.windows.WINDOW_ID_NONE) return;
  const settings = await getStore('settings', { autoApply: true });
  if (settings.autoApply === false) return;
  const rules = await getStore('rules', []);
  if (!activeRules(rules).length) return;

  clearTimeout(pending.get(windowId));
  pending.set(windowId, setTimeout(() => runRules(windowId), 700));
}

/**
 * Which space each tab belongs to. Session-scoped by necessity — tab ids don't
 * survive a restart and Chromium has no per-tab persistent store — so the panel
 * rebuilds it on startup and writes it here for the worker to read.
 */
async function readSpaceOf() {
  return (await readMembership()).spaceOf;
}

/**
 * File tabs into spaces according to the rules, and report what moved.
 *
 * `spaceOf` is read and written here rather than in the panel because filing
 * happens on browser events, and there may be no panel open at all. The panel
 * picks the change up through storage.onChanged like any other membership edit.
 *
 * @param {number} windowId
 * @param {{ includeActive?: boolean }} [opts]
 * @returns {Promise<{n:number, moved:Record<number,string>}>}
 */
async function fileTabs(windowId, opts = {}) {
  const [rules, spaces, tabs] = await Promise.all([
    getStore('rules', []),
    getStore('spaces', []),
    chrome.tabs.query({ windowId })
  ]);

  const skip = [];
  if (!opts.includeActive) {
    // The panel follows the active tab. Filing it would drag the panel into
    // another space while you were still reading this one.
    for (const t of tabs) if (t.active) skip.push(t.id);
  }

  // One read, of just these tabs' keys — not two whole-area scans. See
  // readMembership for why the whole-area form is expensive here.
  const sess = await readMembership(tabs.map((t) => t.id));
  const spaceOf = sess.spaceOf;
  const moved = planFiling(tabs, rules, spaceOf, {
    pinned: sess.spacePinned,
    skip,
    spaceIds: (spaces || []).map((s) => s.id)
  });

  const ids = Object.keys(moved);
  if (!ids.length) return { n: 0, moved: {}, spaceOf };

  // Only the tabs we are actually moving. This used to re-read the whole map,
  // patch it and write it back — which deleted every placement the panel wrote
  // between that read and this write. Since this pass runs on every tab
  // creation and every navigation, that race fired constantly, and it is why a
  // tab opened in one space turned up in Main.
  await writeMembership(moved);

  // Hand back the membership as it now stands, so the grouping pass that
  // follows can use it rather than reading the area a third time.
  return { n: ids.length, moved, spaceOf: { ...spaceOf, ...moved } };
}

async function runRules(windowId) {
  if (running.has(windowId)) return;
  running.add(windowId);
  try {
    const rules = await getStore('rules', []);
    // Filing first: which space a tab is in decides which group it lands in.
    const filed = await fileTabs(windowId)
      .catch((e) => { console.warn('[SideRail] filing failed', e); return null; });
    await applyRules(windowId, rules, filed ? filed.spaceOf : await readSpaceOf());
  } catch (e) {
    console.warn('[SideRail] rule pass failed', e);
  } finally {
    running.delete(windowId);
  }
}

// A title arrives after the page loads, so a title rule can only fire on the
// title event — but plenty of sites rewrite their title continuously ("(3)
// Slack"). Remembering the URL we last reacted to means one pass per
// navigation, not one per unread badge.
const titleSeen = new Map();

chrome.tabs.onCreated.addListener((tab) => scheduleRules(tab.windowId));
chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => {
  if (changeInfo.url) {
    titleSeen.delete(id);
    scheduleRules(tab.windowId);
    return;
  }
  if (changeInfo.title !== undefined && titleSeen.get(id) !== tab.url) {
    titleSeen.set(id, tab.url);
    scheduleRules(tab.windowId);
  }
});
chrome.tabs.onRemoved.addListener((id) => titleSeen.delete(id));
chrome.tabs.onAttached.addListener((_id, info) => scheduleRules(info.newWindowId));

/* -------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Without `externally_connectable` only this extension's own contexts can
  // reach this listener, so this is belt-and-braces. It costs one comparison,
  // and a manifest is exactly the kind of file that gets edited later.
  if (!sender || sender.id !== chrome.runtime.id) return false;
  (async () => {
    try {
      switch (msg?.type) {
        case 'group-by-domain':
          return sendResponse({ ok: true, n: await groupByDomain(msg.windowId) });
        case 'ungroup-all':
          return sendResponse({ ok: true, n: await ungroupAll(msg.windowId) });
        case 'capture-now': {
          await captureThumb(msg.tabId, msg.windowId);
          return sendResponse({ ok: true });
        }
        case 'tidy-thumbs':
          return sendResponse({ ok: true, ...(await tidyThumbs()) });
        case 'find-duplicates':
          return sendResponse({ ok: true, groups: await findDuplicates(msg.windowId) });
        case 'snapshot-now':
          return sendResponse({ ok: true, snap: await takeSnapshot('manual') });
        case 'apply-rules': {
          const rules = msg.rules || (await getStore('rules', []));
          const filed = await fileTabs(msg.windowId, { includeActive: !!msg.includeActive });
          return sendResponse({
            ok: true,
            filed: filed.n,
            moved: filed.moved,
            n: await applyRules(msg.windowId, rules, filed.spaceOf)
          });
        }
        case 'file-tabs': {
          const r = await fileTabs(msg.windowId, { includeActive: msg.includeActive !== false });
          return sendResponse({ ok: true, ...r });
        }
        default:
          return sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep the channel open for the async reply
});
