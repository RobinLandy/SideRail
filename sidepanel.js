// sidepanel.js — SideRail UI.
// Reads tab state through chrome.tabs / chrome.tabGroups only. Nothing here
// ever touches page content: the extension holds no host permissions.

import {
  NONE, GROUP_COLORS, domainOf, isSaveable, prettyUrl, hueFor, matchScore,
  rankItems, dedupeByUrl, normUrl, PAGE_TEXT, PAGE_CARD, getStore, setStore, uid, timeAgo, clockTime,
  captureWindow, restoreCapture, compileRule, ruleMatches, activeRules, ruleGroups,
  cleanEmoji, dockSide, getActiveSpace, setActiveSpace, SPACE_KEY,
  APPEARANCE, FONT_STACKS, TITLE_SIZE_MIN, TITLE_SIZE_MAX, fontStackFor, readAppearance,
  planIndex, searchText, hostExcluded, duplicateCount, readIntent, ruleConflicts, missingSpacesIn,
  redact, textHash, removeOldIndexStore,
  hostLooksPrivate, isSearchResultsPage, urlCarriesSecret,
  UNSORTED, MAIN, MAIN_DEFAULTS, GLOBAL_PIN,
  makeLiveSpace, assignSpaces,
  readMembership, writeMembership, dropMembership, pruneMembership, membershipChanges
} from './common.js';

/** Where the "search the web" fallback sends you. Change to taste. */
const WEB_SEARCH = (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

/** Tab properties we actually render — anything else needn't trigger a redraw. */
const RENDERED_PROPS = [
  'title', 'favIconUrl', 'pinned', 'mutedInfo', 'audible',
  'groupId', 'discarded', 'url', 'index'
];

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  view: 'tabs',
  query: '',
  windowId: null,
  tabs: [],
  groups: [],
  selection: new Set(),
  anchorId: null,
  workspaces: [],
  snapshots: [],
  rules: [],
  settings: { autoApply: true },
  groupOrder: [],
  spaces: [],            // live spaces: [{id, name, emoji, manifest}]
  globalPins: [],        // pinned tabs that ride along in every space
  spaceSeen: {},         // spaces observed holding a live tab this session
  mainSpace: { ...MAIN_DEFAULTS },
  allTabs: [],           // every window's tabs — spaces are not per-window
  spaceOf: {},           // tabId -> spaceId. Session-scoped; tab ids die on restart.
  spacePinned: {},       // tabId -> true for tabs placed by hand. Rules never override these.
  activeSpaceId: UNSORTED,
  spacesReady: false,    // membership rebuilt? until then, never write a manifest
  mode: 'browse',        // 'browse' | 'manage' — a shell, not a fifth tab
  manageView: 'spaces',  // which management section, remembered between visits
  browseQuery: '',       // tab search, kept while management is open
  browseScroll: 0,       // where the tab list was when you left it
  manageQueries: {},     // per-section filters. Never crosses into tab search.
  extras: { bookmarks: [], history: [] },
  expand: { bookmarks: false, history: false },
  scan: {
    granted: false,
    token: 0, running: false, done: 0, total: 0, active: 0, queue: [],
    waking: 0,               // sleeping tabs currently being reloaded to be read
    includedSuspended: false,
    timeouts: 0,
    lastAutoAt: 0,           // when reading last started on its own
    failed: new Set(),       // refused or timed out; retried only by an explicit re-index
    skipped: new Map()       // tabId -> reason the PAGE itself gave for not being read
  },
  // The page-text index: tabId -> { url, title, text, lower, at, partial, bytes }.
  // Panel memory only — it dies with this document and never touches disk.
  index: new Map(),
  indexBytes: 0,
  indexVersion: 0,
  exclusions: { builtin: null, builtinMeta: null, loading: false, user: [], userRaw: null },
  // Search of the on-disk index — pages read before, not open now.
  hasBH: false
};

const VERSION = chrome.runtime.getManifest().version;
const HOMEPAGE = chrome.runtime.getManifest().homepage_url || 'https://github.com/RobinLandy/SideRail';
const DATA_KEYS = ['spaces', 'globalPins', 'mainSpace', 'workspaces', 'snapshots',
  'rules', 'settings', 'groupOrder'];
const HOVER_DELAY_MS = 450;  // don't flash a card while skimming the list
const THUMB_PREFIX = 'thumb:';
const CTX_MAX_MS = 8000;   // hard cap: a stranded menu never lingers
const CTX_LEAVE_MS = 1200; // close shortly after the pointer moves away
/*
 * Scanning is almost entirely *waiting*, not working: each tab runs the reader
 * in its own renderer process, and this panel just holds a promise. Six at a
 * time was throttling a queue that has no contention to relieve.
 *
 * The timeout can be short because the pathological case — a frozen tab, where
 * the injection is queued forever and the promise never settles either way — is
 * now excluded up front rather than paid for at full price, 128 times over.
 */
const SCAN_CONCURRENCY = 24;
const SCAN_BUDGET_MS = 400;   // in-page walk budget before returning partial
const SCAN_TIMEOUT_MS = 1500; // hard cap per tab from this side
const INDEX_TOTAL_CAP = 40 * 1024 * 1024;  // characters kept across all tabs (text + lowercase copy)
const AUTO_READ_GAP_MS = 3000;             // how often a search may start a read on its own

/**
 * 0.23–0.25 kept retention settings for an on-disk page index that no longer
 * exists. Drop them from the settings record so nothing of it lingers.
 */
async function forgetIndexSettings() {
  const old = ['indexKeepDays', 'indexKeepPages', 'indexKeepMB', 'indexAsYouBrowse', 'indexPaused'];
  if (!old.some((k) => k in state.settings)) return;
  const next = { ...state.settings };
  for (const k of old) delete next[k];
  state.settings = next;
  await setStore('settings', next);
}

// Keyed DOM caches. Reusing nodes rather than rebuilding the list is what stops
// a busy tab (one that keeps firing onUpdated) from flickering the whole panel.
const rowCache = new Map();   // tabId  -> row element
const groupCache = new Map(); // groupId -> { wrap, head, body, name, count, caret }

let lastSig = null;
let selfWrite = false;

/* ------------------------------------------------------- error reporting */

// chrome://extensions keeps errors until you press "Clear all", and it renders
// the source context from the file on disk *now* while showing the line number
// recorded then — so after an update a stale error points at unrelated code.
// Stamping the version makes it obvious which build actually threw.
window.addEventListener('error', (e) => {
  console.error(`[SideRail v${VERSION}] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  console.error(`[SideRail v${VERSION}] unhandled rejection: ${(r && r.stack) || r}`);
});

/* ============================================================ bootstrap */

async function init() {
  const win = await chrome.windows.getCurrent();
  state.windowId = win.id;

  document.title = `SideRail ${VERSION}`;

  state.defuddleVersion = await fetch(chrome.runtime.getURL('vendor/defuddle-version.json'))
    .then((r) => r.json()).then((j) => j.version).catch(() => '');

  state.hasBH = await chrome.permissions
    .contains({ permissions: ['bookmarks', 'history'] })
    .catch(() => false);
  state.scan.granted = await chrome.permissions
    .contains({ permissions: ['scripting'], origins: ['<all_urls>'] })
    .catch(() => false);

  [state.snapshots, state.rules, state.settings, state.groupOrder] =
    await Promise.all([
      getStore('snapshots', []),
      getStore('rules', []),
      getStore('settings', { autoApply: true }),
      getStore('groupOrder', [])
    ]);

  applyAppearance();
  removeOldIndexStore();           // 0.23–0.25 kept read pages in IndexedDB; 0.26 does not, and deletes it
  forgetIndexSettings();

  state.spaces = await loadSpaces();
  await refresh();                 // need the live tabs before membership
  await rebuildMembership();
  // A stored active space may name one that no longer exists — deleted in
  // another window, or replaced wholesale by an import. Main always exists.
  const stored = await getActiveSpace(state.windowId);
  state.activeSpaceId =
    stored && (stored === MAIN || state.spaces.some((sp) => sp.id === stored))
      ? stored : firstSpaceId();

  wireChrome();
  wireUI();
  await refresh();
}

/* ============================================================== plumbing */

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 80);
}

/**
 * The tab this window was last known to be showing.
 *
 * Seeded at boot and updated only on a real change, so a window regaining focus
 * — which re-fires onActivated for the same tab — cannot be mistaken for you
 * switching tabs. See the onActivated listener.
 */
let lastActiveTabId = null;

/* ------------------------------------------------------------------ trace */
/**
 * A ring buffer of placement decisions, for bugs that only happen on someone
 * else's machine.
 *
 * Four releases went into "a tab opened in one space turns up in Main" on nothing
 * but code reading and a test harness that — because it put the panel in the
 * same window as the tabs it was watching — did not model a real side panel.
 * This records what the panel actually decided and why, so the next report
 * arrives with evidence instead of a hypothesis. Ids and space ids only: no
 * URLs, no titles, nothing a diagnostics paste should not carry.
 */
const TRACE_MAX = 150;
const trace = [];
const traceT0 = Date.now();
function trace_(ev, detail) {
  trace.push({ ms: Date.now() - traceT0, ev, ...detail });
  if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
}

async function refresh() {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId: state.windowId }),
    chrome.tabGroups.query({ windowId: state.windowId })
  ]);
  state.tabs = tabs.sort((a, b) => a.index - b.index);
  state.groups = groups;
  if (lastActiveTabId === null) {
    const act = tabs.find((t) => t.active);
    if (act) lastActiveTabId = act.id;
  }

  // Spaces span windows: a space can hold tabs in two windows at once, and the
  // manifest must describe all of them or whichever panel writes last would
  // erase the other window's contribution.
  state.allTabs = (await chrome.tabs.query({}).catch(() => tabs))
    .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));

  queueManifest();

  const live = new Set(tabs.map((t) => t.id));
  for (const id of [...state.selection]) if (!live.has(id)) state.selection.delete(id);
  for (const id of [...rowCache.keys()]) if (!live.has(id)) rowCache.delete(id);

  const liveGroups = new Set(groups.map((g) => g.id));
  for (const id of [...groupCache.keys()]) if (!liveGroups.has(id)) groupCache.delete(id);

  render();
}

function wireChrome() {
  const t = chrome.tabs;
  ['onCreated', 'onRemoved', 'onMoved', 'onActivated', 'onDetached',
   'onAttached', 'onReplaced', 'onHighlighted']
    .forEach((ev) => t[ev] && t[ev].addListener(scheduleRefresh));

  // Only redraw for properties we actually show. Chrome fires onUpdated for
  // loading status, throttling, and plenty else besides.
  t.onUpdated.addListener((id, changeInfo) => {
    // What we learned about a page stops being true the moment it becomes a
    // different page.
    if (changeInfo.url) dropIndex(id);
    if (Object.keys(changeInfo).some((k) => RENDERED_PROPS.includes(k))) scheduleRefresh();
  });
  t.onRemoved.addListener((id) => dropIndex(id));

  const g = chrome.tabGroups;
  if (g) ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']
    .forEach((ev) => g[ev] && g[ev].addListener(scheduleRefresh));

  t.onCreated.addListener((tab) => {
    placeNewTab(tab).catch(() => {});
    scheduleRefresh();
  });
  t.onRemoved.addListener((id) => {
    delete state.spaceOf[id];
    delete state.spacePinned[id];
    // Remove this tab's keys specifically. Rewriting the map to "everything
    // except this one" is how the old shape deleted other people's work.
    dropMembership([id]);
  });
  // Follow the browser rather than fight it: if you activate a tab from another
  // space — Ctrl+Tab, the tab strip, a link — the panel goes there with you.
  // Chromium has no successor-tab API, so this is also what keeps closing a tab
  // from silently stranding the panel in a space you can no longer see.
  t.onActivated.addListener(async ({ tabId, windowId }) => {
    if (windowId !== state.windowId) return;   // another window's business

    // Only when the active tab actually CHANGES.
    //
    // Chrome fires onActivated for a tab that is already active whenever the
    // window regains focus — click back into the browser, alt-tab, return from
    // another window. Following that dragged the panel back to the space of
    // whatever tab happened to be on screen, undoing a space you had just
    // chosen.
    //
    // This guard is hardening, and only that. It was written believing the
    // refire was the cause of "Cmd+T lands in Main"; a trace off the user's own
    // browser showed the order is the other way round — the tab is misplaced
    // first, by opener inheritance in `placeNewTab`, and the panel follows it
    // afterwards because it is now genuinely a tab of another space. Don't
    // read this comment as a record of that bug's cause; see `placeNewTab`.
    if (tabId === lastActiveTabId) {
      trace_('activated', { tab: tabId, act: 'refire-ignored' });
      return;
    }
    lastActiveTabId = tabId;

    const id = state.spaceOf[tabId];
    trace_('activated', {
      tab: tabId, tabSpace: id ?? null, showing: state.activeSpaceId,
      act: id && id !== GLOBAL_PIN && id !== state.activeSpaceId ? 'follow' : 'stay'
    });
    if (id && id !== GLOBAL_PIN && id !== state.activeSpaceId) await setActiveSpaceId(id);
  });

  // A tab dragged into a new window keeps its id, and therefore its space —
  // but that space may not be the one this window is showing, and the tab you
  // just dragged out must not vanish. Follow it.
  t.onAttached.addListener(async (tabId, { newWindowId }) => {
    if (newWindowId !== state.windowId) return;
    const id = state.spaceOf[tabId];
    if (id && id !== GLOBAL_PIN && id !== state.activeSpaceId) await setActiveSpaceId(id);
    scheduleRefresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    // Membership is written by whichever panel changed it — including one in
    // another window of the same browser session.
    if (area === 'session') {
      let touched = false;
      const m = membershipChanges(changes);
      if (m.any) {
        // A delta, not a replacement: these keys are the only ones that moved.
        trace_('member-remote', { set: m.spaceOf, gone: m.gone });
        Object.assign(state.spaceOf, m.spaceOf);
        for (const id of m.gone) { delete state.spaceOf[id]; delete state.spacePinned[id]; }
        // Someone else moved a tab — the background filing engine, or a panel
        // in another window. Their write covered storage.session only; the
        // durable record is ours to update.
        queueManifest();
        touched = true;
      }
      const mine = SPACE_KEY + state.windowId;
      if (changes[mine]) {
        const to = changes[mine].newValue || firstSpaceId();
        if (to !== state.activeSpaceId) trace_('show-remote', { from: state.activeSpaceId, to });
        state.activeSpaceId = to;
        touched = true;
      }
      if (touched) { lastSig = null; render(); }
      return;
    }
    if (area !== 'local') return;
    if (changes.spaces) {
      state.spaces = changes.spaces.newValue || [];
      // Each rule card carries a menu of spaces; a new space has to appear in it.
      if (state.view === 'rules') renderRules(true);
    }
    if (changes.globalPins) state.globalPins = changes.globalPins.newValue || [];
    if (changes.mainSpace) { state.mainSpace = changes.mainSpace.newValue || { ...MAIN_DEFAULTS }; lastSig = null; render(); }
    if (changes.snapshots) state.snapshots = changes.snapshots.newValue || [];
    if (changes.settings) {
      state.settings = changes.settings.newValue || state.settings;
      applyAppearance();
    }
    if (changes.groupOrder) { state.groupOrder = changes.groupOrder.newValue || []; lastSig = null; }
    if (changes.rules && !selfWrite) {
      state.rules = changes.rules.newValue || [];
      if (state.view === 'rules') renderRules(true);
    }
    if (changes.spaces || changes.snapshots) { lastSig = null; render(); }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    // 'focus-search' is what versions before 0.15.0 sent. A worker can outlive
    // a panel reload, so keep answering to it.
    if (msg?.type === 'open-palette' || msg?.type === 'focus-search') {
      openPalette();
      sendResponse({ ok: true });
    }
    return true;
  });
}

/* ================================================================== UI */

function wireUI() {
  const search = $('#search');
  let searchTimer = null;

  search.addEventListener('input', () => {
    state.query = search.value.trim();
    $('#clear-search').hidden = !state.query;
    resetScan();
    state.expand = { bookmarks: false, history: false };
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        state.extras = await searchExtras(state.query);
      } catch (e) {
        console.error('[SideRail] search failed', e);
        state.extras = { bookmarks: [], history: [], errors: [String(e)] };
      }
      lastSig = null;
      render();
    }, 130);
    lastSig = null;
    render();
  });

  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { clearSearch(); e.preventDefault(); }
    if (e.key === 'Enter') {
      const first = $('#view-tabs .tab-row[data-id]');
      if (first) return activateTab(Number(first.dataset.id));
      const link = $('#view-tabs .tab-row[data-url]');
      if (link) return void openInPanelWindow(link.dataset.url);
      if (state.query) openInPanelWindow(WEB_SEARCH(state.query));
    }
  });

  $('#clear-search').addEventListener('click', clearSearch);

  document.querySelectorAll('.view-btn').forEach((b) =>
    b.addEventListener('click', () => {
      // Section switches inside management remember their own filter text.
      if (state.mode === 'manage') state.manageQueries[state.view] = state.query;
      applyQuery(state.manageQueries[b.dataset.view] || '');
      setView(b.dataset.view);
    })
  );

  $('#manage-open').addEventListener('click', () => setMode('manage'));
  $('#manage-back').addEventListener('click', () => setMode('browse'));


  $('#act-dedupe').addEventListener('click', openDupeSheet);

  wirePalette();

  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-cancel').addEventListener('click', closeSheet);
  $('#sheet-all').addEventListener('click', () => setAllDupes(true));
  $('#sheet-none').addEventListener('click', () => setAllDupes(false));
  $('#sheet-go').addEventListener('click', closeCheckedDupes);
  $('#act-defuddle').addEventListener('click', () => withActivePage(defuddleTab));
  $('#act-archive').addEventListener('click', () => withActivePage(archiveTab));

  $('#selbar').addEventListener('click', (e) => {
    const act = e.target.closest('[data-bulk]')?.dataset.bulk;
    if (act) bulk(act);
  });

  // Dismissing the context menu.
  //
  // A click inside the browser window never reaches this document — the panel
  // is a separate context — so a document-level listener alone leaves the menu
  // stranded. Window blur plus the tab/window focus events cover clicks that
  // land on the page, the tab strip, or another window.
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#ctxmenu')) hideCtx();
  }, true);
  window.addEventListener('blur', hideCtx);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hideCtx(); });
  const ctxEl = $('#ctxmenu');
  ctxEl.addEventListener('focusout', (e) => {
    // Only meaningful if the menu genuinely held focus in the first place.
    if (!ctxEl._sawFocus) return;
    if (!e.relatedTarget || !e.relatedTarget.closest('#ctxmenu')) hideCtx();
  });
  ctxEl.addEventListener('mouseenter', () => clearTimeout(ctxTimer));
  ctxEl.addEventListener('mouseleave', () => armCtxDismiss(CTX_LEAVE_MS));
  $('#main').addEventListener('scroll', () => {
    hideCtx();
    hideTabPop();
    showScrollThumb();
  }, { passive: true });
  window.addEventListener('resize', () => updateScrollThumb(false), { passive: true });
  document.addEventListener('pointerdown', hideTabPop, true);
  window.addEventListener('blur', hideTabPop);
  chrome.tabs.onActivated.addListener(hideCtx);
  chrome.windows.onFocusChanged.addListener(hideCtx);

  // The page grant was read once at startup. Granting or revoking it anywhere
  // else — another window's panel, chrome://extensions — otherwise left this
  // panel believing the old answer until it was reloaded.
  if (chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(refreshGrants);
    chrome.permissions.onRemoved.addListener(refreshGrants);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideCtx();
    hideTabPop();
    if (!$('#sheet').hidden) return closeSheet();
    if (state.selection.size) clearSelection();
  });
}

function clearSearch() {
  state.query = '';
  state.extras = { bookmarks: [], history: [] };
  state.expand = { bookmarks: false, history: false };
  resetScan();
  $('#search').value = '';
  $('#clear-search').hidden = true;
  lastSig = null;
  render();
}

/* ------------------------------------------------------------ shell mode
 *
 * Two shells, not five tabs. `browse` is where you live; `manage` is a place
 * you visit and come back from. The distinction matters because browsing is
 * not a peer of Settings — it is the thing the whole panel is for — and
 * modelling it as a fifth tab is what made the old nav row spend permanent
 * vertical space advertising four screens you rarely open.
 *
 * `setView()` survives as the management-section renderer. It no longer knows
 * anything about shells.
 */

const MANAGE_VIEWS = ['spaces', 'rules', 'rewind', 'settings'];

const PLACEHOLDER = {
  tabs: 'Search tabs…', spaces: 'Filter spaces…',
  rules: 'Filter rules…', rewind: 'Filter snapshots…'
};

/**
 * Enter or leave management.
 *
 * The two shells keep separate search text. Carrying a rules filter into the
 * tab list — or worse, back again — silently hides tabs, and the user has no
 * reason to connect the two.
 */
function setMode(mode, opts = {}) {
  const to = mode === 'manage' ? 'manage' : 'browse';
  if (state.mode === to && !opts.force) {
    if (to === 'manage' && opts.view) setView(opts.view);
    return;
  }

  const main = $('#main');
  if (state.mode === 'browse') {
    state.browseQuery = state.query;
    state.browseScroll = main ? main.scrollTop : 0;
  } else {
    state.manageQueries[state.view] = state.query;
  }

  state.mode = to;
  document.documentElement.classList.toggle('is-manage', to === 'manage');
  $('#manage-head').hidden = to !== 'manage';
  $('#views').hidden = to !== 'manage';
  $('#manage-open').hidden = to === 'manage';
  // The footer acts on the tab in front of you, which management is not about.
  $('#foot').hidden = to === 'manage';

  if (to === 'manage') {
    const view = opts.view && MANAGE_VIEWS.includes(opts.view)
      ? opts.view
      : (MANAGE_VIEWS.includes(state.manageView) ? state.manageView : 'spaces');
    applyQuery(state.manageQueries[view] || '');
    setView(view);
    if (opts.focus !== false) $('#manage-back').focus();
  } else {
    applyQuery(state.browseQuery || '');
    setView('tabs');
    // Focus returns to the control you left from, so a keyboard user keeps
    // their place rather than being dumped at the top of the document.
    if (opts.focus !== false) $('#manage-open').focus();
    if (main) requestAnimationFrame(() => { main.scrollTop = state.browseScroll || 0; });
  }
}

/** Put text in the search box without pretending the user typed it. */
function applyQuery(text) {
  const search = $('#search');
  search.value = text;
  state.query = text.trim();
  $('#clear-search').hidden = !state.query;
  resetScan();
  state.extras = { bookmarks: [], history: [] };
  state.expand = { bookmarks: false, history: false };
}

function setView(v) {
  state.view = v;
  if (MANAGE_VIEWS.includes(v)) state.manageView = v;
  document.querySelectorAll('.view-btn').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.view === v)
  );
  document.querySelectorAll('.view').forEach((s) =>
    s.classList.toggle('is-active', s.id === `view-${v}`)
  );
  // Nothing in Settings is searchable, and a box that does nothing reads as
  // broken — so it goes away rather than sitting there inert.
  document.querySelector('.head-row').hidden = v === 'settings';
  $('#search').placeholder = PLACEHOLDER[v] || 'Search…';
  lastSig = null;
  if (v === 'rules') renderRules(true); else render();
}

/** Dialog messages are set as HTML, so anything user-typed goes through here. */
function esc(str) {
  // Quotes too. Every current call site puts the result in element content,
  // where the three angle-bracket escapes suffice — but the first person to
  // drop one into an attribute value would have had a string that breaks out.
  return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1900);
}

/* ============================================================== render */

/** Cheap fingerprint of everything the panel draws. */
function signature() {
  const tabs = state.tabs.map((t) =>
    `${t.id}|${t.index}|${t.active ? 1 : 0}|${t.pinned ? 1 : 0}|${t.groupId}|` +
    `${t.discarded ? 1 : 0}|${t.audible ? 1 : 0}|${t.mutedInfo?.muted ? 1 : 0}|` +
    `${t.favIconUrl || ''}|${t.title || ''}|${t.url || ''}`
  ).join('\n');
  const groups = state.groups.map((g) =>
    `${g.id}|${g.title}|${g.color}|${g.collapsed ? 1 : 0}`).join('\n');
  const s = state.scan;
  return [
    state.view, state.query, tabs, groups,
    [...state.selection].sort().join(','),
    state.spaces.map((sp) => `${sp.id}:${sp.name}:${sp.emoji || ''}`).join(','),
    `${state.mainSpace.name}:${state.mainSpace.emoji}`,
    state.activeSpaceId,
    state.tabs.map((t) => state.spaceOf[t.id] || '').join(','),
    state.snapshots.length,
    state.extras.bookmarks.length, state.extras.history.length, state.hasBH,
    state.expand.bookmarks, state.expand.history,
    (state.groupOrder || []).join('>'),
    s.granted, s.running, s.done, s.total, s.waking, s.includedSuspended, s.timeouts,
    state.index.size, state.indexVersion, s.skipped.size, s.failed.size,
    (state.settings.excludeUser || []).length, state.settings.excludeBuiltin !== false,
    state.exclusions.builtin ? 1 : 0,
    state.spaces.map((sp) => (sp.private ? 1 : 0)).join('')
  ].join('§');
}

function render() {
  const sig = signature();
  if (sig === lastSig) {
    if (state.view === 'rules') refreshRuleCounts();
    return; // nothing we draw has changed — leave the DOM alone
  }
  lastSig = sig;

  // The count lived on the old "Tabs" button. With that row gone it sits in the
  // search field, which is the only thing left that is about tabs specifically.
  const count = $('#tab-count');
  count.textContent = state.tabs.length ? String(state.tabs.length) : '';
  count.hidden = state.mode !== 'browse' || !state.tabs.length;
  renderFoot();
  // The list just changed size, so the thumb's proportions are stale. Update
  // the geometry without flashing it into view — it only appears on scroll.
  requestAnimationFrame(() => updateScrollThumb(false));

  if (state.view === 'tabs') renderTabs();
  else if (state.view === 'spaces') renderSpaces();
  else if (state.view === 'rules') { renderRules(false); refreshRuleCounts(); }
  else if (state.view === 'settings') renderSettings();
  else renderRewind();
  renderSelbar();
}

/** Both page actions need a real web page in front of them. */
function withActivePage(fn) {
  const active = state.tabs.find((t) => t.active);
  if (!active) return toast('No active tab');
  if (!/^https?:/i.test(active.url || '')) {
    return toast('That only works on a web page');
  }
  return fn(active.id);
}

/**
 * The footer.
 *
 * Dedupe is only drawn when there is something to dedupe, and says how many
 * tabs it would close. That number comes from `duplicateCount`, the same rule
 * the review sheet uses — so the button can't promise four and then offer
 * three. It costs one pass over the tab list per render, which already happens
 * whenever a tab opens, closes or navigates.
 *
 * Deliberately NOT part of `signature()`: every URL and pinned flag is already
 * in there, so anything that could change the count already forces a redraw.
 * Adding it would mean parsing 130 URLs on every event just to decide whether
 * to do nothing.
 */
function renderFoot() {
  const dupes = duplicateCount(state.tabs);
  const dedupe = $('#act-dedupe');
  // Disabled in place rather than hidden. All three are peers; one of them
  // coming and going shifts the other two and makes the row a moving target.
  // Only the label is rewritten — replacing textContent would eat the icon.
  dedupe.disabled = dupes === 0;
  dedupe.querySelector('.foot-label').textContent = dupes ? `Dedupe (${dupes})` : 'Dedupe';
  dedupe.title = dupes
    ? `Review ${dupes} duplicate tab${dupes === 1 ? '' : 's'} before closing ${dupes === 1 ? 'it' : 'them'}`
    : 'No duplicate URLs open in this window';

  const active = state.tabs.find((t) => t.active);
  const usable = !!active && /^https?:/i.test(active.url || '');
  $('#act-defuddle').disabled = !usable;
  $('#act-archive').disabled = !usable;
}

function renderSelbar() {
  const n = state.selection.size;
  $('#selbar').hidden = n === 0 || state.view !== 'tabs';
  $('#selcount').textContent = `${n} selected`;
}

/** Position `nodes` as the children of `parent`, reusing what's already there. */
function syncChildren(parent, nodes) {
  nodes.forEach((n, i) => {
    const cur = parent.childNodes[i];
    if (cur !== n) parent.insertBefore(n, cur || null);
  });
  while (parent.childNodes.length > nodes.length) parent.removeChild(parent.lastChild);
}

/* ------------------------------------------------------ scroll indicator */

/*
 * A scrollbar that doesn't cost any width.
 *
 * The native one was styled, which in Blink means a *classic* scrollbar: it
 * reserves its 8px permanently, scrolling or not. The panel can't go below
 * ~360px, so that was ~2% of every row's width spent on a bar that is usually
 * showing nothing. The native bar is now hidden outright and this draws the
 * indicator over the content instead.
 *
 * Fixed rather than inside the scroller: a child of a scrolling box scrolls
 * with it, and `position: sticky` would still occupy a column in the layout —
 * which is the thing being reclaimed. It ignores pointer events, so it can
 * never swallow a click meant for a row underneath.
 */
const THUMB_MIN_H = 28;
const THUMB_FADE_MS = 900;
let thumbTimer = null;

function updateScrollThumb(visible) {
  const thumb = $('#scrollthumb');
  const main = $('#main');
  if (!thumb || !main) return;

  const view = main.clientHeight;
  const total = main.scrollHeight;

  // Nothing to indicate when everything already fits.
  if (total <= view + 1) {
    thumb.classList.remove('show');
    return;
  }

  const r = main.getBoundingClientRect();
  const h = Math.max(THUMB_MIN_H, Math.round(r.height * (view / total)));
  const travel = r.height - h;
  const progress = main.scrollTop / (total - view);
  const top = r.top + Math.round(travel * Math.min(1, Math.max(0, progress)));

  thumb.style.height = `${h}px`;
  thumb.style.top = `${Math.round(top)}px`;
  if (visible) thumb.classList.add('show');
}

function showScrollThumb() {
  updateScrollThumb(true);
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    $('#scrollthumb').classList.remove('show');
  }, THUMB_FADE_MS);
}

/* --------------------------------------------------------- live spaces */

/*
 * A space is a LABEL on a tab, not a container.
 *
 * Switching makes no browser call at all: nothing moves, closes, groups or
 * reloads, so it is instant and cannot cost you scroll position or a half-typed
 * form. Everything else here exists because that label has nowhere durable to
 * live — Chromium has no `sessions.setTabValue` and tab ids die on restart — so
 * membership is rebuilt from each space's saved URL list every time the browser
 * starts.
 */

/** Main is where everything starts, so it is also the sane place to land. */
function firstSpaceId() { return MAIN; }

function mainSpace() {
  return {
    id: MAIN,
    name: state.mainSpace.name || MAIN_DEFAULTS.name,
    emoji: state.mainSpace.emoji || MAIN_DEFAULTS.emoji,
    manifest: [],
    fixed: true            // renameable, never deletable
  };
}

function liveSpaceById(id) {
  if (id === MAIN) return mainSpace();
  return state.spaces.find((sp) => sp.id === id) || null;
}

/** Main first, then the spaces you made. Main is always listed. */
function spacesForDisplay() {
  const counts = spaceCounts();
  return [mainSpace(), ...state.spaces]
    .map((sp) => ({ ...sp, count: counts[sp.id] || 0 }));
}

function spaceCounts() {
  const counts = {};
  for (const t of state.tabs) {
    if (t.pinned) continue;               // counted as furniture, not content
    const id = state.spaceOf[t.id] || UNSORTED;
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

/**
 * The tabs the panel should draw right now.
 *
 * Pinned tabs belong to a space like any other tab — that's the Arc model, and
 * it works here because a space is a label, not a native group. The exception
 * is a pin marked global, which rides along in every space.
 */
function tabsInActiveSpace() {
  const active = state.activeSpaceId;
  return state.tabs.filter((t) => {
    const id = state.spaceOf[t.id] || MAIN;
    // Pinned tabs are per-space like everything else: no special case. An
    // unassigned pin sits in Main, which is always in the bar, so nothing can
    // go missing. Riding along in every space is opt-in, per pin.
    if (t.pinned && id === GLOBAL_PIN) return true;
    return id === active;
  });
}

function isGlobalPin(t) {
  return !!t.pinned && state.spaceOf[t.id] === GLOBAL_PIN;
}

async function loadSpaces() {
  state.globalPins = await getStore('globalPins', []);
  state.mainSpace = await getStore('mainSpace', { ...MAIN_DEFAULTS });
  const stored = await getStore('spaces', null);
  if (Array.isArray(stored)) return stored;

  // First run on this build: adopt the old saved-snapshot Spaces as live ones,
  // using their saved tabs as the starting manifest. The old `workspaces` key
  // is left untouched, so nothing is lost if this needs undoing.
  const legacy = await getStore('workspaces', []);
  const migrated = legacy.map((w) => ({
    id: w.id,
    name: w.name,
    emoji: w.emoji || '',
    createdAt: w.createdAt || Date.now(),
    updatedAt: w.updatedAt || Date.now(),
    manifest: (w.tabs || []).map((t) => ({ url: t.url, title: t.title || '', pinned: !!t.pinned }))
  }));
  await setStore('spaces', migrated);
  return migrated;
}

/**
 * Work out which space each open tab belongs to.
 *
 * Within one browser session the answer is already in `storage.session`. After
 * a restart it isn't — every tab id is new — so it is rebuilt by matching the
 * saved URL lists against the order the browser restored tabs in.
 */
async function rebuildMembership() {
  // EVERY window's tabs, not just this one's.
  //
  // Membership is a browser-wide map, and this function REPLACES it before
  // persisting. Building it from one window therefore deleted the placement of
  // every tab in every other window — and with two panels open, each wiped the
  // other's on every boot, which is how a tab that was somewhere specific ended
  // up back in Main and stayed there.
  const all = state.allTabs.length ? state.allTabs : state.tabs;
  const live = new Set(all.map((t) => t.id));
  // Per-tab keys don't tidy themselves the way replacing a whole map did, and
  // Chrome reuses tab ids across restarts — a stale key would hand a brand-new
  // tab someone else's space.
  await pruneMembership(live);
  const sess = await readMembership(live);
  const stored = sess.spaceOf || {};

  // Hand placements are session-scoped for the same reason membership is: they
  // are keyed by tab id. Keep only the ones whose tab is still open.
  state.spacePinned = {};
  for (const [id, v] of Object.entries(sess.spacePinned || {})) {
    if (v && live.has(Number(id))) state.spacePinned[id] = true;
  }

  // Compare like with like: how many of the tabs we can see do we already have
  // a placement for? The old form measured stored entries against the count of
  // UNPINNED tabs, which drifts as soon as a window is mostly pins.
  const known = all.filter((t) => stored[t.id] !== undefined).length;
  const total = all.length;

  let rebuilt = false;
  trace_('rebuild', { total, known, mode: total && known >= total * 0.5 ? 'trust' : 'manifest' });
  if (total && known >= total * 0.5) {
    // Same session — trust what we had, and place anything new.
    //
    // Pinned tabs are included. They were skipped here until 0.19.1, left over
    // from when a pin was global and therefore had no space of its own. Since
    // pins became per-space that skip has been quietly destroying them: this
    // function REPLACES state.spaceOf and then persists it, so every rebuild
    // dropped each pinned tab's placement, and the panel's `|| MAIN` fallback
    // made it reappear in Main. It ran on every panel boot, so a pin filed into
    // another space came back to Main the next time you opened the panel.
    state.spaceOf = {};
    for (const t of all) {
      state.spaceOf[t.id] = stored[t.id] || UNSORTED;
    }
  } else {
    // Global pins are matched exactly like a space, so the pure matcher needs
    // no special case for them. Spaces span windows, so this matches over all
    // of them — a space's manifest describes tabs wherever they ended up.
    const r = assignSpaces(all,
      [...state.spaces, { id: GLOBAL_PIN, manifest: state.globalPins || [] }]);
    state.spaceOf = r.byTab;
    // A restart renumbers every tab, so any surviving hand-placement map is
    // pointing at ids that now mean something else. Start clean.
    state.spacePinned = {};
    rebuilt = true;
    if (r.matched) toast(`Restored ${r.matched} tabs to their spaces`);
  }

  await persistMembership();
  // Only now is it safe to write manifests: doing it earlier — before we know
  // which tabs are where — would overwrite every space with whatever the
  // browser happened to restore, which after a refused crash prompt is nothing.
  state.spacesReady = true;

  // The worker's auto-rules pass runs on restored tabs before any panel exists,
  // so it sees no membership and files everything into Main's groups. Now that
  // membership is known, one pass re-splits them into each space's own group.
  if (rebuilt && state.settings.autoApply !== false && state.spaces.length) {
    send({
      type: 'apply-rules', windowId: state.windowId,
      rules: state.rules, spaceOf: state.spaceOf
    });
  }
}

/**
 * Write membership as one key per tab.
 *
 * Nothing here writes a whole map any more, so nothing can delete a placement
 * it didn't know about — which is what the panel and the service worker were
 * doing to each other on every navigation.
 */
async function persistMembership() {
  await writeMembership(state.spaceOf, state.spacePinned);
}

/**
 * What the extension actually believes, in a form safe to paste.
 *
 * Three rounds of this bug were spent guessing at a configuration I could not
 * see, each time fixing something real that turned out not to be the cause. A
 * report plus this dump would have settled it in one. Hosts only — never full
 * URLs or titles, so pasting it does not hand over a browsing history.
 */
async function collectDiagnostics() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  const all = await chrome.tabs.query({}).catch(() => []);
  const sess = await readMembership();
  const showing = {};
  for (const w of wins) showing[w.id] = await getActiveSpace(w.id);

  return {
    version: VERSION,
    ua: navigator.userAgent.replace(/\(.*?\)/, '(…)'),
    panelWindow: state.windowId,
    showingHere: state.activeSpaceId,
    showingByWindow: showing,
    windows: wins.length,
    spaces: [
      { id: MAIN, name: state.mainSpace.name, manifest: 'n/a' },
      ...state.spaces.map((sp) => ({ id: sp.id, name: sp.name, manifest: (sp.manifest || []).length }))
    ],
    globalPins: (state.globalPins || []).length,
    rules: state.rules.map((r) => ({
      name: r.name, enabled: r.enabled !== false, group: r.group !== false,
      spaceId: r.spaceId || '', patterns: (r.patterns || []).length
    })),
    autoApply: state.settings.autoApply !== false,
    tabs: all.map((t) => ({
      w: t.windowId,
      host: domainOf(t.url) || (t.url || '').split(':')[0],
      pinned: !!t.pinned,
      space: sess.spaceOf[t.id] || null,
      byHand: !!sess.spacePinned[t.id]
    })),
    trace,
    counts: {
      tabs: all.length,
      placed: all.filter((t) => sess.spaceOf[t.id]).length,
      strayKeys: Object.keys(sess.spaceOf).length - all.filter((t) => sess.spaceOf[t.id]).length
    }
  };
}

/**
 * Open a URL in the window this panel is showing.
 *
 * `chrome.tabs.create({url})` with no windowId targets the "current" window,
 * and from inside a side panel that is not reliably the window whose tabs the
 * panel is drawing — the same trap `restoreCapture` documents. A tab that lands
 * in another window is placed by that window's space, not the one you were
 * looking at, which reads as "it opened in the wrong space".
 */
function openInPanelWindow(url) {
  return chrome.tabs.create({ windowId: state.windowId, url }).catch(() =>
    chrome.tabs.create({ url }));
}

/**
 * Assign a newly-created tab to the space its own window is showing.
 *
 * "Its own window", not this panel's. A panel only sees `onCreated` for tabs
 * anywhere in the browser, and using its own active space meant a panel sitting
 * in Main would file a tab you opened in Work into Main. Guarding on
 * `windowId` fixed that but left a worse hole: a window whose panel is closed
 * had nobody to place its tabs at all, so they fell through to Main.
 *
 * Reading the target window's showing-space from storage is correct in every
 * case — whichever panel happens to be alive answers for the right window.
 *
 * The opener is deliberately consulted LAST, where it used to come first.
 * That inheritance was the ⌘T bug (0.20.3). Switching space in the panel does
 * not move the window's active tab — §3.1, and the whole point of spaces being
 * labels — so the tab on screen is still one of the space you just left.
 * Chromium hands that tab to the new ⌘T tab as its `openerTabId`: not because
 * it opened anything, but so focus can return there when the tab closes.
 * Inheriting from it filed every ⌘T into the previous space, and `onActivated`
 * then correctly followed the now-misplaced tab, which is the sidebar moving
 * "by itself".
 *
 * It cannot be salvaged by asking where the tab is going, which was the first
 * attempt. Measured on Helium/Chromium 151: for a tab the BROWSER creates —
 * ⌘T or a link opened in a new tab alike — `onCreated` reports `url: ''` and
 * no `pendingUrl` whatsoever. The destination is genuinely not decided yet, so
 * there is nothing at this moment that tells the two gestures apart. (Only
 * `chrome.tabs.create()` from an extension carries `pendingUrl` — and that one
 * gets no `openerTabId` in the event at all, which is why the old inheritance
 * test passed for four releases while testing nothing. See test/e2e.js.)
 *
 * So the space on screen wins, and the opener survives only as a last resort
 * for a window with no showing-space on record.
 */
async function placeNewTab(tab) {
  let space = tab.windowId === state.windowId
    ? state.activeSpaceId
    : await getActiveSpace(tab.windowId);

  const fromOpener = tab.openerTabId !== undefined ? state.spaceOf[tab.openerTabId] : null;
  const inherited = !space && fromOpener && fromOpener !== GLOBAL_PIN ? fromOpener : null;
  if (inherited) space = inherited;

  space = space || UNSORTED;

  trace_('place', {
    tab: tab.id, win: tab.windowId, opener: tab.openerTabId ?? null,
    via: inherited ? 'opener' : (tab.windowId === state.windowId ? 'panel' : 'window'),
    showing: state.activeSpaceId, chose: space
  });

  state.spaceOf[tab.id] = space;
  await writeMembership({ [tab.id]: space });
  // The manifest is the only record that survives a restart, and a placement
  // that never reaches it is a placement you lose the next time you quit.
  queueManifest();
}

async function setActiveSpaceId(id) {
  if (id !== MAIN && id !== GLOBAL_PIN && !state.spaces.some((sp) => sp.id === id)) {
    id = MAIN;   // a space can be deleted, or arrive from an import, while shown
  }
  if (state.activeSpaceId === id) return;
  trace_('show', { from: state.activeSpaceId, to: id });
  state.activeSpaceId = id;
  await setActiveSpace(state.windowId, id);
  lastSig = null;
  render();
}

/** Move tabs into a space. A label change — nothing in the browser moves. */
async function moveTabsToSpace(tabIds, spaceId) {
  for (const id of tabIds) {
    state.spaceOf[id] = spaceId;
    // Placed by hand: from here on, no rule may move this tab again. Without
    // this a filing rule would silently undo the move on the next navigation.
    state.spacePinned[id] = true;
  }
  await persistMembership();
  queueManifest();
  // The rules pass re-files them into that space's own groups.
  if (state.settings.autoApply !== false) {
    send({ type: 'apply-rules', windowId: state.windowId, rules: state.rules, spaceOf: state.spaceOf });
  }
  lastSig = null;
  render();
  const sp = liveSpaceById(spaceId);
  toast(`Moved ${tabIds.length} tab${tabIds.length === 1 ? '' : 's'} to ${sp ? sp.name : 'Unsorted'}`);
}

/**
 * Each space's ordered URL list — the only durable record of what it holds.
 * Written on change, debounced, and never before membership is rebuilt.
 */
let manifestTimer = null;
function queueManifest() {
  if (!state.spacesReady) return;
  clearTimeout(manifestTimer);
  manifestTimer = setTimeout(writeManifest, 500);
}

async function writeManifest() {
  if (!state.spacesReady || !state.spaces.length) return;
  const byId = {};
  for (const sp of state.spaces) byId[sp.id] = [];
  const globals = [];
  for (const t of (state.allTabs.length ? state.allTabs : state.tabs)) {
    const owner = state.spaceOf[t.id];
    if (owner && byId[owner]) state.spaceSeen[owner] = true;
    if (!isSaveable(t.url)) continue;
    const id = state.spaceOf[t.id];
    if (t.pinned && id === GLOBAL_PIN) {
      globals.push({ url: t.url, title: t.title || '', pinned: true });
      continue;
    }
    if (byId[id]) byId[id].push({ url: t.url, title: t.title || '', pinned: !!t.pinned });
  }
  if (JSON.stringify(globals) !== JSON.stringify(state.globalPins)) {
    state.globalPins = globals;
    await setStore('globalPins', globals);
  }
  let changed = false;
  for (const sp of state.spaces) {
    const next = byId[sp.id];

    // Only ever overwrite a space we have actually seen holding a live tab.
    //
    // Otherwise the first write after a restart that restored nothing — a
    // dismissed crash prompt, or a browser set to open a New Tab page — would
    // replace every saved list with an empty one, destroying the only record of
    // what the space held. That is the exact loss the manifest exists to
    // prevent, and delaying the write until membership is rebuilt does not
    // prevent it: membership would legitimately be empty.
    if (!next.length && !state.spaceSeen[sp.id]) continue;

    if (JSON.stringify(next) === JSON.stringify(sp.manifest)) continue;
    sp.manifest = next;
    sp.updatedAt = Date.now();
    changed = true;
  }
  if (changed) await setStore('spaces', state.spaces);
}

async function persistSpaces(msg) {
  await setStore('spaces', state.spaces);
  lastSig = null;
  render();
  if (msg) toast(msg);
}

/** The space switcher at the top of the tab list. */
let spaceBarEl = null;
function spaceBar() {
  if (!spaceBarEl) spaceBarEl = el('div', 'space-bar');
  const chips = spacesForDisplay().map((sp) => {
    const b = el('button', `schip${sp.id === state.activeSpaceId ? ' is-on' : ''}`);
    b.setAttribute('aria-current', sp.id === state.activeSpaceId ? 'true' : 'false');
    b.append(el('span', 'emo', sp.emoji || '🗂'));
    b.append(el('span', 'nm', sp.name));
    b.append(el('span', 'ct', String(sp.count)));
    // The full name stays reachable when a long one ellipsizes.
    b.title = `${sp.name} — ${sp.count} tab${sp.count === 1 ? '' : 's'}`;
    b.addEventListener('click', () => setActiveSpaceId(sp.id));
    b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('drag-over'); });
    b.addEventListener('dragleave', () => b.classList.remove('drag-over'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('drag-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      if (id) moveTabsToSpace(state.selection.size ? [...state.selection] : [id], sp.id);
    });
    return b;
  });
  syncChildren(spaceBarEl, chips);
  return spaceBarEl;
}

/* ---------------------------------------------------------- tabs view */

function renderTabs() {
  const root = $('#view-tabs');
  if (state.query) return renderSearchResults(root);

  const nodes = [];
  const visible = tabsInActiveSpace();
  const pinned = visible.filter((t) => t.pinned);
  const rest = visible.filter((t) => !t.pinned);

  const head = stickyHead(pinned);
  if (head) nodes.push(head);

  if (!rest.length && !pinned.length) {
    const sp = liveSpaceById(state.activeSpaceId);
    syncChildren(root, [
      stickyHead(pinned),
      emptyState(`${sp ? sp.name : 'This space'} is empty`,
        'Drag tabs onto a space above, or right-click a tab and move it here.')
    ]);
    return;
  }

  let i = 0;
  while (i < rest.length) {
    const t = rest[i];
    if (t.groupId === NONE) { nodes.push(tabRow(t)); i++; continue; }
    const gid = t.groupId;
    const members = [];
    while (i < rest.length && rest[i].groupId === gid) members.push(rest[i++]);
    nodes.push(groupBlock(gid, members));
  }

  syncChildren(root, nodes);
}

/**
 * The pinned strip and the group-jump bar share one sticky container, so both
 * stay put together however the pinned strip wraps.
 */
let stickyEl = null;

function stickyHead(pinned) {
  // Always rendered: the overflow menu lives here, and "Group by domain" is
  // exactly what you reach for when there are no groups yet.
  if (!stickyEl) stickyEl = el('div', 'stick');
  const parts = [];
  parts.push(spaceBar());

  // Two layers of small controls, one above the other, both square-ish and
  // both about "somewhere to go". Without a word attached to each, a pinned
  // LinkedIn tile and a LinkedIn group shortcut are the same object twice. The
  // captions cost a line each, which is why they are 10.5px and sit 2px above
  // the thing they name — proximity is doing the grouping, not a box.
  if (pinned.length) {
    const sp = liveSpaceById(state.activeSpaceId);
    parts.push(layerCaption('pin', `Pinned in ${sp ? sp.name : 'this space'}`));
    parts.push(pinStrip(pinned));
  }

  // The caption row carries the window-actions menu as well as the words. That
  // menu used to sit on the pill row, where its 28px was the difference between
  // four group shortcuts fitting at 250px and only three — and the caption line
  // beside it was empty anyway.
  const groups = groupsInOrder();
  parts.push(jumpHeader(groups));
  if (groups.length) parts.push(groupBar(groups));

  syncChildren(stickyEl, parts);
  return stickyEl;
}

let jumpHeadEl = null;
function jumpHeader(groups) {
  if (!jumpHeadEl) {
    jumpHeadEl = el('div', 'layer-cap cap-jump');
    jumpHeadEl._text = el('span');
    jumpHeadEl.append(jumpHeadEl._text, windowMenu());
  }
  const want = groups.length ? '↳ Jump to a group' : '';
  if (jumpHeadEl._text.textContent !== want) jumpHeadEl._text.textContent = want;
  return jumpHeadEl;
}

/** Small title tying a caption to the row of controls directly beneath it. */
const captionCache = new Map();
function layerCaption(key, text) {
  let node = captionCache.get(key);
  if (!node) {
    node = el('div', `layer-cap cap-${key}`);
    captionCache.set(key, node);
  }
  if (node.textContent !== text) node.textContent = text;
  return node;
}

/**
 * Stable identity for a group across restarts, since group IDs are not
 * persistent. Title first, then the first member's domain.
 */
function groupKey(g) {
  if (g.title) return `t:${g.title.toLowerCase()}`;
  const first = state.tabs.find((t) => t.groupId === g.id);
  return `d:${domainOf(first?.url) || g.id}`;
}

/** Groups of the current window: saved bar order first, then tab-strip order. */
function groupsInOrder() {
  const inStrip = [];
  const seen = new Set();
  for (const t of tabsInActiveSpace()) {
    if (t.pinned || t.groupId === NONE || seen.has(t.groupId)) continue;
    seen.add(t.groupId);
    const g = state.groups.find((x) => x.id === t.groupId);
    if (g) inStrip.push(g);
  }

  const saved = state.groupOrder || [];
  return inStrip
    .map((g, i) => {
      const at = saved.indexOf(groupKey(g));
      return { g, rank: at === -1 ? Number.MAX_SAFE_INTEGER : at, strip: i };
    })
    .sort((a, b) => (a.rank - b.rank) || (a.strip - b.strip))
    .map((x) => x.g);
}

async function saveGroupOrder(keys) {
  state.groupOrder = keys;
  await setStore('groupOrder', keys);
}

let groupBarEl = null;
const chipCache = new Map(); // groupId -> button, so clicks survive re-renders

/**
 * Window-wide actions. Not a per-tab menu and never attached to a row — these
 * act on the whole window, which is why they live beside the layer caption
 * rather than anywhere in the list.
 */
let windowMenuEl = null;
function windowMenu() {
  if (windowMenuEl) return windowMenuEl;
  const menu = el('button', 'gmenu', '⋯');
  menu.id = 'gmenu';
  menu.title = 'Window actions';
  menu.setAttribute('aria-label', 'Window actions');
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = menu.getBoundingClientRect();
    openCtx({ preventDefault() {}, clientX: r.right - 180, clientY: r.bottom + 4 }, [
      ['Group tabs by domain', async () => {
        const res = await send({ type: 'group-by-domain', windowId: state.windowId });
        toast(res?.n ? `Grouped ${res.n} tabs` : 'Nothing to group');
      }],
      ['Ungroup all tabs', async () => {
        const res = await send({ type: 'ungroup-all', windowId: state.windowId });
        toast(res?.n ? `Ungrouped ${res.n} tabs` : 'No groups');
      }],
      ['Run rules now', runRulesNow],
      null,
      ['Save window as a Space', () => saveWorkspace()],
      null,
      ['Export data…', exportData],
      ['Import data…', pickImportFile],
      ['Reset jump-bar order', async () => {
        await saveGroupOrder([]);
        lastSig = null;
        render();
        toast('Order reset');
      }]
    ]);
  });
  windowMenuEl = menu;
  return menu;
}

function groupBar(groups) {
  if (!groupBarEl) {
    groupBarEl = el('div', 'group-bar');
    groupBarEl._list = el('div', 'gjump-list');
    groupBarEl.append(groupBarEl._list);
  }

  const live = new Set(groups.map((g) => g.id));
  for (const id of [...chipCache.keys()]) if (!live.has(id)) chipCache.delete(id);

  const chips = groups.map((g) => chipFor(g, groups));
  syncChildren(groupBarEl._list, chips);
  return groupBarEl;
}

function chipFor(g, groups) {
  let b = chipCache.get(g.id);
  if (!b) {
    b = el('button', 'gjump');
    b.draggable = true;
    chipCache.set(g.id, b);

    // Jump on click, not pointerdown: HTML5 drag suppresses click, so the two
    // gestures stay cleanly separated. Chips are cached, so the click survives
    // a re-render.
    b.addEventListener('click', () => jumpToGroup(b._gid));

    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', `group:${b._gid}`);
      e.dataTransfer.effectAllowed = 'move';
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => b.classList.remove('dragging'));
    b.addEventListener('dragover', (e) => {
      if (!String(e.dataTransfer.types || '').includes('text/plain')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      b.classList.add('drag-over');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drag-over'));
    b.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      b.classList.remove('drag-over');
      const raw = e.dataTransfer.getData('text/plain') || '';
      if (!raw.startsWith('group:')) return;
      const srcId = Number(raw.slice(6));
      if (!srcId || srcId === b._gid) return;

      const current = groupsInOrder();
      const keys = current.map(groupKey);
      const srcKey = groupKey(current.find((x) => x.id === srcId) || {});
      const dstKey = groupKey(current.find((x) => x.id === b._gid) || {});
      const from = keys.indexOf(srcKey);
      const to = keys.indexOf(dstKey);
      if (from === -1 || to === -1) return;
      keys.splice(to, 0, keys.splice(from, 1)[0]);
      await saveGroupOrder(keys);
      lastSig = null;
      render();
    });
  }

  b._gid = g.id;
  const members = state.tabs.filter((t) => t.groupId === g.id);
  const name = g.title || domainOf(members[0]?.url) || 'Group';

  // A named capsule, not an initial. "G" is only legible if you already know
  // which G — and a pinned tile and a group shortcut for the same service were
  // otherwise the same small coloured square twice. The dot carries the colour,
  // the word carries the meaning, and the shape says "this is navigation".
  if (!b._dot) {
    b._dot = el('span', 'gdot');
    b._name = el('span', 'gname');
    b.replaceChildren(b._dot, b._name);
  }
  if (b._name.textContent !== name) b._name.textContent = name;
  b.style.setProperty('--gc', `var(--g-${g.color || 'grey'})`);
  // The full name survives the ellipsis here.
  b.title = `${name} · ${members.length} tab${members.length === 1 ? '' : 's'} — click to jump, drag to reorder`;
  return b;
}

/**
 * Scroll the group into view and switch to its most recently used tab — unless
 * the active tab is already in that group, in which case just scroll.
 */
function jumpToGroup(gid) {
  const members = state.tabs.filter((t) => t.groupId === gid);
  if (!members.length) return;

  const active = state.tabs.find((t) => t.active);
  if (!active || active.groupId !== gid) {
    // lastAccessed exists from Chrome 121; fall back to the rightmost tab.
    const target = members.reduce((best, t) =>
      (t.lastAccessed || 0) > (best.lastAccessed || 0) ? t : best, members[members.length - 1]);
    if (!active || active.id !== target.id) activateTab(target.id);
  }

  const entry = groupCache.get(gid);
  const main = $('#main');
  if (!entry || !main) return;
  const offset = (stickyEl ? stickyEl.offsetHeight : 0) + 8;
  main.scrollTo({ top: Math.max(0, entry.wrap.offsetTop - offset), behavior: 'smooth' });
}

let pinStripEl = null;
function pinStrip(pinned) {
  if (!pinStripEl) {
    pinStripEl = el('div', 'pin-strip');
    // Dropping onto empty space in the strip pins the tab at the end.
    pinStripEl.addEventListener('dragover', (e) => { e.preventDefault(); });
    pinStripEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      const srcId = Number(e.dataTransfer.getData('text/plain'));
      if (!srcId) return;
      const src = state.tabs.find((x) => x.id === srcId);
      if (src && !src.pinned) {
        await chrome.tabs.update(srcId, { pinned: true }).catch(() => {});
        toast('Pinned');
      }
    });
  }

  const chips = pinned.map((t) => {
    const global = isGlobalPin(t);
    const chip = el('div', 'pin-chip' + (t.active ? ' is-active' : '') + (global ? ' is-global' : ''));
    // Same identity handle as a tab row carries, so anything reasoning about
    // "which tab is this control for" works the same way in both places.
    chip.dataset.id = String(t.id);
    chip.title = `${t.title || t.url}\n${global ? 'Pinned in every space' : `Pinned in ${liveSpaceById(state.activeSpaceId)?.name || 'this space'}`}`;
    chip.draggable = true;
    chip.append(favicon(t));

    chip.addEventListener('pointerdown', (e) => {
      if (e.button === 1) { e.preventDefault(); return closeTab(t.id); }
      if (e.button === 0) activateTab(t.id);
    });
    chip.addEventListener('contextmenu', (e) => showCtx(e, t));

    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(t.id));
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    chip.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      chip.classList.add('drag-over');
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
    chip.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      chip.classList.remove('drag-over');
      const srcId = Number(e.dataTransfer.getData('text/plain'));
      if (!srcId || srcId === t.id) return;
      const src = state.tabs.find((x) => x.id === srcId);
      // Dragging an unpinned tab in here pins it, then drops it at this slot.
      if (src && !src.pinned) await chrome.tabs.update(srcId, { pinned: true }).catch(() => {});
      await chrome.tabs.move(srcId, { index: t.index }).catch(() => {});
    });

    return chip;
  });

  syncChildren(pinStripEl, chips);
  return pinStripEl;
}

function renderSearchResults(root) {
  const nodes = [];
  const q = state.query;

  /* 1 — open tabs matching by title or URL */
  const scored = state.tabs
    .map((t) => ({ t, s: matchScore(q, t) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s);
  const shownIds = new Set(scored.map((x) => x.t.id));

  if (scored.length) {
    nodes.push(sectionLabel(`Tabs · ${scored.length}`));
    scored.forEach(({ t }) => nodes.push(tabRow(t, true)));
  }

  /* 2 — open tabs whose page text contains the query */
  nodes.push(...pageTextSection(q, shownIds));

  /* 3 & 4 — bookmarks and history */
  const { bookmarks = [], history = [] } = state.extras;

  if (bookmarks.length) {
    const limit = state.expand.bookmarks ? bookmarks.length : 6;
    nodes.push(sectionLabel(`Bookmarks · ${bookmarks.length}`));
    bookmarks.slice(0, limit).forEach((b) =>
      nodes.push(linkRow(b.title || b.url, b.url, b._folder || 'Bookmarks')));
    if (bookmarks.length > limit) nodes.push(moreButton('bookmarks', bookmarks.length - limit));
  }

  if (history.length) {
    const limit = state.expand.history ? Math.min(history.length, 60) : 8;
    nodes.push(sectionLabel(`History · ${history.length}`));
    history.slice(0, limit).forEach((h) =>
      nodes.push(linkRow(h.title || h.url, h.url,
        `${prettyUrl(h.url)}${h.lastVisitTime ? ` · ${timeAgo(h.lastVisitTime)}` : ''}`)));
    if (history.length > limit) nodes.push(moreButton('history', history.length - limit));
  }

  if (!state.hasBH) {
    const chip = el('button', 'perm-chip bh-chip');
    chip.innerHTML =
      '<b>Also search bookmarks &amp; history</b><br>Grants two optional permissions. Nothing leaves your browser.';
    chip.addEventListener('click', async () => {
      const ok = await chrome.permissions
        .request({ permissions: ['bookmarks', 'history'] })
        .catch(() => false);
      if (ok) {
        state.hasBH = true;
        state.extras = await searchExtras(state.query);
        lastSig = null;
        render();
        toast('Bookmarks & history enabled');
      }
    });
    nodes.push(chip);
  } else if (!bookmarks.length && !history.length) {
    // Granted but nothing came back — say so, rather than rendering nothing and
    // leaving it ambiguous whether the feature is broken.
    nodes.push(sectionLabel('Bookmarks & history'));
    nodes.push(el('div', 'scan-empty', 'No bookmark or history matches.'));
    const redo = el('button', 'revoke-btn', 'Re-request bookmark & history access');
    redo.addEventListener('click', async () => {
      await chrome.permissions.request({ permissions: ['bookmarks', 'history'] }).catch(() => false);
      state.extras = await searchExtras(state.query);
      lastSig = null;
      render();
    });
    nodes.push(redo);
  }

  const errs = state.extras.errors || [];
  if (errs.length) {
    nodes.push(el('div', 'search-error', `Search problem — ${errs.join(' · ')}`));
  }

  if (!scored.length && !bookmarks.length && !history.length) {
    nodes.unshift(emptyState('No matches', 'Nothing open matches that.'));
  }

  const web = el('div', 'tab-row');
  web.dataset.url = WEB_SEARCH(q);
  web.append(letterTile('?'));
  web.append(el('span', 'title', `Search the web for “${q}”`));
  web.addEventListener('click', () => openInPanelWindow(WEB_SEARCH(q)));
  nodes.push(sectionLabel('Web'), web);

  syncChildren(root, nodes);
}

function moreButton(which, remaining) {
  const b = el('button', 'more-btn', `Show ${remaining} more`);
  b.addEventListener('click', () => {
    state.expand[which] = true;
    lastSig = null;
    render();
  });
  return b;
}

/* Walk up the bookmark tree so each hit says which folder it lives in. */
const folderCache = new Map();
async function folderPath(parentId) {
  const parts = [];
  let id = parentId;
  for (let i = 0; id && i < 12; i++) {
    let entry = folderCache.get(id);
    if (!entry) {
      const [node] = await chrome.bookmarks.get(id).catch(() => []);
      if (!node) break;
      entry = { title: node.title || '', parentId: node.parentId };
      folderCache.set(id, entry);
    }
    if (entry.title) parts.unshift(entry.title);
    id = entry.parentId;
  }
  return parts.join(' / ') || 'Bookmarks';
}

/**
 * Bookmarks and history are searched independently and defensively: one of them
 * failing must never silently empty the other, and any failure is surfaced in
 * the UI rather than vanishing into a rejected promise.
 */
async function searchExtras(q) {
  const out = { bookmarks: [], history: [], errors: [] };
  if (!q || q.length < 2) return out;

  // Re-check rather than trusting what was cached at boot — the grant can
  // change from chrome://extensions while the panel is open.
  state.hasBH = await chrome.permissions
    .contains({ permissions: ['bookmarks', 'history'] })
    .catch(() => false);
  if (!state.hasBH) return out;

  const openUrls = new Set(state.tabs.map((t) => t.url));

  if (chrome.bookmarks && chrome.bookmarks.search) {
    try {
      const bm = await chrome.bookmarks.search({ query: q });
      out.bookmarks = rankItems(q, bm, openUrls);
    } catch (e) {
      out.errors.push(`bookmarks: ${(e && e.message) || e}`);
    }
  } else {
    out.errors.push('bookmarks API unavailable');
  }

  if (chrome.history && chrome.history.search) {
    try {
      const hist = await chrome.history.search({ text: q, maxResults: 300, startTime: 0 });
      out.history = dedupeByUrl(rankItems(q, hist, openUrls));
    } catch (e) {
      out.errors.push(`history: ${(e && e.message) || e}`);
    }
  } else {
    out.errors.push('history API unavailable');
  }

  // Folder paths are cosmetic — never let them break the result list.
  await Promise.all(out.bookmarks.slice(0, 12).map(async (b) => {
    try { b._folder = await folderPath(b.parentId); } catch { b._folder = ''; }
  })).catch(() => {});

  return out;
}

/* ------------------------------------------------- page-text search
 *
 * Read once, search many. Each readable tab is read ONCE into an in-memory
 * index — its visible text, chrome stripped — and every query is then a local
 * string search over that text, live as you type, beside the title matches.
 * Reading is query-independent, so a keystroke discards nothing and a page is
 * not re-read until it changes.
 *
 * The index outlives sleep: text read while a tab was awake stays searchable
 * after Chrome freezes or discards it, which is the only way to search a
 * frozen tab without visiting it. A discarded tab that was never read can be
 * woken, read and put back.
 *
 * Panel memory, deliberately. It dies with this document and is never written
 * to disk. That is the whole privacy story of this version; the list of pages
 * that are never read at all is the other half — see `excludedWhy`.
 *
 * Before 0.22.0 every query re-injected into every tab and waited on the
 * slowest, then threw the answers away on the next keystroke. Measured, the
 * injections were never the cost — 80 tabs read in ~600ms — the discarding was.
 */

let hitMemo = { key: '', hits: [] };

/** Per-keystroke reset. Reading is query-independent now, so only the memo goes. */
function resetScan() {
  hitMemo = { key: '', hits: [] };
}

let scanRenderTimer = null;
function bumpScan() {
  if (scanRenderTimer) return;
  scanRenderTimer = setTimeout(() => {
    scanRenderTimer = null;
    lastSig = null;
    render();
  }, 120);
}

const scannable = (t) => /^https?:/i.test(t.url || '');

const isAsleep = (t) => t.frozen === true || t.discarded === true;

/* ---- the pages that are never read */

/**
 * The built-in never-read list, loaded on first need. 18,000 domains as a
 * frozen Set: banks, webmail, personal messaging, dating, payment, health
 * portals, password vaults. See tools/build-exclusions.mjs for where it comes
 * from and what it deliberately leaves out.
 */
async function loadBuiltinExclusions() {
  const x = state.exclusions;
  if (x.builtin || x.loading) return x.builtin;
  x.loading = true;
  try {
    const mod = await import('./vendor/exclusions.js');
    x.builtin = new Set(mod.EXCLUDED_DOMAINS);
    x.builtinMeta = mod.EXCLUSIONS_META;
  } catch {
    x.builtin = new Set();
  }
  x.loading = false;
  lastSig = null;
  render();
  return x.builtin;
}

/** The user's own patterns, in the rule syntax, compiled once per change. */
function userExclusions() {
  const x = state.exclusions;
  const list = state.settings.excludeUser || [];
  const raw = list.join('\n');
  if (x.userRaw !== raw) {
    x.userRaw = raw;
    x.user = compileRule({ patterns: list });
  }
  return x.user;
}

/**
 * Why a tab must not be read, or null.
 *
 * Checked before every read AND before every search of the index, so a site
 * added to the list is honoured at once — against text already read, too.
 * While the built-in list is still loading the answer is "not yet", which
 * counts as excluded: the safe default is to read nothing until we know.
 */
function excludedWhy(t) {
  const own = state.scan.skipped.get(t.id);
  if (own) return own;                                    // the page itself said no
  const sp = state.spaceOf[t.id];
  if (sp && sp !== GLOBAL_PIN) {
    const space = liveSpaceById(sp);
    if (space && space.private) return 'space';
  }
  const x = state.exclusions;
  if (state.settings.excludeBuiltin !== false) {
    if (isSearchResultsPage(t.url)) return 'search';
    if (hostLooksPrivate(domainOf(t.url))) return 'account';
    if (!x.builtin) { loadBuiltinExclusions(); return 'pending'; }
    if (hostExcluded(domainOf(t.url), x.builtin)) return 'site';
  }
  if (urlCarriesSecret(t.url)) return 'secret';         // not a list: the address itself is the leak
  if (ruleMatches(userExclusions(), t.url, t.title)) return 'yours';
  return null;
}

const WHY_LABEL = {
  site: 'on the never-read list', yours: 'on your list', space: 'in a private space',
  account: 'a sign-in or account page', search: 'a search results page',
  secret: 'its address carries a password or token',
  noindex: 'asked not to be indexed', login: 'a login page', payment: 'a payment page',
  pending: 'list still loading'
};

/* ---- the index */

function putIndex(tabId, entry) {
  const prev = state.index.get(tabId);
  if (prev) { state.indexBytes -= prev.bytes; state.index.delete(tabId); }
  state.index.set(tabId, entry);
  state.indexBytes += entry.bytes;
  // A Map iterates in insertion order, so the least recently read is first.
  for (const [id, e] of state.index) {
    if (state.indexBytes <= INDEX_TOTAL_CAP) break;
    state.index.delete(id);
    state.indexBytes -= e.bytes;
  }
  state.indexVersion++;
}

/** A tab navigated or closed: what we read of it is no longer true. */
function dropIndex(tabId) {
  const prev = state.index.get(tabId);
  if (prev) {
    state.indexBytes -= prev.bytes;
    state.index.delete(tabId);
    state.indexVersion++;
  }
  state.scan.skipped.delete(tabId);
  state.scan.failed.delete(tabId);
}

function clearIndex() {
  state.index.clear();
  state.indexBytes = 0;
  state.indexVersion++;
  state.scan.skipped.clear();
  state.scan.failed.clear();
}

/**
 * executeScript queues behind the page's own main thread, so a busy tab — a
 * playing video, a heavy SPA — can sit there indefinitely. Cap it so one slow
 * tab can never hold a worker slot hostage.
 */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
  ]);
}

/**
 * Read one tab into the index. The exclusion check runs again here, not just
 * at planning time: the list can change between the two.
 */
async function readTab(tab, token) {
  const s = state.scan;
  if (excludedWhy(tab)) return;
  try {
    const [res] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: PAGE_TEXT,
      // Don't sit behind document_idle: a tab still loading is exactly the kind
      // that would otherwise burn the whole timeout doing nothing.
      injectImmediately: true,
      args: [SCAN_BUDGET_MS]
    }), SCAN_TIMEOUT_MS);
    const r = res && res.result;
    if (token !== s.token) return;
    if (!r || r.ready === false) return;                 // a glance; try again next time
    if (r.skip) { s.skipped.set(tab.id, r.skip); return; }
    // Redacted before it is held, even in memory.
    const text = redact(r.text || '');
    const hash = textHash(text);
    const entry = {
      url: tab.url, title: r.title || tab.title || tab.url,
      text, lower: text.toLowerCase(), hash,
      at: Date.now(), partial: !!r.partial, bytes: text.length * 2
    };
    putIndex(tab.id, entry);
  } catch (e) {
    if (token !== s.token) return;
    if (String(e && e.message) === 'timeout') s.timeouts++;
    s.failed.add(tab.id);
    /* otherwise: restricted page, tab closed mid-read, or injection refused */
  }
}

function startIndex(tabs) {
  const s = state.scan;
  s.token++;
  s.queue = tabs.slice();
  s.total = s.queue.length;
  s.done = 0;
  s.active = 0;
  s.timeouts = 0;
  s.running = s.total > 0;
  pumpIndex(s.token);
}

function pumpIndex(token) {
  const s = state.scan;
  if (token !== s.token) return;
  while (s.active < SCAN_CONCURRENCY && s.queue.length) {
    s.active++;
    indexOne(s.queue.shift(), token);
  }
  if (!s.active && !s.queue.length) s.running = false;
  bumpScan();
}

async function indexOne(tab, token) {
  const s = state.scan;
  await readTab(tab, token);
  if (token !== s.token) return;
  s.done++;
  s.active--;
  // Yield to the event loop so a big read never blocks the panel.
  setTimeout(() => pumpIndex(token), 0);
}

function stopIndex() {
  const s = state.scan;
  s.token++;
  s.running = false;
  s.queue = [];
  s.active = 0;
  s.waking = 0;
  bumpScan();
}

/**
 * Reload a discarded tab and resolve once its new document has finished
 * loading — or false if it never does. A fixed delay would be wrong in both
 * directions: too short reads the half-built page, too long wastes the wait on
 * a page that took 200ms.
 */
function wakeTab(tabId, limitMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => finish(false), limitMs);
    chrome.tabs.reload(tabId).catch(() => finish(false));
  });
}

/**
 * Read the tabs Chrome has discarded: wake each one, read it, put it back.
 *
 * Before 0.21.2 this pushed the discarded tabs into the ordinary queue and
 * injected into them. Injecting into a discarded tab throws — nothing reloads
 * it — and the catch swallowed the error, so the button reported success
 * having read none of them. It had never worked.
 *
 * Only discarded tabs can be woken from here: `tabs.reload` brings one back and
 * `tabs.discard` puts it back afterwards, so the user pays memory only for the
 * duration of the read. A FROZEN tab thaws only on activation and there is no
 * API for it, so those stay skipped and are counted as "asleep".
 *
 * A few at a time: each wake is a network fetch and a renderer process, and
 * forty of them at once is a good way to make the browser unresponsive.
 */
const WAKE_AT_ONCE = 4;

async function wakeAndIndex(tabs) {
  const s = state.scan;
  s.includedSuspended = true;
  if (!tabs.length) return bumpScan();

  const token = s.token;
  s.total += tabs.length;
  s.waking = tabs.length;
  s.running = true;
  bumpScan();

  const pending = [...tabs];
  const worker = async () => {
    while (pending.length && token === s.token) {
      const t = pending.shift();
      const woke = await wakeTab(t.id);
      if (token !== s.token) {
        // Cancelled mid-wake: don't leave a tab awake that was asleep before.
        if (woke) chrome.tabs.discard(t.id).catch(() => {});
        return;
      }
      if (woke) {
        const live = await chrome.tabs.get(t.id).catch(() => t);
        await readTab(live, token);
        // Back to sleep. Fails harmlessly if the user has since activated it.
        await chrome.tabs.discard(t.id).catch(() => {});
      } else {
        s.timeouts++;
        s.failed.add(t.id);
      }
      s.done++;
      s.waking--;
      bumpScan();
    }
  };
  await Promise.all(Array.from({ length: Math.min(WAKE_AT_ONCE, pending.length) }, worker));
  if (token !== s.token) return;
  if (!s.active && !s.queue.length) s.running = false;
  bumpScan();
}

/** Hits for this query against the index, memoised until either changes. */
function pageHits(q, tabs) {
  const key = `${q} ${state.indexVersion} ${tabs.map((t) => t.id).join(',')}`;
  if (hitMemo.key === key) return hitMemo.hits;
  const hits = [];
  for (const t of tabs) {
    const entry = state.index.get(t.id);
    if (!entry) continue;
    const r = searchText(entry, q);
    if (r.count) {
      hits.push({
        tabId: t.id, title: t.title || entry.title || t.url, url: t.url,
        count: r.count, snippet: r.snippet, partial: entry.partial, asleep: isAsleep(t)
      });
    }
  }
  hits.sort((a, b) => b.count - a.count);
  hitMemo = { key, hits };
  return hits;
}

function pageTextSection(q, shownIds) {
  const s = state.scan;
  const nodes = [];
  const all = state.tabs.filter((t) => scannable(t) && !shownIds.has(t.id));
  if (!all.length) return nodes;

  if (!s.granted) {
    nodes.push(sectionLabel('Page text'));
    const chip = el('button', 'perm-chip scan-chip');
    chip.innerHTML =
      `<b>Search inside the text of ${all.length} open tabs</b><br>` +
      'Asks Chrome once for page access. Each tab is read once, when you search; ' +
      'the text stays in this panel and is never written to disk. Webmail, banks and ' +
      'the like are never read — Settings lists them.';
    chip.addEventListener('click', async () => {
      const ok = await chrome.permissions
        .request({ permissions: ['scripting'], origins: ['<all_urls>'] })
        .catch(() => false);
      if (!ok) return toast('Page access declined');
      s.granted = true;
      lastSig = null;
      render();
      toast('Page access granted');
    });
    nodes.push(chip);
    return nodes;
  }

  const plan = planIndex(all, {
    indexed: new Set(state.index.keys()), failed: s.failed, isExcluded: excludedWhy
  });
  const eligible = all.filter((t) => !excludedWhy(t));

  // Read on our own when there is something unread and nothing in flight — the
  // grant was the consent, and a search that has to be clicked to start is the
  // thing that made this feel slow. Throttled so a tab that keeps answering
  // "still loading" isn't re-asked on every keystroke.
  if (q.length >= 2 && plan.queue.length && !s.running && Date.now() - s.lastAutoAt > AUTO_READ_GAP_MS) {
    s.lastAutoAt = Date.now();
    startIndex(plan.queue);
  }

  const hits = pageHits(q, eligible);
  nodes.push(sectionLabel(
    s.running ? `Page text · ${hits.length} so far` : `Page text · ${hits.length}`));

  /* ---- status: what is being searched, what isn't, and why */
  const bar = el('div', 'scan-bar');
  if (s.running) {
    bar.append(el('span', 'scan-progress',
      `Reading ${s.done} of ${s.total}…${s.waking ? ` waking ${s.waking}` : ''}`));
    const cancel = el('button', 'ghost-btn', 'Stop');
    cancel.addEventListener('click', stopIndex);
    bar.append(cancel);
  } else {
    const notes = [];
    const sleepingRead = eligible.filter((t) => isAsleep(t) && state.index.has(t.id)).length;
    if (plan.asleep.length) notes.push(`${plan.asleep.length} asleep and unread`);
    if (sleepingRead) notes.push(`${sleepingRead} asleep but read earlier`);
    if (s.failed.size) notes.push(`${s.failed.size} did not answer`);
    const line = el('span', 'scan-progress',
      `Searching ${plan.searchable} tab${plan.searchable === 1 ? '' : 's'}${notes.length ? ` · ${notes.join(', ')}` : ''}`);
    line.title =
      'Asleep and unread: Chrome froze or unloaded the tab before it was read. A frozen tab ' +
      'cannot be read until you visit it; an unloaded one can be woken.\n' +
      'Did not answer: the page was too busy, or refused the reader. Re-index retries them.';
    bar.append(line);
    if (plan.queue.length) {
      const go = el('button', 'ghost-btn', `Read ${plan.queue.length} more`);
      go.title = 'Tabs opened since the last read, or not read yet.';
      go.addEventListener('click', () => startIndex(plan.queue));
      bar.append(go);
    }
    const discarded = plan.asleep.filter((t) => t.discarded);
    if (discarded.length && !s.includedSuspended) {
      const inc = el('button', 'ghost-btn',
        `Wake ${discarded.length} sleeping tab${discarded.length === 1 ? '' : 's'} and read ${discarded.length === 1 ? 'it' : 'them'}`);
      inc.title = 'Reloads each one, reads it, and puts it back to sleep — a few at a ' +
        'time. Anything unsaved on those pages is lost when they reload.';
      inc.addEventListener('click', () => wakeAndIndex(discarded));
      bar.append(inc);
    }
    if (state.index.size) {
      const again = el('button', 'ghost-btn', 'Re-index');
      again.title = 'Forget every page read so far and read them all again, including ones that did not answer.';
      again.addEventListener('click', () => {
        clearIndex();
        s.includedSuspended = false;
        const fresh = planIndex(all, { isExcluded: excludedWhy });
        startIndex(fresh.queue);
      });
      bar.append(again);
    }
  }
  nodes.push(bar);

  /* ---- the pages that were not read, said out loud */
  if (plan.excluded.length) {
    const hosts = [...new Set(plan.excluded.map((x) => domainOf(x.tab.url) || 'page'))];
    const note = el('div', 'scan-note');
    const shown = hosts.slice(0, 3).join(', ') + (hosts.length > 3 ? ` and ${hosts.length - 3} more` : '');
    note.append(el('span', null,
      `${plan.excluded.length} tab${plan.excluded.length === 1 ? '' : 's'} never read — ${shown}. `));
    note.title = [...new Set(plan.excluded.map((x) => WHY_LABEL[x.why] || x.why))].join('; ');
    const edit = el('button', 'link-btn', 'Settings');
    edit.addEventListener('click', () => setMode('manage', { view: 'settings' }));
    note.append(edit);
    nodes.push(note);
  }

  hits.forEach((h) => nodes.push(textHitRow(h)));

  if (!s.running && !hits.length && plan.searchable) {
    nodes.push(el('div', 'scan-empty', 'No page text matched.'));
  }

  const revoke = el('button', 'revoke-btn', 'Revoke page access');
  revoke.addEventListener('click', async () => {
    await chrome.permissions.remove({ permissions: ['scripting'], origins: ['<all_urls>'] })
      .catch(() => {});
    s.granted = false;
    stopIndex();
    clearIndex();          // no longer permitted to hold it, either
    resetScan();
    lastSig = null;
    render();
    toast('Page access revoked');
  });
  nodes.push(revoke);

  return nodes;
}

function textHitRow(hit) {
  const row = el('div', 'tab-row text-hit');
  row.dataset.id = String(hit.tabId);
  row.append(letterTile(domainOf(hit.url) || hit.title));

  const col = el('span', 'col');
  const line = el('span', 'title', hit.title);
  col.append(line);
  col.append(el('span', 'sub', hit.snippet || prettyUrl(hit.url)));
  row.append(col);

  if (hit.asleep) {
    const z = el('span', 'badge', '💤');
    z.title = 'Asleep — read before Chrome put it to sleep. Click to wake it.';
    row.append(z);
  }
  row.append(el('span', 'badge count', `${hit.count}${hit.partial ? '+' : ''}`));
  // Text hits have no hover card, so the native tooltip is the only way to see
  // the URL. It is left in place here for that reason, and only here.
  row.title = hit.url + (hit.partial ? '\nOnly part of this page was read — it is very large.' : '');
  row.addEventListener('pointerdown', (e) => {
    if (e.button === 0) activateTab(hit.tabId);
  });
  return row;
}

/* ------------------------------------------------------------ elements */

function sectionLabel(text) { return el('div', 'section-label', text); }

function emptyState(title, body) {
  const box = el('div', 'empty');
  box.append(el('strong', null, title), document.createTextNode(body));
  return box;
}

function letterTile(text) {
  const s = el('span', 'letter', (text || '?').trim().charAt(0) || '?');
  s.style.background = `hsl(${hueFor(text || '?')} 52% 45%)`;
  return s;
}

function favicon(t) {
  const url = t.favIconUrl;
  if (url && /^(https?:|data:)/i.test(url)) {
    const img = el('img', 'fav');
    img.src = url;
    img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(letterTile(domainOf(t.url) || t.title)));
    return img;
  }
  return letterTile(domainOf(t.url) || t.title || '?');
}

function linkRow(title, url, meta) {
  const row = el('div', 'tab-row');
  row.dataset.url = url;
  row.append(letterTile(domainOf(url) || title));
  const col = el('span', 'col');
  col.append(el('span', 'title', title));
  col.append(el('span', 'sub', meta || prettyUrl(url)));
  row.append(col);
  row.title = `${title}\n${url}`;
  row.addEventListener('pointerdown', (e) => {
    if (e.button === 0) openInPanelWindow(url);
  });
  return row;
}

/** Build a row once; afterwards only its changed parts are touched. */
function buildRow() {
  const row = el('div', 'tab-row');
  row.draggable = true;

  const favSlot = el('span', 'fav-slot');
  const title = el('span', 'title');
  const host = el('span', 'host');
  const badge = el('span', 'badge');
  const close = el('button', 'icon-btn close', '×');
  close.title = 'Close tab';
  row.append(favSlot, title, host, badge, close);
  row._parts = { favSlot, title, host, badge, close };

  // Acting on pointerdown rather than click: a re-render between mousedown and
  // mouseup moves the node in the DOM, which cancels the click outright. That
  // was the "sometimes the × does nothing" bug.
  close.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    row._suppressClick = true;
    closeTab(row._tab.id);
  });
  close.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });

  // Activation also runs on pointerdown, for the same reason as the × above:
  // any re-render between press and release cancels the click. This is how
  // Chrome's own tab strip behaves — press selects, then you may drag.
  row.addEventListener('pointerdown', (e) => {
    if (row._suppressClick) { row._suppressClick = false; return; }
    if (e.button === 2) return;                       // right-click → context menu
    if (e.button === 1) { e.preventDefault(); return closeTab(row._tab.id); }
    if (e.button !== 0) return;

    hideCtx();
    const t = row._tab;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); return toggleSelect(t.id); }
    if (e.shiftKey) { e.preventDefault(); return rangeSelect(t.id); }
    if (state.selection.size) clearSelection();
    activateTab(t.id);
  });
  row.addEventListener('contextmenu', (e) => { hideTabPop(); showCtx(e, row._tab); });

  row.addEventListener('mouseenter', (e) => armTabPop(row, e));
  row.addEventListener('mouseleave', hideTabPop);

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(row._tab.id));
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
    hideTabPop();
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    const srcId = Number(e.dataTransfer.getData('text/plain'));
    if (!srcId || srcId === row._tab.id) return;
    const ids = state.selection.has(srcId) ? [...state.selection] : [srcId];
    await chrome.tabs.move(ids, { index: row._tab.index }).catch(() => {});
  });

  return row;
}

function tabRow(t, showHost = false) {
  let row = rowCache.get(t.id);
  if (!row) { row = buildRow(); rowCache.set(t.id, row); }
  row._tab = t;

  const { favSlot, title, host, badge } = row._parts;
  if (row.dataset.id !== String(t.id)) row.dataset.id = String(t.id);
  row.classList.toggle('is-active', !!t.active);
  row.classList.toggle('is-selected', state.selection.has(t.id));

  const wantIcon = t.favIconUrl && /^(https?:|data:)/i.test(t.favIconUrl) ? t.favIconUrl : '';
  if (favSlot._src !== wantIcon) {
    favSlot._src = wantIcon;
    favSlot.replaceChildren(favicon(t));
  }

  const label = t.title || t.url || 'Untitled';
  if (title.textContent !== label) {
    title.textContent = label;
  }
  // Deliberately NO `title` attribute.
  //
  // That produced a *native* tooltip — the browser's own two-line box with the
  // title and URL. Native tooltips are drawn by the OS, so unlike anything this
  // document can paint they spill outside the panel and land on top of it. It
  // also appears a beat AFTER the hover card, so even a correctly-placed card
  // beside the panel was followed by a plain box over the rail a moment later.
  // Every previous attempt to "fix the preview position" was aimed at the wrong
  // popover. The hover card already carries the full title and the domain.

  const hostText = showHost ? prettyUrl(t.url) : '';
  if (host.textContent !== hostText) host.textContent = hostText;
  host.hidden = !showHost;

  const mark = (t.mutedInfo && t.mutedInfo.muted) ? '🔇'
    : t.audible ? '🔊' : t.discarded ? '💤' : '';
  if (badge.textContent !== mark) badge.textContent = mark;
  badge.hidden = !mark;

  return row;
}

function groupBlock(gid, members) {
  const g = state.groups.find((x) => x.id === gid);
  let c = groupCache.get(gid);

  if (!c) {
    const wrap = el('div', 'group');
    const head = el('div', 'group-head');
    const caret = el('span', 'caret', '▾');
    const name = el('span', 'gname');
    const count = el('span', 'n');
    head.append(caret, name, count);
    const body = el('div', 'group-body');
    wrap.append(head, body);
    c = { wrap, head, body, name, count, caret };
    groupCache.set(gid, c);

    head.addEventListener('click', () => {
      const cur = state.groups.find((x) => x.id === gid);
      chrome.tabGroups.update(gid, { collapsed: !(cur && cur.collapsed) }).catch(() => {});
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ids = [...c.body.childNodes].map((n) => Number(n.dataset.id)).filter(Boolean);
      openCtx(e, [
        ['Rename group…', () => renameGroup(gid)],
        ['Ungroup these tabs', () => chrome.tabs.ungroup(ids)],
        ['Select all in group', () => { ids.forEach((id) => state.selection.add(id)); lastSig = null; render(); }],
        ['Make a rule from this group', () => makeRuleFromGroup(gid)],
        null,
        ['Close group', () => chrome.tabs.remove(ids), true]
      ]);
    });
  }

  c.wrap.style.setProperty('--gc', `var(--g-${(g && g.color) || 'grey'})`);
  c.wrap.classList.toggle('collapsed', !!(g && g.collapsed));
  const label = (g && g.title) || domainOf(members[0].url) || 'Group';
  if (c.name.textContent !== label) c.name.textContent = label;
  const n = String(members.length);
  if (c.count.textContent !== n) c.count.textContent = n;

  syncChildren(c.body, members.map((m) => tabRow(m)));
  return c.wrap;
}

/**
 * Rename a tab group — and the rule behind it, when there is one.
 *
 * A rule names its group after itself, so renaming only the group is undone the
 * moment the rules run again: the next pass looks for a group titled after the
 * rule, doesn't find one, and builds a fresh group with the old name, taking
 * these tabs back with it. Renaming both is the only version that survives.
 */
async function renameGroup(gid) {
  const g = state.groups.find((x) => x.id === gid);
  if (!g) return;
  const was = g.title || '';
  const rule = was
    ? state.rules.find((r) => (r.name || '').toLowerCase() === was.toLowerCase())
    : null;

  const ans = await openDialog({
    title: 'Rename group',
    message: rule
      ? `These tabs are grouped by the rule <strong>${esc(rule.name)}</strong>, so the rule ` +
        'is renamed too. Renaming only the group would be undone the next time the rules ' +
        'run — they would rebuild the old group and move these tabs back into it.'
      : '',
    name: was,
    wantName: true,
    buttons: [
      { label: 'Rename', value: 'ok', primary: true },
      { label: 'Cancel', value: null }
    ]
  });
  if (!ans || !ans.name || ans.name === was) return;

  await chrome.tabGroups.update(gid, { title: ans.name }).catch(() => {});

  if (rule) {
    rule.name = ans.name;
    await saveRules();
    if (state.view === 'rules') renderRules(true);
  }

  // The jump-bar order is keyed by group NAME, not id — Chrome regenerates ids
  // on restart — so a rename would otherwise drop the chip back to the end.
  const order = [...(state.groupOrder || [])];
  const at = order.indexOf(`t:${was.toLowerCase()}`);
  if (at !== -1) {
    order[at] = `t:${ans.name.toLowerCase()}`;
    await saveGroupOrder(order);
  }

  lastSig = null;
  render();
  toast(rule ? `Renamed the group and its rule to ${ans.name}` : `Renamed to ${ans.name}`);
}

/* -------------------------------------------------------- interactions */

function activateTab(id) {
  chrome.tabs.update(id, { active: true }).catch(() => {});
  chrome.windows.update(state.windowId, { focused: true }).catch(() => {});
}

/**
 * Close a tab and confirm it actually went. A page with an onbeforeunload
 * handler ("Leave site?") can keep itself open — say so rather than looking
 * like the button is broken.
 */
async function closeTab(id) {
  const row = rowCache.get(id);
  if (row) row.style.opacity = '0.35'; // immediate feedback
  try {
    await chrome.tabs.remove(id);
  } catch {
    if (row) row.style.opacity = '';
    return toast('Chrome refused to close that tab');
  }
  setTimeout(async () => {
    const alive = await chrome.tabs.get(id).catch(() => null);
    if (alive) {
      const r = rowCache.get(id);
      if (r) r.style.opacity = '';
      toast('That page is asking to stay open');
    }
  }, 500);
}

function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.anchorId = id;
  lastSig = null;
  render();
}

function rangeSelect(id) {
  const order = state.tabs.map((t) => t.id);
  const a = order.indexOf(state.anchorId ?? id);
  const b = order.indexOf(id);
  if (a === -1 || b === -1) return toggleSelect(id);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) state.selection.add(order[i]);
  lastSig = null;
  render();
}

function clearSelection() { state.selection.clear(); lastSig = null; render(); }

async function bulk(action) {
  const ids = [...state.selection];
  if (!ids.length) return;
  const sel = state.tabs.filter((t) => ids.includes(t.id));

  switch (action) {
    case 'clear': return clearSelection();
    case 'close':
      await chrome.tabs.remove(ids).catch(() => {});
      state.selection.clear();
      return toast(`Closed ${ids.length}`);
    case 'pin': {
      const target = !sel.every((t) => t.pinned);
      for (const t of sel) await chrome.tabs.update(t.id, { pinned: target }).catch(() => {});
      return toast(target ? `Pinned ${ids.length}` : `Unpinned ${ids.length}`);
    }
    case 'mute': {
      const target = !sel.every((t) => t.mutedInfo && t.mutedInfo.muted);
      for (const t of sel) await chrome.tabs.update(t.id, { muted: target }).catch(() => {});
      return toast(target ? `Muted ${ids.length}` : `Unmuted ${ids.length}`);
    }
    case 'group': {
      try {
        const gid = await chrome.tabs.group({
          tabIds: ids, createProperties: { windowId: state.windowId }
        });
        const hosts = sel.map((t) => domainOf(t.url)).filter(Boolean);
        const common = hosts.length && hosts.every((h) => h === hosts[0]) ? hosts[0] : '';
        await chrome.tabGroups.update(gid, { title: common });
        state.selection.clear();
        toast(`Grouped ${ids.length}`);
      } catch { toast('Could not group those'); }
      return;
    }
  }
}

/* ----------------------------------------------------- duplicates sheet */

function closeSheet() { $('#sheet').hidden = true; }

function dupeBoxes() {
  return [...document.querySelectorAll('#sheet-body input[type="checkbox"]')];
}

function updateDupeCount() {
  const n = dupeBoxes().filter((b) => b.checked).length;
  const go = $('#sheet-go');
  go.textContent = `Close ${n} tab${n === 1 ? '' : 's'}`;
  go.disabled = n === 0;
  dupeBoxes().forEach((b) => b.closest('.dupe-row').classList.toggle('is-checked', b.checked));
}

function setAllDupes(on) {
  dupeBoxes().forEach((b) => { b.checked = on; });
  updateDupeCount();
}

async function openDupeSheet() {
  const r = await send({ type: 'find-duplicates', windowId: state.windowId });
  const groups = (r && r.groups) || [];

  if (!groups.length) {
    return toast('No duplicate tabs');
  }

  const body = $('#sheet-body');
  body.replaceChildren();

  let closable = 0;
  for (const g of groups) {
    closable += g.tabs.length - 1;

    const box = el('div', 'dupe-group');
    const head = el('div', 'dupe-url');
    head.append(letterTile(domainOf(g.url) || g.title));
    const u = el('span', 'u', g.url);
    u.title = g.url;
    head.append(u, el('span', 'n', `${g.tabs.length}×`));
    box.append(head);

    for (const t of g.tabs) {
      const row = el('label', 'dupe-row' + (t.keep ? ' is-keep' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = String(t.id);
      cb.checked = !t.keep; // suggest closing everything but the keeper
      cb.addEventListener('change', updateDupeCount);
      row.append(cb, el('span', 't', t.title));
      if (t.tracked && t.tracked.length) {
        const tag = el('span', 'tag muted', `+${t.tracked.length} tracking`);
        tag.title = `Ignored when matching: ${t.tracked.join(', ')}`;
        row.append(tag);
      }
      if (t.keep) row.append(el('span', 'tag', t.active ? 'active' : 'keep'));
      box.append(row);
    }
    body.append(box);
  }

  $('#sheet-title').textContent =
    `${groups.length} duplicate URL${groups.length === 1 ? '' : 's'} · ${closable} closable`;
  $('#sheet').hidden = false;
  updateDupeCount();
}

async function closeCheckedDupes() {
  const ids = dupeBoxes().filter((b) => b.checked).map((b) => Number(b.value));
  if (!ids.length) return;
  closeSheet();
  try {
    await chrome.tabs.remove(ids);
    toast(`Closed ${ids.length} tab${ids.length === 1 ? '' : 's'}`);
  } catch {
    toast('Some tabs refused to close');
  }
}

/* ------------------------------------------------------------ hover card */

let hoverTimer = null;
let hoverTabId = null;
let cardInTab = null;   // tab id currently displaying an injected card

function clearPageCard() {
  if (cardInTab === null) return;
  const tabId = cardInTab;
  cardInTab = null;
  chrome.scripting.executeScript({ target: { tabId }, func: PAGE_CARD, args: [null] })
    .catch(() => { /* tab gone or restricted — the card self-destructs anyway */ });
}

function hideTabPop() {
  clearTimeout(hoverTimer);
  hoverTimer = null;
  hoverTabId = null;
  const pop = $('#tabpop');
  if (pop) pop.hidden = true;
  clearPageCard();
}

/**
 * Where the cursor was when it entered the row, in real screen coordinates.
 *
 * This is the only trustworthy geometry a side panel has. `window.screenX` is
 * not: Chrome reports the browser window's left edge for both the panel and the
 * page, so it cannot say which side the panel is docked on. A mouse event's
 * screenX/screenY come from the OS event itself and are genuine.
 */
let lastPointer = null;

function armTabPop(row, ev) {
  if (ev && Number.isFinite(ev.screenX)) {
    lastPointer = { screenX: ev.screenX, screenY: ev.screenY, clientY: ev.clientY };
  }
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showTabPop(row), HOVER_DELAY_MS);
}

/**
 * Which edge is the panel docked on, and where does the panel's viewport begin
 * inside the browser window? Both are derived from the cursor: it is over the
 * panel right now, so whichever panel-width slice of the window contains it is
 * the side the panel is on.
 *
 * @returns {{side:'left'|'right', viewportTop:number}|null}
 */
async function panelGeometry() {
  if (!lastPointer) return null;
  const win = await chrome.windows.get(state.windowId).catch(() => null);
  if (!win || !Number.isFinite(win.left) || !win.width) return null;

  const side = dockSide({
    cursorScreenX: lastPointer.screenX,
    windowLeft: win.left,
    windowWidth: win.width,
    panelWidth: document.documentElement.clientWidth || 360
  });

  // Where the panel's own viewport starts, measured down from the top of the
  // window frame — again from the cursor, for the same reason.
  return { side, viewportTop: (lastPointer.screenY - lastPointer.clientY) - win.top };
}

async function showTabPop(row) {
  const t = row && row._tab;
  if (!t) return;
  if (!$('#ctxmenu').hidden || !$('#sheet').hidden) return; // don't stack over a menu
  if (!$('#dialog-back').hidden) return;
  if (row.classList.contains('dragging')) return;

  hoverTabId = t.id;
  const rec = await getThumb(t.id);
  if (hoverTabId !== t.id) return; // moved on while we were reading storage

  const chips = [];
  if (t.active) chips.push('active');
  if (t.pinned) chips.push('pinned');
  if (t.discarded) chips.push('suspended');
  if (t.audible) chips.push('playing audio');
  if (t.mutedInfo && t.mutedInfo.muted) chips.push('muted');
  if (t.groupId !== NONE) {
    const g = state.groups.find((x) => x.id === t.groupId);
    if (g && g.title) chips.push(g.title);
  }
  if (t.lastAccessed && !t.active) chips.push(`seen ${timeAgo(t.lastAccessed)}`);
  if (rec && rec.at) chips.push(`shot ${timeAgo(rec.at)}`);

  const noShot = state.scan.granted
    ? 'No preview yet — visit this tab and it will be captured'
    : 'Previews need page access';

  // Preferred: draw it in the page, beside the panel. A side panel cannot paint
  // outside its own frame, so this is the only way to avoid covering the list.
  const why = await renderPageCard(row, t, rec, chips, noShot);
  if (!why) return;

  // Fallback: draw inside the panel, over the list — and say why, because
  // "sometimes it's beside the panel and sometimes on top of it" is otherwise
  // indistinguishable from the feature being broken.
  renderPanelCard(row, t, rec, chips, noShot, why);
}

/**
 * @returns {Promise<string|null>} null when the page took the card, otherwise a
 * short reason it couldn't, for the fallback to show.
 */
async function renderPageCard(row, t, rec, chips, noShot) {
  if (!state.scan.granted) return 'page access is off — turn it on in Settings';
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId: state.windowId });
    if (!active) return 'no active tab to draw into';

    // The card is drawn into whichever tab you are LOOKING at, because that is
    // the only surface next to the panel. A chrome:// page, the Web Store, a
    // PDF or a blank tab refuses injection, and no extension can override that.
    const url = active.url || '';
    if (!/^https?:/i.test(url) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)) {
      const what = /^chrome:/i.test(url) ? 'a chrome:// page'
        : /^chrome-extension:/i.test(url) ? 'an extension page'
        : /webstore|chromewebstore/i.test(url) ? 'the Web Store'
        : /^(about|file|view-source|devtools):/i.test(url) ? `a ${url.split(':')[0]}: page`
          : 'this page';
      return `the open tab is ${what}, which blocks overlays — switch to a normal page`;
    }
    if (active.discarded) return 'the open tab is suspended';

    // Without geometry we can't say which edge the panel is on, and guessing
    // wrong throws the card to the far side of the screen. Use the panel's own
    // pop-over instead — wrong place beats opposite place.
    const geo = await panelGeometry();
    if (!geo) return 'panel position unknown';

    const r = row.getBoundingClientRect();
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: active.id },
      func: PAGE_CARD,
      args: [{
        title: t.title || t.url || 'Untitled',
        host: domainOf(t.url) || prettyUrl(t.url),
        thumb: rec && rec.d ? rec.d : '',
        chips,
        noShot,
        side: geo.side,
        anchorY: geo.viewportTop + r.top
      }]
    });
    if (res && res.result) {
      cardInTab = active.id;
      $('#tabpop').hidden = true;
      return null;
    }
    return 'the open page has no body to draw into yet';
  } catch {
    return 'the open page refused the overlay';
  }
}

function renderPanelCard(row, t, rec, chips, noShot, why) {
  const pop = $('#tabpop');
  pop.replaceChildren();

  // At the top, not the bottom. This card only appears when the preview cannot
  // sit beside the panel, and the reason was being missed at the foot of a card
  // whose thumbnail draws the eye — so the card read as a positioning bug four
  // separate times.
  if (why) pop.append(el('div', 'pop-why', why));

  if (rec && rec.d) {
    const img = el('img', 'shot');
    img.src = rec.d;
    img.alt = '';
    pop.append(img);
  } else {
    pop.append(el('div', 'shot-none', noShot));
  }

  const body = el('div', 'body');
  body.append(el('div', 'pop-title', t.title || t.url || 'Untitled'));

  const host = el('div', 'pop-host');
  host.append(letterTile(domainOf(t.url) || t.title));
  host.append(el('span', null, domainOf(t.url) || prettyUrl(t.url)));
  body.append(host);

  if (chips.length) {
    const box = el('div', 'pop-chips');
    chips.forEach((c) => box.append(el('span', 'chip', c)));
    body.append(box);
  }

  pop.append(body);
  pop.hidden = false;
  positionTabPop(pop, row);
}

/** Anchor beside the row, flipped and clamped to stay on screen. */
function positionTabPop(pop, row) {
  const r = row.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const margin = 8;

  let top = r.top;
  if (top + p.height > window.innerHeight - margin) top = window.innerHeight - p.height - margin;
  if (top < margin) top = margin;

  let left = Math.round((window.innerWidth - p.width) / 2);
  if (left < margin) left = margin;

  pop.style.left = `${left}px`;
  pop.style.top = `${Math.round(top)}px`;
}

async function getThumb(tabId) {
  try {
    const key = THUMB_PREFIX + tabId;
    const out = await chrome.storage.session.get(key);
    return out[key] || null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- context menu */

let ctxWatch = null;
let ctxTimer = null;

/** Auto-dismiss after `ms`, unless something cancels it first. */
function armCtxDismiss(ms) {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(hideCtx, ms);
}

function hideCtx() {
  $('#ctxmenu').hidden = true;
  if (ctxWatch) { clearInterval(ctxWatch); ctxWatch = null; }
  clearTimeout(ctxTimer);
  ctxTimer = null;
}

function openCtx(e, items) {
  e.preventDefault();
  const menu = $('#ctxmenu');
  menu.replaceChildren();
  for (const item of items) {
    if (!item) { menu.append(el('hr')); continue; }
    const [label, fn, danger] = item;
    const b = el('button', danger ? 'danger' : null, label);
    b.addEventListener('click', () => { hideCtx(); Promise.resolve(fn()).catch(() => {}); });
    menu.append(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 6))}px`;

  menu.tabIndex = -1;
  try { menu.focus({ preventScroll: true }); } catch { /* ignore */ }

  // Dismissal is awkward here: a click landing in the web page raises no event
  // this document can see, and Chrome routinely never gives the side panel
  // focus at all — so document.hasFocus() can be false the whole time.
  //
  // Hence: only ever close on a TRANSITION from focused to unfocused. Testing
  // the absolute value would kill the menu on the first tick in a side panel,
  // which is exactly the bug this replaced.
  menu._sawFocus = document.hasFocus();
  if (ctxWatch) clearInterval(ctxWatch);
  ctxWatch = setInterval(() => {
    if (menu.hidden) return hideCtx();
    if (document.hasFocus()) menu._sawFocus = true;
    else if (menu._sawFocus) hideCtx();
  }, 150);

  // Belt and braces for the case where focus never arrives: moving the pointer
  // away closes it shortly after, and it never lingers indefinitely.
  armCtxDismiss(CTX_MAX_MS);
}

function showCtx(e, t) {
  e.stopPropagation();
  const muted = !!(t.mutedInfo && t.mutedInfo.muted);
  const host = domainOf(t.url);
  const others = state.tabs.filter((x) => x.id !== t.id && !x.pinned).map((x) => x.id);
  const below = state.tabs.filter((x) => x.index > t.index && !x.pinned).map((x) => x.id);

  const items = [
    ['Copy URL', () => copy(t.url)],
    ['Duplicate', () => chrome.tabs.duplicate(t.id)],
    ['Reload', () => chrome.tabs.reload(t.id)],
    null,
    [t.pinned ? 'Unpin' : 'Pin', () => chrome.tabs.update(t.id, { pinned: !t.pinned })],
    [muted ? 'Unmute' : 'Mute', () => chrome.tabs.update(t.id, { muted: !muted })],
    [t.discarded ? 'Wake tab' : 'Suspend tab', () =>
      t.discarded ? chrome.tabs.reload(t.id) : chrome.tabs.discard(t.id)],
    null,
    ['Move to new window', () => chrome.windows.create({ tabId: t.id, focused: true })],
    [t.groupId !== NONE ? 'Remove from group' : 'Group this tab', () =>
      t.groupId !== NONE
        ? chrome.tabs.ungroup([t.id])
        : chrome.tabs.group({ tabIds: [t.id], createProperties: { windowId: state.windowId } })]
  ];

  if (/^https?:/i.test(t.url || '')) items.push(null, ...pageActionItems(t));
  // Moving between spaces is a label change: the tab does not move, close or
  // reload, so this is safe to offer on anything.
  const targets = [mainSpace(), ...state.spaces]
    .filter((sp) => sp.id !== (state.spaceOf[t.id] || MAIN));
  if (targets.length) {
    items.push(null, ...targets.slice(0, 6).map((sp) =>
      [`Move to ${sp.emoji ? `${sp.emoji} ` : ''}${sp.name}`,
        () => moveTabsToSpace(state.selection.size ? [...state.selection] : [t.id], sp.id)]));
  }
  if (t.pinned) {
    const global = isGlobalPin(t);
    items.push([global ? 'Pin in this space only' : 'Pin in every space', () =>
      moveTabsToSpace([t.id], global ? state.activeSpaceId : GLOBAL_PIN)]);
  }
  if (host) items.push([`New rule for ${host}`, () => newRule(host, [host])]);
  items.push(
    null,
    ['Close others', () => others.length && chrome.tabs.remove(others), true],
    ['Close tabs below', () => below.length && chrome.tabs.remove(below), true],
    ['Close', () => chrome.tabs.remove(t.id), true]
  );

  openCtx(e, items);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('URL copied'); }
  catch { toast('Copy blocked by Chrome'); }
}

/* ------------------------------------------------------------ data I/O */

/** Human summary of a backup payload, e.g. "12 workspaces, 3 rules". */
function describeData(data) {
  const parts = DATA_KEYS
    .filter((k) => data[k] !== undefined)
    .map((k) => {
      const v = data[k];
      const n = Array.isArray(v) ? v.length
        : (v && typeof v === 'object' ? Object.keys(v).length : 1);
      return `${n} ${k}`;
    });
  return parts.length ? parts.join(', ') : 'nothing recognisable';
}

async function exportData() {
  // chrome.storage.local only. Page text is never stored anywhere, so a backup
  // can never carry the text of pages you read.
  const all = await chrome.storage.local.get(null);
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const payload = {
    app: 'SideRail', version: VERSION, exportedAt: now.toISOString(), data: all
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `siderail-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`Exported ${describeData(all)}`);
}

/**
 * Accepts either this app's wrapped export, or a raw chrome.storage.local dump
 * (what `chrome.storage.local.get(null)` gives you from the console) — so a
 * backup taken from the old build restores here without editing.
 */
export function unwrapBackup(parsed) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
    return parsed.data;
  }
  return parsed;
}

async function importData(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return toast('That file is not valid JSON');
  }

  const data = unwrapBackup(parsed);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return toast('Unrecognised backup format');
  }

  const known = DATA_KEYS.filter((k) => data[k] !== undefined);
  if (!known.length) return toast('No SideRail data found in that file');

  // Shape, at least. A backup is user-supplied input written straight into
  // storage, and every renderer trusts `spaces` to be an array and `settings`
  // to be an object. A hand-edited or truncated file with `"spaces": {}` used
  // to import cleanly and then throw on the next render, with no way back in
  // except another import.
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const SHAPE = {
    spaces: Array.isArray, globalPins: Array.isArray, mainSpace: isObj, workspaces: Array.isArray,
    snapshots: Array.isArray, rules: Array.isArray, settings: isObj, groupOrder: Array.isArray
  };
  const wrong = known.find((k) => !SHAPE[k](data[k]));
  if (wrong) return toast(`“${wrong}” in that file is not the right shape — nothing was imported`);

  const summary = describeData(data);
  if (!confirm(
    `Restore ${summary}?\n\n` +
    'This replaces the current value of those items. Anything not in the file is left alone.'
  )) return;

  const toWrite = {};
  for (const k of known) toWrite[k] = data[k];
  await chrome.storage.local.set(toWrite);

  [state.snapshots, state.rules, state.settings, state.groupOrder] =
    await Promise.all([
      getStore('snapshots', []),
      getStore('rules', []),
      getStore('settings', { autoApply: true }),
      getStore('groupOrder', [])
    ]);
  // An import can bring spaces with it, and their membership has to be
  // rebuilt against the tabs actually open — the imported ids mean nothing here.
  state.spaces = await loadSpaces();
  state.spacesReady = false;
  await rebuildMembership();

  rulesDomKey = null;
  settingsBuilt = false;   // an import can change the appearance settings too
  applyAppearance();
  lastSig = null;
  if (state.view === 'rules') renderRules(true); else render();
  toast(`Restored ${summary}`);
}

function pickImportFile() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.addEventListener('change', () => {
    if (inp.files && inp.files[0]) importData(inp.files[0]);
  });
  inp.click();
}

/* --------------------------------------------------------- page actions */

/**
 * One grant covers both page-text search and Defuddle, so you're asked once
 * rather than per site.
 */
async function refreshGrants() {
  state.hasBH = await chrome.permissions
    .contains({ permissions: ['bookmarks', 'history'] }).catch(() => false);
  state.scan.granted = await chrome.permissions
    .contains({ permissions: ['scripting'], origins: ['<all_urls>'] }).catch(() => false);
  lastSig = null;
  render();
}

async function ensurePageAccess() {
  if (state.scan.granted) return true;
  const ok = await chrome.permissions
    .request({ permissions: ['scripting'], origins: ['<all_urls>'] })
    .catch(() => false);
  if (ok) state.scan.granted = true;
  return ok;
}

/**
 * Injected into the page. Replaces the document with Defuddle's extracted
 * article. Runs in the page's own world, so it gains no extension privilege —
 * a reload puts everything back.
 */
function APPLY_READER() {
  try {
    const G = window.Defuddle;
    const Cls = (G && (G.Defuddle || G.default)) || G;
    if (typeof Cls !== 'function') return { ok: false, error: 'library did not load' };
    if (document.documentElement.dataset.siderailReader === '1') {
      return { ok: false, error: 'already in reader view' };
    }

    const r = new Cls(document).parse();
    if (!r || !r.content || (r.wordCount || 0) < 20) {
      return { ok: false, error: 'no article found on this page' };
    }

    document.querySelectorAll('link[rel~="stylesheet"], style').forEach((n) => n.remove());

    const style = document.createElement('style');
    style.textContent = `
      :root { color-scheme: light dark; }
      html, body { margin:0; padding:0; background:#fbfbfa; color:#1b1d21; }
      @media (prefers-color-scheme: dark) { html, body { background:#191a1c; color:#e6e6e4; } }
      #srl-reader { max-width: 44rem; margin: 0 auto; padding: 3.5rem 1.5rem 8rem;
        font: 1.125rem/1.7 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      #srl-bar { position: sticky; top: 0; margin: -3.5rem -1.5rem 2rem; padding: .6rem 1.5rem;
        display: flex; gap: .75rem; align-items: center;
        font-size: .75rem; letter-spacing: .04em; text-transform: uppercase;
        background: inherit; border-bottom: 1px solid rgba(128,128,128,.25); }
      #srl-bar b { font-weight: 700; }
      #srl-bar button { margin-left:auto; font: inherit; text-transform: none; letter-spacing: 0;
        padding: .25rem .7rem; border-radius: 999px; cursor: pointer;
        border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; }
      #srl-reader h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 .5rem; }
      #srl-meta { margin: 0 0 2.5rem; font-size: .875rem; opacity: .62; }
      #srl-reader img, #srl-reader video, #srl-reader svg { max-width: 100%; height: auto; border-radius: 6px; }
      #srl-reader figure { margin: 2rem 0; }
      #srl-reader figcaption { font-size: .8125rem; opacity: .6; margin-top: .5rem; }
      #srl-reader pre { overflow-x: auto; padding: 1rem; border-radius: 8px;
        background: rgba(128,128,128,.14); font-size: .875rem; line-height: 1.5; }
      #srl-reader code { font-size: .9em; }
      #srl-reader blockquote { margin: 1.5rem 0; padding-left: 1.1rem;
        border-left: 3px solid rgba(128,128,128,.4); opacity: .88; }
      #srl-reader a { color: inherit; text-underline-offset: 2px; }
      #srl-reader hr { border: 0; border-top: 1px solid rgba(128,128,128,.3); margin: 2.5rem 0; }
      #srl-reader table { border-collapse: collapse; width: 100%; font-size: .9rem; }
      #srl-reader td, #srl-reader th { border: 1px solid rgba(128,128,128,.3); padding: .4rem .6rem; }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'srl-reader';

    const bar = document.createElement('div');
    bar.id = 'srl-bar';
    const tag = document.createElement('b');
    tag.textContent = 'Defuddled';
    const stat = document.createElement('span');
    stat.textContent = `${r.wordCount} words`;
    const back = document.createElement('button');
    back.textContent = 'Restore original';
    back.addEventListener('click', () => location.reload());
    bar.append(tag, stat, back);

    const h1 = document.createElement('h1');
    h1.textContent = r.title || document.title || '';

    const meta = document.createElement('p');
    meta.id = 'srl-meta';
    meta.textContent = [r.author, r.site || r.domain, r.published]
      .filter(Boolean).join(' · ');

    const article = document.createElement('article');
    article.innerHTML = r.content;

    wrap.append(bar, h1, meta, article);
    document.body.replaceChildren(wrap);
    document.documentElement.dataset.siderailReader = '1';
    if (r.title) document.title = r.title;

    return { ok: true, title: r.title, words: r.wordCount };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function defuddleTab(tabId) {
  const tab = state.tabs.find((t) => t.id === tabId) ||
    (await chrome.tabs.get(tabId).catch(() => null));
  if (!tab) return;
  if (!/^https?:/i.test(tab.url || '')) return toast('Only works on web pages');

  if (!(await ensurePageAccess())) return toast('Page access declined');

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['vendor/defuddle.js']
    });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: APPLY_READER
    });
    const r = res && res.result;
    if (!r || !r.ok) return toast(r?.error || 'Defuddle failed');
    toast(`Defuddled · ${r.words} words`);
  } catch (e) {
    toast('Chrome blocked injection here');
  }
}

async function archiveTab(tabId) {
  const tab = state.tabs.find((t) => t.id === tabId) ||
    (await chrome.tabs.get(tabId).catch(() => null));
  if (!tab || !/^https?:/i.test(tab.url || '')) return toast('Only works on web pages');
  if (/^https?:\/\/archive\.(is|ph|today|li)\//i.test(tab.url)) {
    return toast('Already an archive.is URL');
  }
  await chrome.tabs.update(tabId, { url: `https://archive.is/${tab.url}` }).catch(() => {});
}

function pageActionItems(tab) {
  return [
    ['Defuddle this page', () => defuddleTab(tab.id)],
    ['Open in archive.is', () => archiveTab(tab.id)]
  ];
}

/* --------------------------------------------------------------- spaces */

/*
 * The ones most likely to be wanted for a space, shown first so the common case
 * needs no scrolling. Everything else — the whole Unicode set — is underneath.
 */
const EMOJI_SUGGESTED = [
  '🗂','⭐','💼','🏠','🔬','✈️','🛒','📚','🎧','🎬','🎮','💰','📈','🧪',
  '🧭','📝','🖼️','🐙','💬','📧','📅','🔧','🎨','🧠','🌍','☕','🔥','🌱',
  '🚀','🧩','📦','🔒','⚙️','🏛️','⚖️','🩺','🏋️','🍽️','🐈','🎯'
];

/**
 * The full emoji set, matched on its Unicode name.
 *
 * Loaded on first use rather than at boot: it is 2087 entries and no panel
 * session that never renames a space should pay for it. Vendored by
 * tools/build-emoji.mjs — data, not code.
 */
let emojiAll = null;
async function loadEmoji() {
  if (emojiAll) return emojiAll;
  try {
    const mod = await import('./vendor/emoji.js');
    emojiAll = { list: mod.EMOJI, groups: mod.EMOJI_GROUPS };
  } catch {
    emojiAll = { list: EMOJI_SUGGESTED.map((c) => [c, '', 0]), groups: ['Suggested'] };
  }
  return emojiAll;
}

/** Rank emoji by name against a query. Every term must appear somewhere. */
function searchEmoji(list, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const e of list) {
    const name = e[1].toLowerCase();
    if (!terms.every((t) => name.includes(t))) continue;
    // A word-start hit beats a mid-word one: "car" should lead with the car,
    // not with "caricature".
    const i = name.indexOf(terms[0]);
    out.push([e, i === 0 ? 0 : (/\s/.test(name[i - 1] || '') ? 1 : 2), name.length]);
  }
  return out.sort((a, b) => (a[1] - b[1]) || (a[2] - b[2])).map((r) => r[0]);
}

/** Show one of the documents packaged with the extension — read from this copy, not fetched. */
async function showPackagedText(title, file) {
  let text;
  try {
    text = await (await fetch(chrome.runtime.getURL(file))).text();
  } catch {
    text = `${file} is missing from this copy of SideRail.`;
  }
  await openDialog({
    title, node: el('pre', 'doc-text', text),
    buttons: [{ label: 'Close', value: true, primary: true }]
  });
}

/* ---- a small promise-based dialog, since confirm() can't do three options -- */

function closeDialog(resolve, value) {
  $('#dialog-back').hidden = true;
  $('#dialog-body').replaceChildren();
  $('#dialog-actions').replaceChildren();
  if (resolve) resolve(value);
}

/**
 * @param {{title:string, message?:string, name?:string, emoji?:string,
 *          wantName?:boolean, wantEmoji?:boolean,
 *          buttons:{label:string,value:any,primary?:boolean,danger?:boolean}[]}} opts
 * @returns {Promise<any>} the chosen button's value, with {name, emoji} merged
 *          in when fields were shown. null if dismissed.
 */
function openDialog(opts) {
  return new Promise((resolve) => {
    const back = $('#dialog-back');
    $('#dialog-title').textContent = opts.title;

    const body = $('#dialog-body');
    body.replaceChildren();
    if (opts.message) {
      const p = el('div');
      p.innerHTML = opts.message;
      body.append(p);
    }
    if (opts.node) body.append(opts.node);

    let nameInput = null;
    let chosenEmoji = opts.emoji || '';

    if (opts.wantName) {
      nameInput = el('input');
      nameInput.type = 'text';
      nameInput.value = opts.name || '';
      nameInput.placeholder = 'Space name';
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const go = opts.buttons.find((b) => b.primary) || opts.buttons[0];
          finish(go.value);
        }
      });
      body.append(nameInput);
    }

    if (opts.wantEmoji) {
      const search = el('input', 'emoji-search');
      search.type = 'search';
      search.placeholder = 'Search emoji — “rocket”, “cat”, “red circle”…';
      search.spellcheck = false;
      body.append(search);

      const grid = el('div', 'emoji-grid');
      const status = el('div', 'emoji-status');
      body.append(grid, status);

      const pick = (char, btn) => {
        chosenEmoji = char;
        grid.querySelectorAll('button').forEach((x) => x.classList.remove('is-on'));
        if (btn) btn.classList.add('is-on');
      };

      const tile = (char, name) => {
        const b = el('button', char === chosenEmoji ? 'is-on' : null, char);
        if (name) b.title = name;
        b.addEventListener('click', () => pick(char, b));
        return b;
      };

      // Rendering 2087 buttons is both slow and useless — nobody scrolls that
      // far. Show a screenful and let the search do the work.
      const CAP = 240;
      const paint = (entries, note) => {
        const nodes = [];
        const none = el('button', chosenEmoji ? null : 'is-on', '—');
        none.title = 'No emoji';
        none.addEventListener('click', () => pick('', none));
        nodes.push(none);
        for (const e of entries.slice(0, CAP)) {
          nodes.push(Array.isArray(e) ? tile(e[0], e[1]) : tile(e, ''));
        }
        grid.replaceChildren(...nodes);
        status.textContent = entries.length > CAP
          ? `${entries.length} matches — showing the first ${CAP}. Keep typing to narrow it.`
          : (note || '');
      };

      paint(EMOJI_SUGGESTED, 'Type to search all 2,000+ emoji.');

      let emojiTimer = null;
      search.addEventListener('input', () => {
        clearTimeout(emojiTimer);
        emojiTimer = setTimeout(async () => {
          const q = search.value.trim();
          if (!q) { paint(EMOJI_SUGGESTED, 'Type to search all 2,000+ emoji.'); return; }
          const { list } = await loadEmoji();
          const hits = searchEmoji(list, q);
          paint(hits, hits.length ? '' : `Nothing matches “${q}”.`);
        }, 90);
      });
      // Enter in the search box picks the first hit rather than submitting the
      // dialog with nothing chosen.
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        const first = grid.querySelector('button:not(:first-child)');
        if (first) first.click();
      });
    }

    const finish = (value) => {
      if (value === null || value === undefined) return closeDialog(resolve, null);
      const out = { value };
      if (opts.wantName) out.name = (nameInput.value || '').trim();
      if (opts.wantEmoji) out.emoji = cleanEmoji(chosenEmoji);
      closeDialog(resolve, out);
    };

    const actions = $('#dialog-actions');
    actions.replaceChildren();
    for (const b of opts.buttons) {
      const btn = el('button', b.danger ? 'danger' : (b.primary ? 'primary' : null), b.label);
      btn.addEventListener('click', () => finish(b.value));
      actions.append(btn);
    }

    back.onclick = (e) => { if (e.target === back) finish(null); };
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); finish(null); }
    });

    back.hidden = false;
    if (nameInput) { nameInput.focus(); nameInput.select(); }
  });
}

/* ------------------------------------------------------------- spaces */

/*
 * The Spaces view manages spaces; switching happens from the bar above the tab
 * list. Nothing here closes, opens or moves a tab except Reopen, which exists
 * for the one case where the browser came back without them.
 */

function renderSpaces() {
  const root = $('#view-spaces');
  const nodes = [];

  nodes.push(viewIntro({
    lede: 'A space is a filter over the tabs you already have, not a folder they ' +
          'move into. Switching between spaces closes nothing and reloads nothing.',
    label: '+ New space',
    onClick: () => newSpace()
  }));

  const q = state.query.toLowerCase();
  const counts = spaceCounts();
  const list = [mainSpace(), ...state.spaces]
    .filter((sp) => !q || (sp.name || '').toLowerCase().includes(q));

  if (!list.length) {
    nodes.push(emptyState('No spaces match', 'Clear the filter to see them all.'));
  } else {
    list.forEach((sp) => nodes.push(spaceCard(sp, counts[sp.id] || 0)));
  }

  if (state.spaces.length === 0 && !q) {
    nodes.push(el('div', 'scan-empty',
      'Everything starts in Main. Make a space, then drag tabs onto it in the bar above ' +
      'the tab list — or right-click a tab and move it there.'));
  }

  syncChildren(root, nodes);
}

function spaceCard(sp, count) {
  const here = sp.id === state.activeSpaceId;
  const card = el('div', `card space-card${here ? ' is-here' : ''}`);
  card.dataset.id = sp.id;
  card.draggable = false;

  const top = el('div', 'card-top');
  top.append(el('span', 'emo', sp.emoji || '🗂'));
  top.append(el('span', 'card-name', sp.name));
  // Two independent facts, so two badges. Main is permanent whether or not you
  // are looking at it, and you can be looking at any space; merging them into
  // one word would make each of them wrong half the time.
  if (sp.fixed) {
    const def = el('span', 'badge is-default', 'Default');
    def.title = 'Where tabs go when they belong nowhere else. Main can’t be deleted.';
    top.append(def);
  }
  if (here) {
    const showing = el('span', 'badge is-showing', 'Showing');
    showing.title = 'The panel is showing this space right now';
    top.append(showing);
  }
  if (sp.private) {
    const lock = el('span', 'badge is-private', 'Private');
    lock.title = 'The text of pages in this space is never read';
    top.append(lock);
  }

  if (!sp.fixed) {
    const grip = el('button', 'grip', '≡');
    grip.title = 'Drag to reorder';
    grip.addEventListener('pointerdown', () => { card.draggable = true; });
    top.append(grip);
  }
  card.append(top);

  const saved = (sp.manifest || []).length;
  const meta = el('div', 'card-meta');
  meta.textContent = `${count} tab${count === 1 ? '' : 's'} open now`;
  if (saved && saved !== count) {
    const extra = el('span', null, ` · ${saved} remembered`);
    extra.title = 'Addresses this space keeps so it can be rebuilt after a restart. ' +
      'They are not open tabs.';
    meta.append(extra);
  }
  card.append(meta);

  const actions = el('div', 'card-actions');

  const show = el('button', 'primary', 'Show');
  show.title = 'Point the panel at this space and go back to the tab list. ' +
    'Nothing is closed, reloaded or moved.';
  show.addEventListener('click', () => { setActiveSpaceId(sp.id); setMode('browse'); });
  actions.append(show);

  // Only offered when the browser came back without them.
  const missing = missingFromSpace(sp);
  if (missing.length) {
    const reopen = el('button', null, `Reopen ${missing.length}`);
    reopen.title = `This space remembers ${missing.length} address` +
      `${missing.length === 1 ? '' : 'es'} that ${missing.length === 1 ? 'is' : 'are'} ` +
      'not open anywhere right now. This opens them here.';
    reopen.addEventListener('click', () => reopenSpace(sp, missing));
    actions.append(reopen);
  }

  const edit = el('button', null, 'Rename…');
  edit.addEventListener('click', () => renameSpace(sp));
  actions.append(edit);

  // Private: nothing in this space is ever read for page-text search. On the
  // card rather than in a dialog because it is the one setting about a space
  // that a person is likely to want to see at a glance.
  if (!sp.fixed) {
    const priv = el('button', sp.private ? 'is-on' : null, sp.private ? 'Private ✓' : 'Private');
    priv.title = sp.private
      ? 'The text of pages in this space is never read. Click to allow it.'
      : 'Never read the text of pages in this space — for a banking or personal space.';
    priv.addEventListener('click', async () => {
      const live = state.spaces.find((x) => x.id === sp.id);
      if (!live) return;
      live.private = !live.private;
      resetScan();
      await persistSpaces(live.private
        ? `${live.name} is private — its pages are never read`
        : `${live.name} can be read again`);
    });
    actions.append(priv);
  }

  // No Delete for Main, and no disabled stand-in where it would have been: a
  // greyed button is still a button, and it implies the action exists somewhere.
  // The Default badge above already says why it can't go.
  if (!sp.fixed) {
    const del = el('button', 'danger', 'Delete…');
    del.addEventListener('click', () => deleteSpace(sp));
    actions.append(del);
  }

  card.append(actions);
  card.addEventListener('contextmenu', (e) => spaceContextMenu(e, sp));

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', `space:${sp.id}`);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    card.draggable = false;
  });
  card.addEventListener('dragover', (e) => {
    if (!String(e.dataTransfer.types || '').includes('text/plain')) return;
    e.preventDefault();
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const raw = e.dataTransfer.getData('text/plain') || '';
    if (!raw.startsWith('space:')) {
      const tabId = Number(raw);
      if (tabId) moveTabsToSpace(state.selection.size ? [...state.selection] : [tabId], sp.id);
      return;
    }
    const srcId = raw.slice(6);
    if (srcId === sp.id) return;
    const from = state.spaces.findIndex((x) => x.id === srcId);
    const to = state.spaces.findIndex((x) => x.id === sp.id);
    if (from === -1 || to === -1) return;
    state.spaces.splice(to, 0, state.spaces.splice(from, 1)[0]);
    await persistSpaces();
  });

  return card;
}

/** Saved URLs this space holds that aren't open right now. */
function missingFromSpace(sp) {
  // Across every window — otherwise a space open in another window would offer
  // to reopen tabs that already exist, and quietly duplicate them.
  const open = new Set((state.allTabs.length ? state.allTabs : state.tabs)
    .map((t) => normUrl(t.url)));
  return (sp.manifest || []).filter((e) => !open.has(normUrl(e.url)));
}

async function reopenSpace(sp, missing) {
  const created = [];
  for (const spec of missing) {
    try {
      const tab = await chrome.tabs.create({
        windowId: state.windowId, url: spec.url, pinned: !!spec.pinned, active: false
      });
      state.spaceOf[tab.id] = sp.id;
      created.push(tab.id);
    } catch { /* a URL Chrome refuses shouldn't stop the rest */ }
  }
  await persistMembership();
  lastSig = null;
  render();
  toast(`Reopened ${created.length} tab${created.length === 1 ? '' : 's'} in ${sp.name}`);
}

async function newSpace() {
  const ans = await openDialog({
    title: 'New space',
    message: 'Spaces filter what the panel shows. Nothing in the browser is touched — ' +
      'switching between them closes nothing and reloads nothing.',
    name: '', emoji: '', wantName: true, wantEmoji: true,
    buttons: [{ label: 'Create', value: 'ok', primary: true }, { label: 'Cancel', value: null }]
  });
  if (!ans) return null;

  const sp = makeLiveSpace({ name: ans.name || 'New space', emoji: ans.emoji });
  state.spaces = [...state.spaces, sp];
  await setStore('spaces', state.spaces);
  await setActiveSpaceId(sp.id);
  toast(`Created ${sp.name}`);
  return sp;
}

async function renameSpace(sp) {
  const ans = await openDialog({
    title: 'Rename space',
    name: sp.name, emoji: sp.emoji || '',
    wantName: true, wantEmoji: true,
    buttons: [{ label: 'Save', value: 'ok', primary: true }, { label: 'Cancel', value: null }]
  });
  if (!ans) return;

  if (sp.id === MAIN) {
    state.mainSpace = { name: ans.name || MAIN_DEFAULTS.name, emoji: ans.emoji };
    await setStore('mainSpace', state.mainSpace);
    lastSig = null;
    render();
    return;
  }

  const target = state.spaces.find((x) => x.id === sp.id);
  if (!target) return;
  if (ans.name) target.name = ans.name;
  target.emoji = ans.emoji;
  target.updatedAt = Date.now();
  await persistSpaces();
}

function spaceContextMenu(e, sp) {
  e.preventDefault();
  e.stopPropagation();
  const items = [
    ['Show this space', () => { setActiveSpaceId(sp.id); setMode('browse'); }],
    ['Rename / change emoji…', () => renameSpace(sp)]
  ];
  if (!sp.fixed) items.push(null, ['Delete…', () => deleteSpace(sp), true]);
  openCtx(e, items);
}

/**
 * Deleting a space never closes a tab: its tabs fall back to Unsorted, where
 * they stay visible. A space is a label, so removing it can only unlabel.
 */
async function deleteSpace(sp) {
  const count = spaceCounts()[sp.id] || 0;
  const ans = await openDialog({
    title: `Delete “${sp.name}”?`,
    message: count
      ? `Its <strong>${count} open tab${count === 1 ? '' : 's'}</strong> stay open and move to ` +
        `<strong>${esc(mainSpace().name)}</strong>. Nothing is closed.`
      : 'Nothing is open in this space. Its saved list is removed.',
    buttons: [
      { label: 'Delete space', value: 'go', danger: true },
      { label: 'Cancel', value: null }
    ]
  });
  if (!ans) return;

  for (const [tabId, id] of Object.entries(state.spaceOf)) {
    if (id !== sp.id) continue;
    state.spaceOf[tabId] = MAIN;
    // They didn't choose Main — the space they chose is gone. Let rules have
    // another go at them rather than freezing them here.
    delete state.spacePinned[tabId];
  }

  // A rule pointing at this space would keep trying to file into a space that
  // no longer exists; drop the action and leave the rest of the rule alone.
  let touchedRules = false;
  for (const r of state.rules) {
    if (r.spaceId === sp.id) { r.spaceId = ''; touchedRules = true; }
  }
  if (touchedRules) await saveRules();
  await persistMembership();

  state.spaces = state.spaces.filter((x) => x.id !== sp.id);
  if (state.activeSpaceId === sp.id) await setActiveSpaceId(firstSpaceId());
  await persistSpaces(`Deleted ${sp.name}`);
}

/** Kept for the overflow menu: save this window's tabs as a new space. */
async function saveWorkspace() {
  const sp = await newSpace();
  if (!sp) return;
  const ids = state.tabs.filter((t) => !t.pinned && isSaveable(t.url)).map((t) => t.id);
  await moveTabsToSpace(ids, sp.id);
}

/**
 * The standing header for a management view: what this screen is for, then the
 * one thing you most likely came to do.
 *
 * Replaces a disabled text input that was being used to hold a sentence. A
 * disabled field looks like a control you are not allowed to touch, so the
 * sentence read as broken rather than as an explanation.
 */
function viewIntro({ lede, label, onClick, title }) {
  const box = el('div', 'view-intro');
  box.append(el('p', 'intro-lede', lede));
  if (label) {
    const b = el('button', 'primary', label);
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    box.append(b);
  }
  return box;
}

/* -------------------------------------------------------- settings view */

/**
 * Push the appearance settings into CSS custom properties.
 *
 * Doing it with variables rather than by restyling rows means changing the
 * size, font or wrapping costs one style recalculation and never rebuilds the
 * list — so it stays instant with a few hundred tabs open, and no row loses its
 * scroll position or drag state.
 */
function applyAppearance() {
  const a = readAppearance(state.settings || {});
  const root = document.documentElement;
  root.style.setProperty('--title-size', `${a.titleSize}px`);
  root.style.setProperty('--title-font', fontStackFor(a));
  document.body.classList.toggle('wrap-titles', a.wrapTitles);
  return a;
}

async function setAppearance(patch) {
  state.settings = { ...(state.settings || {}), ...patch };
  applyAppearance();                       // paint first, persist after
  await setStore('settings', state.settings);
}

let settingsBuilt = false;
function renderSettings() {
  // Built once: these are live controls, and rebuilding them mid-drag would
  // yank the slider out from under the pointer.
  if (settingsBuilt) return;
  settingsBuilt = true;

  const root = $('#view-settings');
  const a = readAppearance(state.settings || {});
  root.replaceChildren();

  /* =============================================== 1. appearance */
  const card = el('div', 'card');
  const head = el('div', 'card-top');
  head.append(el('span', 'card-name', 'Tab titles'));
  card.append(head);

  /* ---- size */
  const sizeRow = el('div', 'set-row');
  const sizeLbl = el('label', null, 'Text size');
  const size = el('input');
  size.type = 'range';
  size.min = String(TITLE_SIZE_MIN);
  size.max = String(TITLE_SIZE_MAX);
  size.step = '1';
  size.value = String(a.titleSize);
  const sizeVal = el('span', 'val', `${a.titleSize}px`);
  size.addEventListener('input', () => {
    sizeVal.textContent = `${size.value}px`;
    setAppearance({ titleSize: Number(size.value) });
    paintPreview();
  });
  sizeRow.append(sizeLbl, size, sizeVal);
  card.append(sizeRow);

  /* ---- font */
  const fontRow = el('div', 'set-row');
  const fontLbl = el('label', null, 'Font');
  const font = el('select');
  for (const [key, def] of Object.entries(FONT_STACKS)) {
    const o = el('option', null, def.label);
    o.value = key;
    font.append(o);
  }
  font.value = a.titleFont;
  fontRow.append(fontLbl, font);
  card.append(fontRow);

  const customRow = el('div', 'set-row');
  const customLbl = el('label', null, 'Font name');
  customLbl.append(el('span', 'hint',
    'Any font installed on this machine, e.g. Iosevka. The preview below shows ' +
    'whether it took — if nothing changes, the name did not match.'));
  const custom = el('input');
  custom.type = 'text';
  custom.placeholder = 'Font family';
  custom.value = a.customFont;
  customRow.append(customLbl, custom);
  customRow.hidden = a.titleFont !== 'custom';
  card.append(customRow);

  font.addEventListener('change', () => {
    customRow.hidden = font.value !== 'custom';
    setAppearance({ titleFont: font.value });
    paintPreview();
    if (font.value === 'custom') custom.focus();
  });
  custom.addEventListener('input', () => {
    setAppearance({ customFont: custom.value });
    paintPreview();
  });

  /* ---- wrapping */
  const wrapRow = el('div', 'set-row');
  const wrapLbl = el('label', null, 'Wrap long titles');
  wrapLbl.append(el('span', 'hint',
    'Show up to two lines instead of cutting the title off. Rows that need the ' +
    'second line get taller; the rest stay as they are.'));
  const wrap = el('input');
  wrap.type = 'checkbox';
  wrap.checked = a.wrapTitles;
  wrap.addEventListener('change', () => {
    setAppearance({ wrapTitles: wrap.checked });
    paintPreview();
  });
  wrapRow.append(wrapLbl, wrap);
  card.append(wrapRow);

  /* ---- preview */
  const preview = el('div', 'set-preview');
  preview.append(el('div', 'cap', 'Preview'));
  const previewList = el('div');
  preview.append(previewList);
  card.append(preview);

  function paintPreview() {
    previewList.replaceChildren(
      previewRow('SideRail — a long tab title that shows how truncation and wrapping differ',
        'example.com'),
      previewRow('Short title', 'news.example.org')
    );
  }
  paintPreview();

  const actions = el('div', 'card-actions');
  const reset = el('button', null, 'Reset tab titles');
  reset.title = 'Puts size, font and wrapping back to how they started. ' +
    'Your spaces, rules and snapshots are not touched.';
  reset.addEventListener('click', async () => {
    await setAppearance({ ...APPEARANCE });
    settingsBuilt = false;
    renderSettings();
    toast('Tab titles reset');
  });
  actions.append(reset);
  card.append(actions);
  root.append(card);

  /* =============================================== 2. page access */
  const perm = el('div', 'card');
  const permHead = el('div', 'card-top');
  permHead.append(el('span', 'card-name', 'Page access'));
  perm.append(permHead);
  perm.append(el('p', 'card-lede',
    'SideRail asks for nothing at install. This is the one permission it ever ' +
    'requests, and only the features below need it.'));

  const grantRow = el('div', 'set-row');
  const grantLbl = el('label', null, 'Right now');
  const grantHint = el('span', 'hint', '');
  grantLbl.append(grantHint);
  const grantBtn = el('button', 'ghost-btn', '');
  grantRow.append(grantLbl, grantBtn);
  perm.append(grantRow);

  function paintGrant() {
    grantHint.textContent = state.scan.granted
      ? 'On. Hover previews sit beside the panel, thumbnails are captured, and ' +
        'page-text search, Defuddle and archive.is all work.'
      : 'Off. Previews fall back to drawing over the tab list, there are no ' +
        'thumbnails, and page-text search is unavailable.';
    grantBtn.textContent = state.scan.granted ? 'Revoke' : 'Grant';
  }
  grantBtn.addEventListener('click', async () => {
    if (state.scan.granted) {
      await chrome.permissions
        .remove({ permissions: ['scripting'], origins: ['<all_urls>'] }).catch(() => {});
    } else {
      await chrome.permissions
        .request({ permissions: ['scripting'], origins: ['<all_urls>'] }).catch(() => false);
    }
    await refreshGrants();
    paintGrant();
  });
  paintGrant();

  root.append(perm);

  /* =============================================== 2b. pages that are never read */
  const never = el('div', 'card');
  const neverHead = el('div', 'card-top');
  neverHead.append(el('span', 'card-name', 'Pages that are never read'));
  never.append(neverHead);
  never.append(el('p', 'card-lede',
    'Page-text search reads the visible text of open tabs. These are never read — not ' +
    'for search, not for anything else — and a site added here is honoured at once. ' +
    'Whatever is on any list, a page whose address ' +
    'carries a password or token is never read.'));

  const builtinRow = el('div', 'set-row');
  const builtinLbl = el('label', null, 'Built-in list');
  const builtinHint = el('span', 'hint', '');
  builtinLbl.append(builtinHint);
  const builtinCb = el('input');
  builtinCb.type = 'checkbox';
  builtinCb.checked = state.settings.excludeBuiltin !== false;
  const paintBuiltin = () => {
    const m = state.exclusions.builtinMeta;
    builtinHint.textContent = (m ? `${m.count.toLocaleString()} sites` : 'Thousands of sites') +
      ': banks, cards, insurers, webmail, personal messaging, dating, payment, health, password ' +
      'vaults. Built from the UT1 lists (CC BY-SA) with additions. Also any sign-in or account ' +
      'host (accounts., login., myaccount.…) and search results pages. Team chat such as Slack ' +
      'is not on it.';
  };
  paintBuiltin();
  loadBuiltinExclusions().then(paintBuiltin);
  builtinCb.addEventListener('change', async () => {
    state.settings = { ...state.settings, excludeBuiltin: builtinCb.checked };
    await setStore('settings', state.settings);
    resetScan();
    toast(builtinCb.checked ? 'Built-in list on' : 'Built-in list off — only your own list applies');
  });
  builtinRow.append(builtinLbl, builtinCb);
  never.append(builtinRow);

  never.append(el('div', 'band-label', 'Your sites'));
  const yours = el('textarea', 'rule-pats excl-list');
  yours.value = (state.settings.excludeUser || []).join('\n');
  yours.placeholder = 'intranet.example.com\nxero.com\ntitle:Payslip';
  yours.spellcheck = false;
  let exclTimer = null;
  yours.addEventListener('input', () => {
    clearTimeout(exclTimer);
    exclTimer = setTimeout(async () => {
      const list = yours.value.split('\n').map((x) => x.trim()).filter(Boolean);
      state.settings = { ...state.settings, excludeUser: list };
      await setStore('settings', state.settings);
      resetScan();
    }, 350);
  });
  never.append(yours);
  never.append(el('p', 'hint',
    'One per line, same syntax as a rule: a bare domain covers the site and its subdomains; ' +
    'title: matches the tab title. You can also mark a whole space as Private in Spaces, ' +
    'and nothing in it is read.'));
  root.append(never);

  /* =============================================== 3. your data
   *
   * Backup lived at the bottom of the Rules screen, under the pattern syntax
   * help, which is nowhere anybody would look for it.
   */
  const data = el('div', 'card');
  const dataHead = el('div', 'card-top');
  dataHead.append(el('span', 'card-name', 'Your data'));
  data.append(dataHead);
  data.append(el('p', 'card-lede',
    'Everything SideRail knows lives in this browser profile and never leaves it. ' +
    'A backup is the only copy that survives reinstalling.'));

  const dataRow = el('div', 'data-row');
  dataRow.append(el('span', 'data-label', 'Backup'));
  const expBtn = el('button', 'ghost-btn', 'Export data');
  expBtn.title = 'Save every space, rule, snapshot and setting to a JSON file';
  expBtn.addEventListener('click', exportData);
  const impBtn = el('button', 'ghost-btn', 'Import data');
  impBtn.title = 'Read a JSON backup back in';
  impBtn.addEventListener('click', pickImportFile);
  dataRow.append(expBtn, impBtn);
  data.append(dataRow);
  root.append(data);

  /* =============================================== 4. keyboard */
  root.append(shortcutCard());

  /* =============================================== 5. advanced
   *
   * Instrumentation, folded away. Panel measurements and the edge flash exist
   * to settle "is there still a strip on the right", which is a question the
   * person who wrote the CSS has and nobody else does. Left in the open they
   * read as features that are broken.
   */
  const adv = el('details', 'card adv');
  adv.append(el('summary', null, 'Advanced and troubleshooting'));

  const diag = el('div', 'set-row');
  const diagLabel = el('label', null, 'Panel measurements');
  const diagLine = el('span', 'hint', '');
  diagLabel.append(diagLine);
  diag.append(diagLabel);
  adv.append(diag);

  function measure() {
    const main = $('#main');
    const view = $(`#view-${state.view}`) || $('#view-tabs');
    const gutter = main.offsetWidth - main.clientWidth;
    const pad = Math.round(parseFloat(getComputedStyle(view).paddingRight) || 0);
    // innerWidth counts a document-level scrollbar; clientWidth does not. If
    // they differ, the missing strip is ours. If they match and the panel still
    // looks narrower than the browser's panel, the strip belongs to the browser
    // chrome around this document and nothing here can reclaim it.
    const docScroll = window.innerWidth - document.documentElement.clientWidth;
    diagLine.textContent =
      `Document ${document.documentElement.clientWidth}px · ` +
      `window ${window.innerWidth}px · ` +
      `list ${main.clientWidth}px · ` +
      `list gutter ${gutter}px · document gutter ${docScroll}px · ` +
      `right padding ${pad}px`;
  }
  measure();
  window.addEventListener('resize', measure, { passive: true });

  // Settles the argument in one look: a strip INSIDE the outline is this
  // document's and can be fixed here; a strip OUTSIDE it belongs to the browser
  // chrome wrapped around the panel, which no extension can reach.
  const outlineRow = el('div', 'set-row');
  const outlineLbl = el('label', null, 'Where does the panel end?');
  outlineLbl.append(el('span', 'hint',
    'Flashes a border on the very edge of this document for three seconds.'));
  const outline = el('button', 'ghost-btn', 'Show edges');
  outline.addEventListener('click', () => {
    document.documentElement.classList.add('show-edges');
    setTimeout(() => document.documentElement.classList.remove('show-edges'), 3000);
  });
  outlineRow.append(outlineLbl, outline);
  adv.append(outlineRow);

  /* ---- the state dump, and a plain warning about what is in it */
  const diagRow = el('div', 'set-row');
  const diagLbl = el('label', null, 'Diagnostics');
  diagLbl.append(el('span', 'hint',
    'Copies what SideRail believes right now: your spaces, your rules, and which ' +
    'space each open tab is filed in. Tab titles and full addresses are reduced ' +
    'to the site name — but that still lists every site you have open, so read ' +
    'it before pasting it anywhere public.'));
  const diagBtn = el('button', 'ghost-btn', 'Copy diagnostics');
  diagBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(await collectDiagnostics(), null, 2));
      toast('Diagnostics copied — check it before you paste it');
    } catch {
      toast('Could not reach the clipboard');
    }
  });
  diagRow.append(diagLbl, diagBtn);
  adv.append(diagRow);
  root.append(adv);

  /* =============================================== 6. about */
  const about = el('div', 'card about');
  about.append(el('div', 'version',
    `SideRail v${VERSION}${state.defuddleVersion ? ` · Defuddle ${state.defuddleVersion}` : ''}`));
  about.append(el('p', 'card-lede',
    'Open source under the Apache License 2.0. Nothing leaves this computer; the privacy ' +
    'note says exactly what is kept, and where.'));
  const docs = el('div', 'about-links');
  const docBtn = (label, file) => {
    const b = el('button', 'link-btn', label);
    b.addEventListener('click', () => showPackagedText(label, file));
    return b;
  };
  const siteBtn = (label, url) => {
    const b = el('button', 'link-btn', label);
    b.title = url;
    b.addEventListener('click', () => chrome.tabs.create({ url }));
    return b;
  };
  docs.append(
    docBtn('Privacy', 'PRIVACY.md'),
    docBtn('Licence', 'LICENSE'),
    docBtn('Third-party notices', 'THIRD-PARTY-NOTICES.md'),
    siteBtn('Releases', `${HOMEPAGE}/releases`),
    siteBtn('Report a problem', `${HOMEPAGE}/issues`)
  );
  about.append(docs);
  about.append(el('p', 'card-lede',
    'SideRail never checks for new versions. Updating is by hand: download a release, replace ' +
    'the folder’s contents, and press Reload on the extensions page. Your data stays.'));
  root.append(about);
}

/**
 * Keyboard shortcuts — which are Chrome's to set, not ours.
 *
 * There is no API for an extension to bind its own browser shortcut,
 * deliberately, so that a page cannot steal a key from under you. All this can
 * do is show the current bindings and open the one page where they change.
 *
 * The in-panel palette key was removed in 0.21.0. It worked, but only once the
 * panel already had keyboard focus — and if you have clicked into the panel you
 * can simply click the search box. Around that one marginal binding sat a
 * capture control, a reset, a test harness and two paragraphs explaining why the
 * browser-wide key it resembled did not work. See the changelog.
 */
function shortcutCard() {
  const card = el('div', 'card');
  const head = el('div', 'card-top');
  head.append(el('span', 'card-name', 'Keyboard'));
  card.append(head);
  card.append(el('p', 'card-lede',
    'Chrome owns these. SideRail can show you what they are, but only you can ' +
    'change them, on Chrome’s own shortcuts page.'));

  const table = el('div', 'key-list');
  card.append(table);

  const NAMES = {
    'open-panel': 'Open the panel',
    'group-by-domain': 'Group tabs by domain',
    'ungroup-all': 'Ungroup all tabs'
  };
  (chrome.commands && chrome.commands.getAll ? chrome.commands.getAll() : Promise.resolve([]))
    .then((cmds) => {
      const rows = cmds
        .filter((c) => NAMES[c.name])
        .sort((a, b) => Object.keys(NAMES).indexOf(a.name) - Object.keys(NAMES).indexOf(b.name))
        .map((c) => {
          const r = el('div', 'key-row');
          r.append(el('span', null, NAMES[c.name]));
          r.append(el('kbd', c.shortcut ? null : 'unset', c.shortcut || 'not set'));
          return r;
        });
      syncChildren(table, rows);
    })
    .catch(() => {});

  const goRow = el('div', 'card-actions');
  const go = el('button', null, 'Change in Chrome…');
  go.addEventListener('click', openShortcutSettings);
  goRow.append(go);
  card.append(goRow);

  const focusNote = el('div', 'hint');
  focusNote.innerHTML =
    '<b>Search is opened by the <span aria-hidden="true">›</span> button beside ' +
    'the search box.</b> There is no keyboard shortcut for it, because Chrome ' +
    'does not let an extension move keyboard focus into its own side panel: a ' +
    'shortcut pressed from a web page would open the box and then send your ' +
    'typing to the page behind it. Still true in Chromium 151.';
  card.append(focusNote);

  return card;
}

/** A non-interactive stand-in for a tab row, so changes are visible at once. */
function previewRow(title, host) {
  const row = el('div', 'tab-row');
  row.style.cursor = 'default';
  const slot = el('span', 'fav-slot');
  slot.append(letterTile(host));
  row.append(slot, el('span', 'title', title), el('span', 'host', host));
  return row;
}

/* ------------------------------------------------------- command palette
 *
 * One list, several sources, ranked together. It sits over the panel rather
 * than replacing a view, so whatever you were looking at is still there when
 * you close it — and so opening it never disturbs the tab list's scroll.
 *
 * Bookmarks and history arrive late, if at all: they need optional permissions
 * and a round trip. Everything else is already in memory, so the list is drawn
 * immediately and the slow sources are folded in when they land.
 */

const pal = {
  open: false,
  q: '',
  sel: 0,
  items: [],
  extras: { bookmarks: [], history: [] },
  token: 0,
  timer: null
};

/** Commands the palette can run. Kept flat: a nested menu in a list is a menu. */
function paletteCommands() {
  const cmds = [
    { title: 'Group tabs by domain', sub: 'Every ungrouped tab, by site',
      run: async () => { await send({ type: 'group-by-domain', windowId: state.windowId }); toast('Grouped by domain'); } },
    { title: 'Ungroup all tabs', sub: 'Dissolve every group in this window',
      run: async () => { await send({ type: 'ungroup-all', windowId: state.windowId }); toast('Ungrouped'); } },
    { title: 'Run rules now', sub: 'Sort every open tab in this window by your rules', run: runRulesNow },
    { title: 'New space…', sub: 'Somewhere to file tabs', run: newSpace },
    { title: 'Save this window as a space', run: saveWorkspace },
    { title: 'Take a snapshot', sub: 'Rewind point you can restore later',
      run: async () => { const r = await send({ type: 'snapshot-now' }); toast(r?.snap ? 'Snapshot taken' : 'Already up to date'); } },
    { title: 'Settings', run: () => setMode('manage', { view: 'settings' }) },
    { title: 'Rules', run: () => setMode('manage', { view: 'rules' }) },
    { title: 'Spaces', run: () => setMode('manage', { view: 'spaces' }) },
    { title: 'Rewind', run: () => setMode('manage', { view: 'rewind' }) },
    { title: 'Export data', sub: 'Spaces, rules, snapshots and settings', run: exportData },
    { title: 'Import data', run: pickImportFile },
    { title: 'Change keyboard shortcuts', sub: 'Opens Chrome’s shortcut page',
      run: openShortcutSettings }
  ];
  if (duplicateCount(state.tabs)) {
    cmds.splice(1, 0, { title: `Close duplicate tabs (${duplicateCount(state.tabs)})`, run: openDupeSheet });
  }
  return cmds.map((c, i) => ({ ...c, kind: 'command', id: `cmd:${i}`, section: 'Commands' }));
}

/**
 * Everything the palette could show for the current query, already ordered.
 *
 * Sections are ordered by how likely you are to have meant them, not by score:
 * a typed URL is an explicit instruction and outranks every fuzzy match, and an
 * open tab beats a bookmark of the same page because switching beats opening a
 * second copy.
 */
function palettePlan(q) {
  const query = (q || '').trim();
  const out = [];

  const intent = query ? readIntent(query) : null;

  // A typed address is an explicit instruction, so it leads. A plain word is
  // not: "exa" almost always means a tab you have open, and putting the web
  // search on top would make ↵ open a search engine for a tab you can see.
  // So the search row exists either way, but only rides at the top behind a
  // URL that shares the line with it.
  if (intent && intent.open) {
    out.push({
      kind: 'open', id: 'go', section: 'Go', badge: 'url',
      title: intent.whole ? intent.open.replace(/^https?:\/\//, '') : intent.host,
      sub: intent.whole ? 'Open this address' : `Open ${intent.host} — the rest is searched below`,
      glyph: '→',
      run: () => openInPanelWindow(intent.open)
    });
    if (!intent.whole) out.push(webSearchItem(query, 'Go'));
  }

  // Open tabs, every window — the palette is not scoped to one.
  const pool = state.allTabs.length ? state.allTabs : state.tabs;
  const tabs = query
    ? pool.map((t) => ({ t, s: matchScore(query, t) })).filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s).map((r) => r.t)
    : [...pool].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const t of tabs.slice(0, query ? 20 : 8)) {
    const spaceId = state.spaceOf[t.id];
    const sp = spaceId && spaceId !== GLOBAL_PIN ? liveSpaceById(spaceId) : null;
    out.push({
      kind: 'tab', id: `tab:${t.id}`, section: query ? 'Tabs' : 'Recent tabs',
      title: t.title || prettyUrl(t.url),
      sub: [sp ? `${sp.emoji || ''} ${sp.name}`.trim() : null, prettyUrl(t.url)]
        .filter(Boolean).join(' · '),
      tab: t,
      run: () => activateTab(t.id)
    });
  }

  // Spaces: switching is free, so they belong near the top of any short list.
  const spaces = spacesForDisplay().filter((sp) =>
    !query || matchScore(query, { title: sp.name, url: '' }) >= 0);
  for (const sp of spaces) {
    if (sp.id === state.activeSpaceId) continue;
    out.push({
      kind: 'space', id: `space:${sp.id}`, section: 'Spaces',
      title: `${sp.emoji ? `${sp.emoji} ` : ''}${sp.name}`,
      sub: `${sp.count} open tab${sp.count === 1 ? '' : 's'}`,
      glyph: '▸',
      run: () => setActiveSpaceId(sp.id)
    });
  }

  const cmds = query
    ? paletteCommands().map((c) => ({ c, s: matchScore(query, { title: c.title, url: '' }) }))
        .filter((r) => r.s >= 0).sort((a, b) => b.s - a.s).map((r) => r.c)
    : paletteCommands().slice(0, 6);
  for (const c of cmds) out.push({ ...c, glyph: '»' });

  for (const b of pal.extras.bookmarks.slice(0, 6)) {
    out.push({
      kind: 'bookmark', id: `bm:${b.id || b.url}`, section: 'Bookmarks',
      title: b.title || prettyUrl(b.url), sub: b._folder ? `${b._folder} · ${prettyUrl(b.url)}` : prettyUrl(b.url),
      glyph: '☆',
      run: () => openInPanelWindow(b.url)
    });
  }
  for (const h of pal.extras.history.slice(0, 8)) {
    out.push({
      kind: 'history', id: `h:${h.url}`, section: 'History',
      title: h.title || prettyUrl(h.url), sub: prettyUrl(h.url), glyph: '↺',
      run: () => openInPanelWindow(h.url)
    });
  }

  // Always last, always available: whatever you typed, searched on the web.
  if (query && !(intent.open && !intent.whole)) out.push(webSearchItem(query, 'Web'));

  return out;
}

function webSearchItem(query, section) {
  return {
    kind: 'search', id: 'search', section, badge: 'web',
    title: query, sub: 'Search the web', glyph: 'search',
    run: () => openInPanelWindow(WEB_SEARCH(query))
  };
}

/** A magnifier that renders everywhere; the U+2315 glyph does not. */
function searchGlyph() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'pal-glyph pal-svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '7');
  const l = document.createElementNS(NS, 'line');
  l.setAttribute('x1', '16.5'); l.setAttribute('y1', '16.5');
  l.setAttribute('x2', '21'); l.setAttribute('y2', '21');
  svg.append(c, l);
  return svg;
}

function openPalette(prefill) {
  const box = $('#palette');
  pal.open = true;
  pal.extras = { bookmarks: [], history: [] };
  box.hidden = false;
  const input = $('#pal-input');
  input.value = prefill || '';
  pal.q = input.value;
  pal.sel = 0;
  refreshPalette();
  insistFocus(input);
}

/**
 * Put the caret in the palette and keep it there.
 *
 * One focus() call is not enough. The panel may have been created by the very
 * shortcut that is opening the palette, in which case the document is still
 * being set up and the call lands on nothing; and a side panel opened by
 * `sidePanel.open()` does not always hold keyboard focus straight away — the
 * page you pressed the key on can still have it for a frame or two. Either way
 * the symptom is identical and infuriating: a palette you have to click before
 * you can type, which defeats the point of a keyboard shortcut.
 *
 * So: focus now, again next frame, and then keep asking briefly until the caret
 * is really in the box. Once it is, this stops.
 */
let focusWatch = null;

function insistFocus(input) {
  const grab = () => {
    if (!pal.open) return;
    if (document.activeElement === input) return;
    try { window.focus(); } catch { /* not permitted in every context */ }
    input.focus({ preventScroll: true });
    input.select();
  };

  grab();
  requestAnimationFrame(grab);

  // Keep asking across the whole window in which the panel might still be
  // settling. Crucially this does NOT stop at the first success: the previous
  // version did, and that was the intermittency. Chrome hands the side panel
  // its focus some milliseconds after `sidePanel.open()` resolves, and whatever
  // it focuses then replaces the caret we had just placed. Winning the race once
  // and stopping is exactly how you lose it.
  clearTimeout(focusWatch);
  const deadline = Date.now() + 1500;
  const tick = () => {
    if (!pal.open) return;
    grab();
    // Everything above only moves the caret WITHIN this document. Whether the
    // document has the browser's keyboard focus at all is not ours to decide,
    // and when the shortcut is pressed on a web page, Chrome leaves it there.
    // Say so rather than looking broken. See reportFocusTrouble().
    reportFocusTrouble(Date.now() >= deadline);
    if (Date.now() < deadline) focusWatch = setTimeout(tick, 60);
  };
  focusWatch = setTimeout(tick, 60);
}

/**
 * Explain the one failure mode we cannot fix.
 *
 * `document.hasFocus()` false while `activeElement` is our input means the
 * caret is in the right place but the keystrokes are going to the web page.
 * Chrome does not let an extension move keyboard focus into its own side panel
 * — `sidePanel.open()` focuses the panel only when it was closed, `focus()` and
 * `window.focus()` are no-ops from here, and there is no API for it.
 *
 * A previous version of this comment said it was fixed in Chrome 148, on the
 * strength of a third-party FAQ. That was wrong: it still happens on Chromium
 * 151. Don't put a version number here again without a reproduction.
 *
 * So the honest thing is to name it: a palette that silently swallows your
 * typing is far worse than one that tells you where the typing went.
 */
function reportFocusTrouble(settled) {
  const note = $('#pal-nofocus');
  if (!note) return;
  const stuck = pal.open && settled && !document.hasFocus();
  if (!stuck) { note.hidden = true; return; }
  if (note.hidden) {
    note.textContent = 'Keyboard focus is still on the page — click here to type. ' +
      'Chrome does not let an extension focus its own side panel.';
    note.hidden = false;
  }
}

function closePalette() {
  if (!pal.open) return;
  pal.open = false;
  pal.token++;                       // orphan any in-flight bookmark search
  clearTimeout(pal.timer);
  clearTimeout(focusWatch);
  $('#palette').hidden = true;
  $('#pal-input').value = '';
  pal.q = '';
  pal.extras = { bookmarks: [], history: [] };
}

function refreshPalette() {
  pal.items = palettePlan(pal.q);
  if (pal.sel >= pal.items.length) pal.sel = Math.max(0, pal.items.length - 1);
  renderPalette();
}

function renderPalette() {
  const list = $('#pal-list');
  const nodes = [];
  let section = null;

  pal.items.forEach((item, i) => {
    if (item.section !== section) {
      section = item.section;
      nodes.push(el('div', 'pal-sec', section));
    }
    const row = el('div', `pal-row${i === pal.sel ? ' is-sel' : ''}`);
    row.dataset.i = String(i);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === pal.sel ? 'true' : 'false');

    if (item.tab) row.append(favicon(item.tab));
    else if (item.glyph === 'search') row.append(searchGlyph());
    else if (item.glyph) row.append(el('span', 'pal-glyph', item.glyph));
    else row.append(letterTile(item.title));

    const text = el('span', 'pal-text');
    text.append(el('span', 'pal-title', item.title));
    if (item.sub) text.append(el('span', 'pal-sub', item.sub));
    row.append(text);
    if (item.badge) row.append(el('span', 'pal-badge', item.badge));

    row.addEventListener('mousemove', () => {
      if (pal.sel === i) return;
      pal.sel = i;
      renderPalette();
    });
    row.addEventListener('click', () => runPaletteItem(i));
    nodes.push(row);
  });

  if (!nodes.length) {
    nodes.push(el('div', 'pal-empty',
      pal.q ? 'Nothing matches. Press ↵ to search the web for it.' : 'Start typing.'));
  }
  syncChildren(list, nodes);

  const sel = list.querySelector('.pal-row.is-sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function runPaletteItem(i) {
  const item = pal.items[i];
  if (!item) return;
  closePalette();
  try {
    await item.run();
  } catch (e) {
    toast('That didn’t work');
    console.warn('[SideRail] palette action failed', item.id, e);
  }
}

/**
 * Bookmarks and history, debounced. The token guards against a slow search for
 * an old query landing after a fast one for a new query — the classic way a
 * palette ends up showing results for something you already deleted.
 */
function queuePaletteExtras() {
  clearTimeout(pal.timer);
  const q = pal.q;
  if (!q || q.trim().length < 2) {
    pal.extras = { bookmarks: [], history: [] };
    return;
  }
  const mine = ++pal.token;
  pal.timer = setTimeout(async () => {
    const found = await searchExtras(q).catch(() => null);
    if (!found || mine !== pal.token || !pal.open) return;
    pal.extras = { bookmarks: found.bookmarks || [], history: found.history || [] };
    refreshPalette();
  }, 160);
}

function wirePalette() {
  const input = $('#pal-input');

  $('#pal-close').addEventListener('click', closePalette);

  // If the panel gains focus while the palette is up — which is exactly what
  // happens when the shortcut opened both at once — take the caret back.
  window.addEventListener('focus', () => { if (pal.open) insistFocus(input); });
  document.addEventListener('visibilitychange', () => {
    if (pal.open && !document.hidden) insistFocus(input);
  });

  // The backstop, and the only one that holds indefinitely. Whatever moves
  // focus — the panel finishing its open, a stray click, Chrome focusing the
  // document body — if it lands outside the palette while the palette is up,
  // it comes straight back. The timed loop above is for the case where nothing
  // fires an event at all.
  document.addEventListener('focusin', (e) => {
    if (!pal.open) return;
    if (e.target === input) return;
    if ($('#palette').contains(e.target)) return;   // the close button is fair game
    input.focus({ preventScroll: true });
  });
  $('#palette').addEventListener('mousedown', (e) => {
    if (e.target.id === 'palette') { closePalette(); return; }
    // Anywhere inside the box puts the caret in the input. When Chrome has left
    // focus on the page this click is the only way to get it, so it should not
    // require hitting a 24px-tall target.
    if (e.target.closest('.pal-row, #pal-close')) return;
    e.preventDefault();
    input.focus({ preventScroll: true });
  });

  input.addEventListener('input', () => {
    pal.q = input.value;
    pal.sel = 0;
    queuePaletteExtras();
    refreshPalette();
  });

  input.addEventListener('keydown', (e) => {
    const n = pal.items.length;
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
    if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(pal.sel); return; }
    if (!n) return;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault(); pal.sel = (pal.sel + 1) % n; renderPalette();
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault(); pal.sel = (pal.sel - 1 + n) % n; renderPalette();
    } else if (e.key === 'Home') {
      e.preventDefault(); pal.sel = 0; renderPalette();
    } else if (e.key === 'End') {
      e.preventDefault(); pal.sel = n - 1; renderPalette();
    }
  });

  // A button, not a key. Every keyboard route into this box was either broken
  // or redundant: Chrome will not move focus into a side panel, so the
  // browser-wide chord opened the box and then fed your typing to the page
  // behind it; and the in-panel key only worked once you had already clicked
  // in, by which point clicking the box is the same gesture. A visible control
  // beside the search field is the honest version of the same affordance.
  $('#open-palette').addEventListener('click', () => {
    const s = $('#search');
    // Whatever is already typed comes with you — reaching for more power
    // mid-search means "take this further", not "start again".
    openPalette(document.activeElement === s || s.value ? s.value : '');
  });
}

/**
 * Chrome does not let an extension set its own shortcuts — there is no API,
 * only this page. So the setting shows the live binding and takes you there.
 */
function openShortcutSettings() {
  return chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

/* ----------------------------------------------------------- rules view */

let rulesDomKey = null;

async function saveRules() {
  selfWrite = true;
  await setStore('rules', state.rules);
  setTimeout(() => { selfWrite = false; }, 50);
}

/**
 * Take apart the tab groups a rule built, in every window, and free the slot it
 * held in the jump bar.
 *
 * A rule's groups outlive the rule unless something does this. Deleting a rule
 * used to leave its groups — and therefore its jump-bar square — sitting there
 * with nothing behind them, and switching a rule's grouping off did the same.
 * Ungrouping closes nothing: the tabs stay exactly where they are.
 *
 * Groups are matched by title, which is how a rule claims one in the first
 * place. A group you named by hand identically to a rule is indistinguishable
 * from the rule's own, so the dialogs say what will happen before it does.
 */
async function dissolveRuleGroups(name) {
  const title = (name || '').trim().toLowerCase();
  if (!title || !chrome.tabGroups) return 0;

  let n = 0;
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  for (const g of groups) {
    if ((g.title || '').trim().toLowerCase() !== title) continue;
    const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
    const ids = tabs.map((t) => t.id);
    if (!ids.length) continue;
    await chrome.tabs.ungroup(ids).catch(() => {});
    n += ids.length;
  }

  // The jump bar is ordered by group NAME — ids are regenerated on restart — so
  // a stale key would reserve a slot for a group that can never come back.
  const order = state.groupOrder || [];
  const next = order.filter((k) => k !== `t:${title}`);
  if (next.length !== order.length) await saveGroupOrder(next);

  lastSig = null;
  scheduleRefresh();
  return n;
}

/** How many tabs are sitting in groups this rule owns, right now. */
async function ruleGroupSize(name) {
  const title = (name || '').trim().toLowerCase();
  if (!title || !chrome.tabGroups) return 0;
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  let n = 0;
  for (const g of groups) {
    if ((g.title || '').trim().toLowerCase() !== title) continue;
    n += (await chrome.tabs.query({ groupId: g.id }).catch(() => [])).length;
  }
  return n;
}

let ruleSaveTimer = null;
function queueSaveRules() {
  clearTimeout(ruleSaveTimer);
  ruleSaveTimer = setTimeout(saveRules, 350);
}

async function newRule(name, patterns) {
  state.rules = [{
    id: uid(),
    name: name || 'New rule',
    color: GROUP_COLORS[state.rules.length % (GROUP_COLORS.length - 1)],
    patterns: patterns || [],
    enabled: true,
    group: true,     // action 1: put matching tabs in a tab group named after the rule
    spaceId: ''      // action 2: file matching tabs into this space. '' = don't file
  }, ...state.rules];
  await saveRules();
  setMode('manage', { view: 'rules', force: true });
  renderRules(true);
  if (patterns && patterns.length) applyNow();
}

async function makeRuleFromGroup(gid) {
  const g = state.groups.find((x) => x.id === gid);
  const hosts = [...new Set(
    state.tabs.filter((t) => t.groupId === gid).map((t) => domainOf(t.url)).filter(Boolean)
  )];
  await newRule((g && g.title) || hosts[0] || 'Group', hosts);
}

/**
 * The one button. Files every tab in this window into the space its rules name,
 * then puts matching tabs into their rules' groups.
 *
 * There used to be three of these and no way to tell them apart. "Apply to this
 * window" and the per-rule "Apply now" ran the same all-rules pass; "File open
 * tabs now" ran the filing half of it and also moved the active tab. The only
 * real differences were whether the tab you were looking at moved, and whether
 * grouping happened at all — neither of which anyone could have guessed from
 * the labels. One action that does the whole job is easier to explain and
 * easier to trust.
 */
async function runRulesNow() {
  const r = await send({
    type: 'apply-rules', windowId: state.windowId, rules: state.rules,
    spaceOf: state.spaceOf, includeActive: true
  });
  const bits = [];
  if (r?.filed) bits.push(`Moved ${r.filed}`);
  if (r?.n) bits.push(`grouped ${r.n}`);
  toast(bits.length
    ? `${bits.join(', ')} tab${(r.filed + r.n) === 1 ? '' : 's'}`
    : 'Every tab is already where its rules say');
  if (r?.filed) await afterFiling(r.moved);
}

/** The quiet re-apply after an edit. Never a button — see `runRulesNow`. */
async function applyNow() {
  const r = await send({
    type: 'apply-rules', windowId: state.windowId, rules: state.rules, spaceOf: state.spaceOf
  });
  const bits = [];
  if (r?.filed) bits.push(`Filed ${r.filed}`);
  if (r?.n) bits.push(`grouped ${r.n}`);
  toast(bits.length ? `${bits.join(', ')} tab${r.filed + r.n === 1 ? '' : 's'}` : 'Nothing to move');
  if (r?.filed) await afterFiling(r.moved);
}

/** Adopt a filing pass the worker performed, and follow the active tab. */
async function afterFiling(moved) {
  Object.assign(state.spaceOf, moved || {});
  const active = state.tabs.find((t) => t.active);
  const dest = active && moved ? moved[active.id] : null;
  queueManifest();
  lastSig = null;
  if (dest) await setActiveSpaceId(dest); else render();
}

/**
 * Move a rule up or down. Order is not decoration: when two rules match the
 * same tab the higher one wins, so this is how a clash gets resolved.
 */
async function moveRule(id, delta) {
  const from = state.rules.findIndex((r) => r.id === id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= state.rules.length) return;
  const next = [...state.rules];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  state.rules = next;
  await saveRules();
  renderRules(true);
  applyNow();
}

/** Conflicts against the tabs open right now, indexed by the rule that loses. */
function conflictsByLoser() {
  const pool = state.allTabs.length ? state.allTabs : state.tabs;
  const out = new Map();
  for (const c of ruleConflicts(state.rules, pool)) {
    if (!out.has(c.loser)) out.set(c.loser, []);
    out.get(c.loser).push(c);
  }
  return out;
}

function matchingTabs(rule) {
  const pats = compileRule(rule);
  if (!pats.length) return [];
  return state.tabs.filter((t) => isSaveable(t.url) && ruleMatches(pats, t.url, t.title));
}

function refreshRuleCounts() {
  for (const rule of state.rules) {
    const node = document.querySelector(`.rule-card[data-id="${rule.id}"] .rule-count`);
    if (!node) continue;
    const n = matchingTabs(rule).length;
    const text = n
      ? `Show the ${n} open tab${n === 1 ? '' : 's'} this catches`
      : 'Nothing open matches this right now';
    if (node.textContent !== text && !node._open) node.textContent = text;
  }
}

/**
 * Rebuilt only when the set of rules changes — editing a name or pattern list
 * must not tear the DOM out from under the caret.
 */
function renderRules(force) {
  const root = $('#view-rules');
  const key = state.rules.map((r) => r.id).join(',');
  if (!force && key === rulesDomKey) return;
  rulesDomKey = key;

  const nodes = [];

  nodes.push(viewIntro({
    lede: 'A rule spots tabs by their address, then files them into a space, ' +
          'gathers them into a named tab group, or both.',
    label: '+ New rule',
    onClick: () => newRule('New rule', [])
  }));

  /* ---- the two ways rules run: automatically, and on demand */
  const when = el('div', 'card run-card');
  when.append(el('div', 'band-label', 'When rules run'));

  const toggle = el('label', 'global-toggle');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = state.settings.autoApply !== false;
  cb.addEventListener('change', async () => {
    state.settings = { ...state.settings, autoApply: cb.checked };
    await setStore('settings', state.settings);
    toast(cb.checked ? 'Rules will run as you browse' : 'Rules will only run when you press the button');
  });
  const lbl = el('span');
  lbl.innerHTML = '<b>As I browse</b><br>' +
    'Every time a tab opens, navigates, or first gets a title. The tab you are ' +
    'looking at is left alone, so the page never disappears from under you.';
  toggle.append(cb, lbl);
  when.append(toggle);

  // Rules fire on events, by design — so tabs that were already open when you
  // wrote the rule need one explicit sweep. This is that sweep, and it is now
  // the only button of its kind.
  const runRow = el('div', 'run-row');
  const run = el('button', null, 'Run rules now');
  run.addEventListener('click', runRulesNow);
  const runWhy = el('span', 'hint',
    'Sorts every tab already open in this window, including the one you are ' +
    'looking at. Tabs you moved into a space by hand are left where you put them. ' +
    'Nothing is closed or reloaded.');
  runRow.append(run, runWhy);
  when.append(runRow);
  nodes.push(when);

  const q = state.query.toLowerCase();
  const list = q
    ? state.rules.filter((r) =>
        r.name.toLowerCase().includes(q) ||
        (r.patterns || []).some((p) => p.toLowerCase().includes(q)))
    : state.rules;

  if (!list.length) {
    nodes.push(emptyState('No rules yet',
      'Say which tabs a rule should catch — booking.com, easyjet.com, expedia.com — then say where they go: into your Trips space, into a tab group called Travel, or both.'));
  } else {
    const clashes = conflictsByLoser();
    if (list.length > 1) {
      nodes.push(el('div', 'order-note',
        'Order decides clashes: when two rules catch the same tab, the one higher ' +
        'in this list wins. Use ↑ and ↓ to change it.'));
    }
    list.forEach((rule) => nodes.push(ruleCard(rule, clashes.get(rule.id) || [])));
  }

  // Reference, not reading. It was six lines of syntax sitting under every
  // visit to this screen; folded away it is still one click from the patterns
  // it describes. Backup and the version line moved to Settings, where someone
  // looking for them would actually go.
  const help = el('details', 'help');
  help.append(el('summary', null, 'How to write a pattern'));
  const hint = el('div', 'hint');
  hint.innerHTML =
    'One pattern per line. A bare domain matches the site and its subdomains ' +
    '(<code>booking.com</code>); anything with a slash or no dot matches ' +
    'anywhere in the URL (<code>jira</code>, <code>/trips/</code>); ' +
    '<code>*</code> is a wildcard (<code>*.expedia.*</code>) and ' +
    '<code>/regex/i</code> works too. Start a line with <code>title:</code> to ' +
    'match the tab’s title instead of its URL (<code>title:SideRail</code>, ' +
    '<code>title:/^Inbox/i</code>); <code>url:</code> says so explicitly. ' +
    'Tab groups you named by hand are never touched, and neither is a tab you ' +
    'moved into a space yourself.';
  help.append(hint);
  nodes.push(help);

  syncChildren(root, nodes);
  refreshRuleCounts();
}

function ruleCard(rule, clashes = []) {
  const card = el('div', 'card rule-card');
  card.dataset.id = rule.id;
  const at = state.rules.findIndex((r) => r.id === rule.id);
  const paint = () => card.style.setProperty('--gc', `var(--g-${rule.color || 'grey'})`);
  paint();

  /* header: colour, name, enabled, delete */
  const head = el('div', 'rule-head');

  const swatch = el('button', 'swatch');
  swatch.title = 'Group colour';
  const palette = el('div', 'palette');
  palette.hidden = true;
  GROUP_COLORS.forEach((c) => {
    const s = el('button', 'swatch' + (c === rule.color ? ' is-on' : ''));
    s.style.setProperty('--gc', `var(--g-${c})`);
    s.title = c;
    s.addEventListener('click', async () => {
      rule.color = c;
      paint();
      palette.querySelectorAll('.swatch').forEach((x) => x.classList.remove('is-on'));
      s.classList.add('is-on');
      palette.hidden = true;
      await saveRules();
      applyNow();
    });
    palette.append(s);
  });
  swatch.addEventListener('click', () => { palette.hidden = !palette.hidden; });

  const name = el('input', 'rule-name');
  name.value = rule.name || '';
  name.placeholder = 'Rule name (also the group’s title)';
  name.addEventListener('input', () => { rule.name = name.value; queueSaveRules(); });

  const onLbl = el('label', 'rule-toggle');
  const on = el('input');
  on.type = 'checkbox';
  on.checked = rule.enabled !== false;
  on.addEventListener('change', async () => { rule.enabled = on.checked; await saveRules(); });
  onLbl.append(on, el('span', null, 'On'));

  const del = el('button', 'icon-btn', '×');
  del.title = 'Delete rule';
  del.addEventListener('click', async () => {
    // Deleting the rule does not, on its own, take apart the groups it built —
    // they are ordinary Chrome tab groups. Left behind they keep a square in
    // the jump bar with no rule behind it, which is what makes deletion look
    // like it half-failed.
    const held = await ruleGroupSize(rule.name);
    const ans = await openDialog({
      title: `Delete “${rule.name}”?`,
      message: held
        ? `Its tab group${held === 1 ? '' : 's'} hold <strong>${held} tab${held === 1 ? '' : 's'}</strong>. ` +
          'Ungrouping keeps every one of them open — it only takes the group apart, ' +
          'and clears its square from the jump bar.'
        : 'This rule has no tabs grouped right now.',
      buttons: held
        ? [
            { label: 'Delete and ungroup', value: 'both', danger: true },
            { label: 'Delete, keep the groups', value: 'rule' },
            { label: 'Cancel', value: null }
          ]
        : [
            { label: 'Delete rule', value: 'rule', danger: true },
            { label: 'Cancel', value: null }
          ]
    });
    if (!ans) return;

    state.rules = state.rules.filter((r) => r.id !== rule.id);
    await saveRules();
    if (ans.value === 'both') await dissolveRuleGroups(rule.name);
    renderRules(true);
    toast(ans.value === 'both' ? 'Rule deleted, tabs ungrouped' : 'Rule deleted');
  });

  const up = el('button', 'icon-btn rank', '↑');
  up.title = 'Higher priority — beats the rules below it when both catch a tab';
  up.setAttribute('aria-label', `Give “${rule.name || 'this rule'}” higher priority`);
  up.disabled = at <= 0;
  up.addEventListener('click', () => moveRule(rule.id, -1));

  const down = el('button', 'icon-btn rank', '↓');
  down.title = 'Lower priority — the rules above it win when both catch a tab';
  down.setAttribute('aria-label', `Give “${rule.name || 'this rule'}” lower priority`);
  down.disabled = at === -1 || at >= state.rules.length - 1;
  down.addEventListener('click', () => moveRule(rule.id, 1));

  head.append(swatch, name, up, down, onLbl, del);
  card.append(head, palette);

  /* -------- rules that are quietly overruling this one */
  for (const c of clashes) {
    const other = state.rules.find((r) => r.id === c.winner);
    if (!other) continue;
    const box = el('div', 'rule-clash');
    const n = c.tabIds.length;
    box.append(el('span', null,
      `${n} open tab${n === 1 ? ' also matches' : 's also match'} “${other.name || 'a rule'}”, ` +
      `which is higher in the list — so ${n === 1 ? 'it goes' : 'they go'} ` +
      (c.kind === 'group'
        ? `into that rule’s group, not this one’s.`
        : `into that rule’s space, not this one’s.`)));
    const fix = el('button', 'ghost-btn', 'Put this rule first');
    fix.addEventListener('click', async () => {
      const from = state.rules.findIndex((r) => r.id === rule.id);
      const above = state.rules.findIndex((r) => r.id === c.winner);
      if (from === -1 || above === -1) return;
      await moveRule(rule.id, above - from);
    });
    box.append(fix);
    card.append(box);
  }

  /* -------- band one: what this rule catches */
  const bandMatch = el('div', 'rule-band');
  bandMatch.append(el('div', 'band-label', 'Catches tabs matching'));

  const pats = el('textarea', 'rule-pats');
  pats.value = (rule.patterns || []).join('\n');
  pats.placeholder = 'booking.com\neasyjet.com\nexpedia.com';
  pats.spellcheck = false;
  const autosize = () => {
    const lines = Math.max(3, pats.value.split('\n').length);
    pats.style.height = `${lines * 18 + 14}px`;
  };
  pats.addEventListener('input', () => {
    rule.patterns = pats.value.split('\n').map((s) => s.trim()).filter(Boolean);
    autosize();
    queueSaveRules();
    refreshRuleCounts();
  });
  bandMatch.append(pats);
  requestAnimationFrame(autosize);

  /* matches, expandable */
  const count = el('button', 'rule-count');
  const hits = el('div', 'rule-hits');
  hits.hidden = true;
  count.addEventListener('click', () => {
    hits.hidden = !hits.hidden;
    count._open = !hits.hidden;
    if (!hits.hidden) {
      const list = matchingTabs(rule);
      hits.replaceChildren(...(list.length
        ? list.map((t) => {
            const h = el('div', 'hit');
            h.append(letterTile(domainOf(t.url) || t.title));
            h.append(el('span', null, t.title || t.url));
            h.title = t.url;
            h.addEventListener('click', () => activateTab(t.id));
            return h;
          })
        : [el('div', 'hit', 'Nothing open matches this rule right now.')]));
      count.textContent = 'Hide the matching tabs';
    } else {
      count._open = false;
      refreshRuleCounts();
    }
  });
  bandMatch.append(count, hits);
  card.append(bandMatch);

  /* -------- band two: what it then does about them
   *
   * This used to sit at the bottom, under the match list, with the sentence
   * explaining it below that again. Read top to bottom the card said what it
   * caught, how many it caught, what it did, and only then what that meant.
   * Catch first, act second, in that order, with the plain-English line
   * directly under the two controls it describes.
   */
  const bandDo = el('div', 'rule-band');
  bandDo.append(el('div', 'band-label', 'Then does this'));

  const doing = el('div', 'rule-doing');
  const acts = el('div', 'rule-acts');

  // Action 1 — file into a space.
  const fileRow = el('label', 'ract');
  fileRow.append(el('span', 'ract-k', 'Move them to'));
  const sel = el('select', 'ract-sel');
  const rebuildOptions = () => {
    const want = rule.spaceId || '';
    sel.replaceChildren();
    const none = el('option', null, 'Nowhere — don’t move them');
    none.value = '';
    sel.append(none);
    for (const sp of spacesForDisplay()) {
      const o = el('option', null, `${sp.emoji ? `${sp.emoji} ` : ''}${sp.name}`);
      o.value = sp.id;
      sel.append(o);
    }
    // A space deleted while the rule pointed at it: say so rather than
    // silently snapping the menu back to "leave where it is".
    if (want && !sel.querySelector(`option[value="${CSS.escape(want)}"]`)) {
      const gone = el('option', null, 'Missing space — pick another');
      gone.value = want;
      sel.append(gone);
    }
    sel.value = want;
  };
  rebuildOptions();
  sel.addEventListener('change', async () => {
    rule.spaceId = sel.value;
    describe();
    await saveRules();
    renderRules(true);          // the backlog button appears/disappears with this
  });
  fileRow.append(sel);

  // Action 2 — put them in a tab group.
  const groupRow = el('label', 'ract');
  const gcb = el('input');
  gcb.type = 'checkbox';
  gcb.checked = rule.group !== false;
  gcb.addEventListener('change', async () => {
    rule.group = gcb.checked;
    card.classList.toggle('no-group', !gcb.checked);
    describe();
    await saveRules();
    if (gcb.checked) { applyNow(); return; }
    // Switching grouping off stops NEW groups being made, but says nothing
    // about the ones already on screen — and a group left standing with no rule
    // behind it, still holding a jump-bar square, reads as the setting having
    // been ignored. Take them apart. Nothing closes.
    const n = await dissolveRuleGroups(rule.name);
    if (n) toast(`Ungrouped ${n} tab${n === 1 ? '' : 's'}`);
  });
  groupRow.append(gcb, el('span', null,
    'Gather them into a tab group named after this rule'));

  acts.append(fileRow, groupRow);

  function describe() {
    const sp = rule.spaceId ? liveSpaceById(rule.spaceId) : null;
    const parts = [];
    if (rule.spaceId) parts.push(`moves them to ${sp ? sp.name : 'a space that no longer exists'}`);
    if (ruleGroups(rule)) parts.push(`groups them as “${(rule.name || '').trim() || 'Group'}”`);
    doing.textContent = parts.length
      ? `In plain terms: this rule ${parts.join(', and ')}.`
      : 'This rule catches tabs but does nothing with them — pick a space, or switch grouping on.';
    doing.classList.toggle('is-idle', !parts.length);
  }
  describe();
  card.classList.toggle('no-group', rule.group === false);
  name.addEventListener('input', describe);

  bandDo.append(acts, doing);
  card.append(bandDo);

  // No per-rule "Apply now". It never applied just this rule — it ran the same
  // all-rules pass as the button at the top of the screen, which is exactly the
  // sort of thing nobody can be expected to know. "Run rules now" says what it
  // does and there is only one of it.

  return card;
}

/**
 * Restore one captured window, and put its tabs back in their spaces.
 *
 * Two things happen here that `restoreCapture` deliberately doesn't do, because
 * it touches no storage: spaces the snapshot referred to that no longer exist
 * are offered back, and membership is written for the newly created tabs.
 *
 * Without this a restore is only as good as today's configuration — the tabs
 * come back and are then sorted by URL against whatever the spaces look like
 * *now*, which is precisely wrong for a feature whose job is to undo changes.
 */
async function restoreSnapshotWindow(snap, w) {
  const gone = missingSpacesIn({ ...snap, windows: [w] }, state.spaces);

  let recreate = false;
  if (gone.length) {
    const names = gone.map((sp) => `${sp.emoji || ''} ${sp.name}`.trim()).join(', ');
    const one = gone.length === 1;
    const ans = await openDialog({
      title: one ? 'That space is gone' : 'Those spaces are gone',
      message:
        `This snapshot has tabs from <strong>${esc(names)}</strong>, which no ` +
        `longer exist${one ? 's' : ''}. Bring ${one ? 'it' : 'them'} back, or ` +
        `put those tabs in <strong>${esc(mainSpace().name)}</strong>?`,
      buttons: [
        { label: one ? 'Recreate the space' : 'Recreate them', value: 'recreate', primary: true },
        { label: `Put them in ${mainSpace().name}`, value: 'main' },
        { label: 'Cancel', value: null }
      ]
    });
    if (!ans) return;
    recreate = ans.value === 'recreate';
  }

  if (recreate) {
    // Reuse the original ids: every tab in the snapshot records the OLD id, so
    // a fresh one would orphan exactly what we are restoring.
    state.spaces = [...state.spaces,
      ...gone.map((sp) => makeLiveSpace({ name: sp.name, emoji: sp.emoji, id: sp.id }))];
    await persistSpaces();
  }

  const r = await restoreCapture(w, 'new');

  if (r.placed && r.placed.length) {
    const valid = new Set([MAIN, GLOBAL_PIN, ...state.spaces.map((sp) => sp.id)]);
    for (const { tabId, space } of r.placed) {
      state.spaceOf[tabId] = valid.has(space) ? space : MAIN;
      // A restored tab was placed by the snapshot, not by a rule. Mark it the
      // way a hand placement is marked, or the filing engine will move it
      // somewhere else on its next pass and undo the restore.
      state.spacePinned[tabId] = true;
    }
    await persistMembership();
    queueManifest();
    lastSig = null;
    render();
  }

  toast(r.placed && r.placed.length
    ? `Restored ${r.created} tabs into their spaces`
    : `Restored ${r.created} tabs`);
}

/* --------------------------------------------------------- rewind view */

/** Row of letter tiles standing in for favicons of saved (not live) tabs. */
function favStack(tabs) {
  const stack = el('div', 'fav-stack');
  tabs.slice(0, 12).forEach((t) => stack.append(letterTile(domainOf(t.url) || t.title)));
  if (tabs.length > 12) stack.append(el('span', 'more', `+${tabs.length - 12}`));
  return stack;
}

function renderRewind() {
  const root = $('#view-rewind');
  const nodes = [];

  nodes.push(viewIntro({
    lede: 'Every five minutes SideRail records what is open in each window, and ' +
          'which space each tab was in. The last 50 recordings are kept.',
    label: 'Take one now',
    onClick: async () => {
      const r = await send({ type: 'snapshot-now' });
      toast(r?.snap ? 'Snapshot taken' : 'Nothing has changed since the last one');
    }
  }));

  const q = state.query.toLowerCase();
  const list = q
    ? state.snapshots.filter((s) => s.windows.some((w) => w.tabs.some((t) =>
        (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q))))
    : state.snapshots;

  if (q) {
    // The filter box sits in the header and looks like it searches tabs. Say
    // out loud what it just did to this list, or it reads as tabs going missing.
    nodes.push(el('div', 'filter-note',
      `Showing ${list.length} of ${state.snapshots.length} snapshots — the ones ` +
      `holding a tab that matches “${state.query}”.`));
  }

  if (!list.length) {
    nodes.push(state.snapshots.length
      ? emptyState('No snapshot holds that',
          'No recording contains a tab matching your filter. Clear it to see them all.')
      : emptyState('No snapshots yet',
          'The first recording is taken within five minutes of SideRail starting.'));
  } else {
    list.forEach((snap) => nodes.push(snapCard(snap)));
  }
  syncChildren(root, nodes);
}

/** Collapse specs that point at the same page, keeping the first seen. */
function dedupeSpecs(specs) {
  const seen = new Set();
  const out = [];
  for (const t of specs) {
    const k = normUrl(t.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * What each space held when the snapshot was taken, named as it was named then.
 *
 * "180 tabs · 1 window" answers none of the questions anyone actually has about
 * a snapshot, the first of which is what it will do to the spaces they have
 * now. Snapshots have recorded per-tab space membership since the feature was
 * written; nothing was showing it.
 */
function snapSpaceBreakdown(snap) {
  const known = new Map((snap.spaces || []).map((sp) => [sp.id, sp]));
  const counts = new Map();
  for (const w of snap.windows || []) {
    for (const t of w.tabs || []) {
      const id = t.space || MAIN;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => {
    if (id === GLOBAL_PIN) return { id, n, name: 'Pinned in every space', gone: false };
    if (id === MAIN) return { id, n, name: mainSpace().name, gone: false };
    const sp = known.get(id) || liveSpaceById(id);
    return {
      id, n,
      name: sp ? `${sp.emoji ? `${sp.emoji} ` : ''}${sp.name}` : 'A space that no longer exists',
      gone: !liveSpaceById(id)
    };
  });
}

function snapCard(snap) {
  const card = el('div', 'card');
  const top = el('div', 'card-top');
  top.append(el('span', 'card-name', clockTime(snap.at)));
  top.append(el('span', 'card-meta',
    `${timeAgo(snap.at)} · ${snap.tabCount} tabs · ${snap.windows.length} window${snap.windows.length === 1 ? '' : 's'}`));
  card.append(top);

  /* ---- which spaces those tabs were in */
  const parts = snapSpaceBreakdown(snap);
  if (parts.length) {
    const row = el('div', 'snap-spaces');
    for (const p of parts) {
      const chip = el('span', `snap-space${p.gone ? ' is-gone' : ''}`);
      chip.append(el('span', 'sn', p.name), el('span', 'sc', String(p.n)));
      if (p.gone) chip.title = 'This space has since been deleted. Restoring offers to bring it back.';
      row.append(chip);
    }
    card.append(row);
  }

  card.append(favStack(snap.windows.flatMap((w) => w.tabs)));

  const actions = el('div', 'card-actions');
  snap.windows.forEach((w, i) => {
    const b = el('button', i === 0 ? 'primary' : null,
      snap.windows.length === 1 ? 'Restore' : `Restore window ${i + 1} (${w.tabs.length})`);
    b.title = 'Opens these tabs in a NEW window — nothing you have open now is ' +
      'touched — and puts each one back in the space it was in.';
    // restoreSnapshotWindow, not restoreCapture. The plain capture restore puts
    // the tabs back and stops there: no membership written, no offer to bring
    // back a space that has since been deleted, so the tabs are then sorted
    // against today's configuration — precisely wrong for a feature whose job
    // is to undo. The better function existed all along and nothing called it.
    b.addEventListener('click', () => restoreSnapshotWindow(snap, w));
    actions.append(b);
  });

  // Pinned tabs are the ones you'd miss and the hardest to reconstruct from
  // memory, so they get their own action: re-pin them here without dragging the
  // whole snapshot back. Anything already open in this window is skipped, so
  // pressing it twice can't give you two of everything.
  const pinnedSaved = dedupeSpecs(snap.windows.flatMap((w) => (w.tabs || []).filter((t) => t.pinned)));
  if (pinnedSaved.length) {
    const rp = el('button', null,
      `Re-pin ${pinnedSaved.length} tab${pinnedSaved.length === 1 ? '' : 's'}`);
    rp.title = 'Pins these back into the window you are in now. Nothing is closed, ' +
      'and anything already open here is skipped.';
    rp.addEventListener('click', async () => {
      // normUrl returns a string, not a record — reading .url off it silently
      // collapsed every tab to the same undefined key.
      const open = new Set(state.tabs.map((t) => normUrl(t.url)));
      const missing = pinnedSaved.filter((t) => !open.has(normUrl(t.url)));
      if (!missing.length) return toast('All of those are already open here');
      const r = await restoreCapture({ tabs: missing, groups: [] }, 'append',
        { windowId: state.windowId });
      toast(`Re-pinned ${r.created} tab${r.created === 1 ? '' : 's'}`);
    });
    actions.append(rp);
  }

  const keep = el('button', null, 'Keep as a space');
  keep.title = 'Files these addresses away as a new space, to reopen whenever you like';
  keep.addEventListener('click', async () => {
    const savable = snap.windows.flatMap((w) => w.tabs).filter((t) => isSaveable(t.url));
    const name = `Rewind · ${clockTime(snap.at)}`;
    // Whether several spaces are about to be flattened into one is the whole
    // question, and the old button answered it nowhere.
    const spread = parts.filter((x) => x.n > 0);
    const ans = await openDialog({
      title: `Keep this as “${name}”?`,
      message:
        `A new space holding <strong>${savable.length} address${savable.length === 1 ? '' : 'es'}</strong> ` +
        'from this snapshot. Nothing opens, nothing closes, and the spaces you have now are left alone.' +
        (spread.length > 1
          ? `<br><br>This snapshot spans <strong>${spread.length} spaces</strong> ` +
            `(${esc(spread.map((x) => `${x.name} ${x.n}`).join(', '))}). ` +
            'They are <strong>combined into the one new space</strong> — the split between ' +
            'them is not kept. Restore the window instead if you want them back as they were.'
          : ''),
      buttons: [
        { label: 'Create the space', value: 'ok', primary: true },
        { label: 'Cancel', value: null }
      ]
    });
    if (!ans) return;

    const sp = makeLiveSpace({ name, emoji: '🕘' });
    sp.manifest = savable.map((t) => ({ url: t.url, title: t.title || '', pinned: !!t.pinned }));
    state.spaces = [...state.spaces, sp];
    await setStore('spaces', state.spaces);
    toast(`Created ${sp.name} · ${sp.manifest.length} addresses — open it from Spaces`);
  });
  actions.append(keep);

  card.append(actions);
  return card;
}

/* ------------------------------------------------------------------ go */

init().catch((e) => {
  console.error('[SideRail] init failed', e);
  document.body.textContent = `SideRail failed to start: ${e}`;
});
