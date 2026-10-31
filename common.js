// common.js — shared helpers for SideRail.
// No network access, no host permissions, everything stays in chrome.storage.local.

export const NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE
export const MAX_SNAPSHOTS = 50;
export const SNAPSHOT_ALARM = 'siderail-snapshot';
export const GROUP_COLORS = [
  'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'
];

/* ------------------------------------------------------------------ URLs */

/** Hostname without a leading www., or '' for internal/blank pages. */
export function domainOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** True for anything worth persisting in a workspace or snapshot. */
export function isSaveable(url) {
  if (!url) return false;
  return /^(https?|file|ftp):/i.test(url);
}

/**
 * Query parameters that identify where a click came from rather than what the
 * page is. Two URLs differing only by these point at the same page.
 *
 * Edit these lists freely — they only affect duplicate detection, and because
 * Dedupe asks before closing anything, an over-eager match costs you a tick-box
 * rather than a tab.
 */
export const TRACKING_PREFIXES = [
  'utm_',      // Google Analytics and everything that copied it
  'pk_', 'mtm_', 'piwik_',  // Matomo
  'hsa_',      // HubSpot ads
  'vero_',     // Vero
  'oly_'       // Olytics
];

export const TRACKING_PARAMS = new Set([
  // Ad-network click identifiers
  'gclid', 'gclsrc', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid',
  'twclid', 'ttclid', 'igshid', 'yclid', 'rdt_cid', 'li_fat_id', 'epik',
  's_kwcid', 'gad_source', 'gad_campaignid', 'srsltid',
  // Email and newsletter platforms
  'mc_cid', 'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'ck_subscriber_id',
  'vero_id', 'vero_conv', 'wickedid', 'sc_channel', 'sc_campaign',
  'sc_publisher', 'sc_content', 'sc_medium', 'sc_detail',
  // Referral / attribution
  'ref', 'ref_src', 'ref_url', 'referrer', 'referral', 'source', 'trk',
  'trkcampaign', 'cmpid', 'campaign_id', 'campaignid', 'at_medium',
  'at_campaign', 'spm', 'scm', 'share_id', 'si', 'feature'
]);

export function isTrackingParam(name) {
  const n = String(name || '').toLowerCase();
  if (TRACKING_PARAMS.has(n)) return true;
  return TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

/** Tracking parameter names present in a URL, for explaining a match. */
export function trackingParamsIn(url) {
  try {
    return [...new URL(url).searchParams.keys()].filter(isTrackingParam);
  } catch {
    return [];
  }
}

/**
 * Canonical form used for duplicate detection.
 *
 * Drops tracking parameters, sorts the rest (so ?a=1&b=2 matches ?b=2&a=1),
 * removes a trailing slash, and drops the fragment — except where the fragment
 * looks like a client-side route (#/inbox, #!/x), since those really are
 * different pages.
 */
export function normUrl(url) {
  try {
    const u = new URL(url);

    if (!/^#[!/]/.test(u.hash)) u.hash = '';

    const keep = [];
    for (const [k, v] of u.searchParams) {
      if (!isTrackingParam(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));
    u.search = '';
    for (const [k, v] of keep) u.searchParams.append(k, v);

    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.toString().replace(/\?$/, '');
  } catch {
    return url || '';
  }
}

/** Short, human-readable label for a URL. */
export function prettyUrl(url) {
  const d = domainOf(url);
  if (d) return d;
  try {
    return new URL(url).protocol.replace(':', '');
  } catch {
    return url || '';
  }
}

/* ---------------------------------------------------------------- colour */

/** Stable colour choice for a string, so a domain always gets the same one. */
export function colorFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % (GROUP_COLORS.length - 1)]; // skip grey
}

/** Deterministic pastel HSL for letter-tile fallback icons. */
export function hueFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

/* --------------------------------------------------------------- search */

/**
 * Constrained subsequence match, used only as a last resort and only against
 * short strings like a title.
 *
 * A plain subsequence matcher is far too permissive: "supercharge" appears as
 * a subsequence inside plenty of long GitHub URLs purely by coincidence. So we
 * require the matched characters to sit close together — the span from first to
 * last matched character can't drift far beyond the length of the query itself.
 */
function subsequenceScore(needle, hay) {
  if (needle.length < 3) return -1; // too short to fuzz safely
  let hi = 0, first = -1, streak = 0, score = 0;
  for (const c of needle) {
    const j = hay.indexOf(c, hi);
    if (j === -1) return -1;
    if (first === -1) first = j;
    streak = j === hi ? streak + 1 : 0;
    score += 1 + streak * 2;
    hi = j + 1;
  }
  const span = hi - first;
  if (span > needle.length * 2 + 4) return -1; // scattered — reject
  return score;
}

/** Score one query term against a tab's parts. -1 means "no match". */
function scoreTerm(term, title, url, host) {
  let i;
  if ((i = host.indexOf(term)) !== -1) return 1000 - i * 2;
  if ((i = title.indexOf(term)) !== -1) return 900 - Math.min(i, 100);
  if ((i = url.indexOf(term)) !== -1) return 700 - Math.min(i, 200);

  // Initials: "gd" finds "Google Docs".
  const initials = title.split(/[\s\-–—_/|·:,.]+/).filter(Boolean).map((w) => w[0]).join('');
  if (term.length >= 2 && initials.includes(term)) return 500;

  const sub = subsequenceScore(term, title);
  return sub >= 0 ? 200 + sub : -1;
}

/**
 * Rank a tab-ish object against a query. Every whitespace-separated term must
 * match somewhere, so "git super" narrows rather than widens.
 * Returns a score (higher is better) or -1 for no match.
 */
export function matchScore(query, item) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return 0;
  const title = (item.title || '').toLowerCase();
  const url = (item.url || '').toLowerCase();
  const host = domainOf(item.url || '').toLowerCase();

  const terms = q.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const term of terms) {
    const s = scoreTerm(term, title, url, host);
    if (s < 0) return -1;
    total += s;
  }
  return total / terms.length;
}

/**
 * Rank a list of {title,url} records against a query, dropping anything already
 * open. Pure, so it can be tested without touching the bookmarks/history APIs.
 * Array.sort is stable, so the caller's original order survives ties — which is
 * how history keeps its newest-first ordering.
 */
export function rankItems(query, list, openUrls) {
  const open = openUrls instanceof Set ? openUrls : new Set(openUrls || []);
  return (list || [])
    .filter((x) => x && x.url && !open.has(x.url))
    .map((x) => ({ x, s: matchScore(query, x) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.x);
}

/* ------------------------------------------------- is that a URL or a search? */

// An allowlist, not a general scheme regex: "title:SideRail" and "note: buy
// milk" both parse as a scheme + path, and neither is somewhere to navigate.
const SCHEMES = new Set([
  'http', 'https', 'file', 'ftp', 'ftps', 'mailto',
  'chrome', 'chrome-extension', 'edge', 'about', 'view-source', 'data'
]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Would a browser treat this as somewhere to go?
 *
 * Deliberately stricter than the omnibox, which can afford to guess because a
 * wrong guess just searches. Here a false positive offers "Open" for something
 * that isn't a place, which is worse than not offering it — so a bare host must
 * end in a plausible TLD (letters only, two or more). That keeps "3.5",
 * "v1.2.3" and "e.g" out while letting localhost and IPv4 through.
 */
export function looksLikeHost(text) {
  const s = (text || '').trim().replace(/^\/\//, '');
  if (!s || /\s/.test(s)) return false;
  const hostPort = s.split(/[/?#]/)[0];
  if (!hostPort || hostPort.includes('@')) return false;   // an email address
  const bits = hostPort.split(':');
  if (bits.length > 2) return false;
  const [host, port] = bits;
  if (port !== undefined && !/^\d+$/.test(port)) return false;
  if (host === 'localhost' || IPV4.test(host)) return true;
  if (!host.includes('.')) return false;
  const labels = host.split('.');
  if (labels.some((l) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(l))) return false;
  return /^[a-z]{2,}$/i.test(labels[labels.length - 1]);
}

/**
 * Read a line of palette input as somewhere to go, something to search for, or
 * both.
 *
 * Both is the interesting case. "bbc.co.uk/news" is unambiguous, but
 * "bbc.co.uk news" is genuinely two readings — a site plus a word, or a phrase
 * to search — and guessing wrong is annoying either way. So it offers the site
 * first and the search underneath, and you pick with one arrow key.
 *
 * @returns {{ open: string|null, host: string, search: string, whole: boolean }}
 *   `open` is an absolute URL or null; `whole` says the entire input was the
 *   URL, with no words left over.
 */
export function readIntent(text) {
  const raw = (text || '').trim();
  const out = { open: null, host: '', search: raw, whole: false };
  if (!raw) { out.search = ''; return out; }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme && SCHEMES.has(scheme[1].toLowerCase()) && !/\s/.test(raw)) {
    out.open = raw;
    out.whole = true;
    try { out.host = new URL(raw).hostname; } catch { out.host = raw; }
    return out;
  }

  // No scheme: the first word decides. "bbc.co.uk/news" has one word and is a
  // whole URL; "bbc.co.uk news" has two, so opening covers only the first.
  const first = raw.split(/\s+/)[0];
  if (looksLikeHost(first)) {
    const bare = first.replace(/^\/\//, '');
    out.open = `https://${bare}`;
    out.host = bare.split(/[/?#]/)[0];
    out.whole = first === raw;
  }
  return out;
}

/** Collapse entries that normalise to the same URL, keeping the first. */
export function dedupeByUrl(list) {
  const seen = new Set();
  return (list || []).filter((x) => {
    const k = normUrl(x.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ---------------------------------------------------------------- rules */

/**
 * Turn a rule's patterns into matchers.
 *
 *   booking.com      → hostname match (also matches www./secure. subdomains)
 *   jira             → substring anywhere in the URL (no dot, so read as a keyword)
 *   /trips/          → substring anywhere in the URL (contains a slash)
 *   *.expedia.*      → glob, * is a wildcard
 *   /^https:\/\/x/i  → regular expression
 *
 * A bare domain deliberately matches the host rather than the raw URL, so
 * "booking.com" doesn't sweep up https://elsewhere.com/?ref=booking.com.
 *
 * A pattern may name the field it reads:
 *
 *   title:SideRail   → substring of the tab title
 *   title:/^Inbox/i  → regex against the title
 *   url:booking.com  → the URL (the default, so this is only ever for clarity)
 *
 * Bare patterns read the URL, which is what every rule written before title
 * matching existed meant — so old rules keep working untouched.
 */
const FIELD_RE = /^(title|url)\s*:\s*/i;

function compileOne(raw, field) {
  const p = raw;
  if (p.length > 2 && p.startsWith('/') && p.lastIndexOf('/') > 0 && /^\/.*\/[a-z]*$/i.test(p)) {
    const last = p.lastIndexOf('/');
    try { return { field, rx: new RegExp(p.slice(1, last), p.slice(last + 1) || 'i') }; }
    catch { return null; }
  }
  if (p.includes('*')) {
    const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try { return { field, rx: new RegExp(esc, 'i') }; } catch { return null; }
  }
  // "booking.com" means the host — but only when we're reading a URL. A title
  // has no host, so the same text there is just text.
  const bareDomain = field === 'url' && !p.includes('/') && p.includes('.') && !p.startsWith('.');
  return { field, kind: bareDomain ? 'host' : 'text', value: p.toLowerCase() };
}

export function compileRule(rule) {
  return (rule.patterns || [])
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .map((p) => {
      const m = FIELD_RE.exec(p);
      const field = m ? m[1].toLowerCase() : 'url';
      const rest = m ? p.slice(m[0].length).trim() : p;
      return rest ? compileOne(rest, field) : null;
    })
    .filter(Boolean);
}

export function ruleMatches(compiled, url, title = '') {
  if (!url && !title) return false;
  const lowerUrl = (url || '').toLowerCase();
  const lowerTitle = (title || '').toLowerCase();
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a parseable URL */ }

  return compiled.some((p) => {
    const onTitle = p.field === 'title';
    const subject = onTitle ? title || '' : url || '';
    if (!subject) return false;
    if (p.rx) return p.rx.test(subject);
    if (p.kind === 'host') return host === p.value || host.endsWith(`.${p.value}`);
    return (onTitle ? lowerTitle : lowerUrl).includes(p.value);
  });
}

/**
 * Does this rule put matching tabs into a tab group?
 *
 * Absent means yes: every rule written before filing existed was a grouping
 * rule, and `group: false` is something only the new UI can say.
 */
export const ruleGroups = (rule) => !!rule && rule.group !== false;

/** Does this rule file matching tabs into a space? */
export const ruleFiles = (rule) => !!(rule && rule.spaceId);

export const activeRules = (rules) =>
  (rules || []).filter((r) =>
    r.enabled !== false &&
    (r.patterns || []).some((p) => p && p.trim()) &&
    (ruleGroups(r) || ruleFiles(r)));

/**
 * Move tabs into Chrome tab groups according to the rules.
 *
 * Deliberately conservative: it only touches tabs that are ungrouped, or that
 * sit in a group whose title belongs to another rule. A group you named by hand
 * is never disturbed.
 */
export async function applyRules(windowId, rules, spaceOf = {}) {
  const active = activeRules(rules).filter(ruleGroups);
  if (!active.length) return 0;

  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId, pinned: false }),
    chrome.tabGroups.query({ windowId })
  ]);

  // One group per (rule, space): a tab has only one native group, so a shared
  // "Travel" group would put every space's Travel tabs in one collapsible unit.
  const plan = planRuleGroups(tabs, active, spaceOf, groups);

  let moved = 0;
  for (const step of plan) {
    try {
      const gid = step.groupId
        ? await chrome.tabs.group({ tabIds: step.tabIds, groupId: step.groupId })
        : await chrome.tabs.group({ tabIds: step.tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(gid, { title: step.ruleName, color: step.color });
      moved += step.tabIds.length;
    } catch {
      /* one bad rule shouldn't stop the rest */
    }
  }

  // Recolour existing rule groups even when no tabs need moving. Without this,
  // changing a rule's colour does nothing whenever its tabs are already grouped
  // — which is the normal case once the rule has run once. Every group carrying
  // the rule's name is recoloured, since there is now one per space.
  const fresh = await chrome.tabGroups.query({ windowId }).catch(() => groups);
  for (const rule of active) {
    const want = rule.color || 'grey';
    for (const g of fresh) {
      if ((g.title || '').toLowerCase() !== (rule.name || '').toLowerCase()) continue;
      if (g.color !== want) await chrome.tabGroups.update(g.id, { color: want }).catch(() => {});
    }
  }

  return moved;
}

/* -------------------------------------------------------------- storage */

export async function getStore(key, fallback) {
  const out = await chrome.storage.local.get(key);
  return out[key] === undefined ? fallback : out[key];
}

export async function setStore(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

/* ----------------------------------------------------------- formatting */

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
}

/* ------------------------------------------- workspace / snapshot shapes */

/**
 * Capture one window as a portable workspace payload.
 * Stores URLs, titles, pinned + mute state, and tab-group name/colour.
 */
export async function captureWindow(windowId, { includePinned = true, spaceOf = null } = {}) {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId })
  ]);

  const groupIndex = new Map();
  const outGroups = groups.map((g, i) => {
    groupIndex.set(g.id, i);
    return { key: i, title: g.title || '', color: g.color, collapsed: !!g.collapsed };
  });

  const outTabs = tabs
    .filter((t) => isSaveable(t.url) && (includePinned || !t.pinned))
    .sort((a, b) => a.index - b.index)
    .map((t) => {
      const out = {
        url: t.url,
        title: t.title || t.url,
        pinned: !!t.pinned,
        muted: !!(t.mutedInfo && t.mutedInfo.muted),
        groupKey: groupIndex.has(t.groupId) ? groupIndex.get(t.groupId) : null
      };
      // Which space the tab was in, when the caller knows. Recorded rather than
      // re-derived, because deriving it later means matching URLs against
      // whatever the spaces look like *then* — which is exactly wrong for a
      // feature whose job is to undo changes. GLOBAL_PIN is just another value
      // here, so per-space and global pins need no special case.
      if (spaceOf) out.space = spaceOf[t.id] || MAIN;
      return out;
    });

  const usedKeys = new Set(outTabs.map((t) => t.groupKey).filter((k) => k !== null));
  return { tabs: outTabs, groups: outGroups.filter((g) => usedKeys.has(g.key)) };
}

/**
 * Recreate a captured payload. mode: 'new' | 'replace' | 'append'.
 *
 * `into` names the window for 'replace' / 'append'. Pass it from a side panel:
 * `windows.getCurrent()` answers about the panel's own context, which is not
 * reliably the browser window whose tabs the panel is showing.
 */
export async function restoreCapture(payload, mode = 'new', { keepPinned = false, windowId: into = null } = {}) {
  const tabs = (payload.tabs || []).filter((t) => isSaveable(t.url));
  if (!tabs.length) return { created: 0 };

  let windowId;
  let scratchTabId = null;
  let oldTabIds = [];

  if (mode === 'new') {
    const win = await chrome.windows.create({ focused: true, url: 'about:blank' });
    windowId = win.id;
    scratchTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  } else {
    windowId = into || (await chrome.windows.getCurrent()).id;
    if (mode === 'replace') {
      const existing = await chrome.tabs.query({ windowId });
      oldTabIds = existing.filter((t) => !(keepPinned && t.pinned)).map((t) => t.id);
    }
  }

  const created = [];
  for (const spec of tabs) {
    try {
      const tab = await chrome.tabs.create({
        windowId,
        url: spec.url,
        pinned: !!spec.pinned,
        active: false
      });
      created.push({ tab, spec });
    } catch {
      /* a URL Chrome refuses to open shouldn't abort the whole restore */
    }
  }

  for (const { tab, spec } of created) {
    if (spec.muted) await chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  }

  const byGroup = new Map();
  for (const { tab, spec } of created) {
    if (spec.groupKey === null || spec.groupKey === undefined) continue;
    if (!byGroup.has(spec.groupKey)) byGroup.set(spec.groupKey, []);
    byGroup.get(spec.groupKey).push(tab.id);
  }

  for (const [key, ids] of byGroup) {
    try {
      const meta = (payload.groups || []).find((g) => g.key === key) || {};
      const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      await chrome.tabGroups.update(gid, {
        title: meta.title || '',
        color: meta.color || 'grey',
        collapsed: !!meta.collapsed
      });
    } catch {
      /* grouping is cosmetic — never fail the restore over it */
    }
  }

  if (scratchTabId) await chrome.tabs.remove(scratchTabId).catch(() => {});
  if (oldTabIds.length) await chrome.tabs.remove(oldTabIds).catch(() => {});

  if (created.length) {
    await chrome.tabs.update(created[0].tab.id, { active: true }).catch(() => {});
  }
  // The caller owns space membership — it lives in storage.session and this
  // module deliberately touches no storage. Hand back the pairing so whoever
  // restored can put the tabs back where they were.
  const placed = created
    .filter(({ spec }) => spec.space)
    .map(({ tab, spec }) => ({ tabId: tab.id, space: spec.space }));
  return { created: created.length, windowId, placed };
}

/**
 * Spaces a snapshot's tabs belonged to that no longer exist.
 *
 * Restoring into "wherever these URLs happen to match today" is the behaviour
 * this whole change exists to remove: a snapshot taken before you deleted a
 * space should be able to bring that space back, not quietly tip its tabs into
 * Main and say nothing.
 *
 * @returns {{id:string,name:string,emoji:string}[]}
 */
export function missingSpacesIn(snapshot, liveSpaces) {
  const live = new Set([MAIN, GLOBAL_PIN, ...(liveSpaces || []).map((sp) => sp.id)]);
  const used = new Set();
  for (const w of snapshot.windows || []) {
    for (const t of w.tabs || []) if (t.space) used.add(t.space);
  }
  // Only spaces the snapshot actually recorded. A tab can carry the id of a
  // space that was already gone when the snapshot was taken — stale membership
  // rather than something to resurrect — and offering to recreate a nameless
  // "Recovered space" for those is noise. The restore maps them to Main.
  const known = new Map((snapshot.spaces || []).map((sp) => [sp.id, sp]));
  return [...used].filter((id) => !live.has(id) && known.has(id)).map((id) => known.get(id));
}

/* ---------------------------------------------------- page-text scanning */

/**
 * Injected into a tab by chrome.scripting.executeScript, so it is serialised
 * with toString() and must close over nothing. Lives here so the test suite can
 * import and exercise it directly.
 *
 * Reads the page's visible text ONCE so the panel can search it locally as
 * many times as it likes — see the index in sidepanel.js. Skips the page's
 * chrome (nav, header, footer, aside, controls) so a docs page is its article
 * and not its sidebar, and stops at a wall-clock budget so a giant DOM returns
 * partial rather than late.
 *
 * Three kinds of page decline to be read, and say why:
 *   noindex  — <meta name="robots" content="noindex">: the page's own request.
 *   login    — a password field on a page that is little else, or whose path
 *              says login/signin. A public page with a login box in its header
 *              has thousands of characters of content and is read normally.
 *   payment  — card or one-time-code fields.
 * `ready: false` means there is no body yet, or the document is still being
 * parsed: a glance, not a read; the caller tries again later.
 *
 * `doc` exists so a test can hand in a stand-in; executeScript passes one arg
 * and this falls through to the page's own document.
 */
export function PAGE_TEXT(budgetMs, doc) {
  const clock = () =>
    (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const started = clock();
  const budget = budgetMs === undefined || budgetMs === null ? 400 : budgetMs;
  const CAP = 300000;
  const d = doc || document;

  if (!d.body || d.readyState === 'loading') return { ready: false };

  const q = (sel) => { try { return d.querySelector(sel); } catch { return null; } };
  const robots = q('meta[name="robots"], meta[name="googlebot"]');
  if (robots && /\bnoindex\b/i.test(robots.getAttribute('content') || '')) {
    return { ready: true, skip: 'noindex' };
  }
  if (q('input[autocomplete^="cc-"], input[autocomplete="one-time-code"]')) {
    return { ready: true, skip: 'payment' };
  }

  // Element filtering happens in the walker callback, which crosses into JS
  // once per element. Measured at 0.5–2.5ms on real pages; the budget bounds
  // the pathological ones.
  const SKIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, IFRAME: 1, svg: 1, SVG: 1,
    NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1,
    BUTTON: 1, SELECT: 1, OPTION: 1, TEXTAREA: 1, INPUT: 1
  };
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      if (SKIP[n.nodeName]) return NodeFilter.FILTER_REJECT;
      const role = n.getAttribute('role');
      if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return NodeFilter.FILTER_REJECT;
      if (n.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    }
  });

  const parts = [];
  let len = 0;
  let seen = 0;
  let partial = false;
  let node;
  while ((node = walker.nextNode())) {
    if ((++seen & 255) === 0 && clock() - started > budget) { partial = true; break; }
    const v = node.nodeValue;
    if (!v) continue;
    const t = v.replace(/\s+/g, ' ');
    if (t === ' ') continue;
    parts.push(t);
    len += t.length + 1;
    if (len >= CAP) { partial = true; break; }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, CAP);

  const path = (d.location && d.location.pathname) || '';
  if (q('input[type="password"]') &&
      (text.length < 1500 || /(^|\/)(log-?in|sign-?in|sign-?up|register|auth)(\/|$|\.)/i.test(path))) {
    return { ready: true, skip: 'login' };
  }
  return { ready: true, text, title: String(d.title || ''), partial, ms: Math.round(clock() - started) };
}

/**
 * Count the query in one indexed page and cut a snippet around the first hit.
 * Case-insensitive phrase match. `entry.lower` is the lowercased text kept
 * beside the original precisely so this never lowercases 300KB per keystroke.
 */
export function searchText(entry, query, { cap = 500 } = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (!q || !entry || !entry.lower) return { count: 0, snippet: '' };
  let count = 0;
  let first = -1;
  let i = entry.lower.indexOf(q);
  while (i !== -1 && count < cap) {
    if (first === -1) first = i;
    count++;
    i = entry.lower.indexOf(q, i + q.length);
  }
  if (!count) return { count: 0, snippet: '' };
  const text = entry.text || '';
  const start = Math.max(0, first - 45);
  const end = Math.min(text.length, first + q.length + 70);
  return {
    count,
    snippet: (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
  };
}

/**
 * Is this host, or any parent domain of it, on the list? `list` is a Set of
 * domains; "example.bank" covers the site and every subdomain of it. Stops
 * before a bare top-level label, so a stray "com" could never match the world.
 */
export function hostExcluded(host, list) {
  if (!host || !list || !list.size) return false;
  let h = String(host).toLowerCase().replace(/^www\./, '');
  while (h) {
    const dot = h.indexOf('.');
    if (dot === -1) return false;
    if (list.has(h)) return true;
    h = h.slice(dot + 1);
  }
  return false;
}

/**
 * Hosts whose first label says "this is where you sign in or manage your
 * account", on any site: accounts.google.com, myaccount.admiral.com,
 * login.example.co.uk. No list can enumerate these; the label can. Needs at
 * least three labels, so a site that is simply called login.com is not caught.
 */
const PRIVATE_HOST_LABELS = new Set([
  'account', 'accounts', 'myaccount', 'my-account', 'login', 'logon', 'signin', 'sign-in',
  'auth', 'authn', 'sso', 'oauth', 'id', 'idp', 'identity', 'secure', 'checkout', 'pay',
  'payments', 'billing', 'bank', 'banking', 'mail', 'webmail', 'vault'
]);

export function hostLooksPrivate(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const labels = h.split('.');
  return labels.length >= 3 && PRIVATE_HOST_LABELS.has(labels[0]);
}

/**
 * Search-engine results pages. The query is in the address and the page is a
 * list of other people's snippets — a search history, not a page you read.
 * Kept out of the index by default, under the same switch as the built-in list.
 */
const SEARCH_PAGE_RE = new RegExp(
  '^https?://(?:[^/]*\\.)?(?:' + [
    'google\\.[a-z.]+/search', 'bing\\.com/search', 'duckduckgo\\.com/(?:\\?|html|lite)',
    'kagi\\.com/search', 'search\\.brave\\.com/search', 'ecosia\\.org/search',
    'startpage\\.com/(?:do|sp)/search', 'search\\.yahoo\\.com/search', 'yandex\\.[a-z]+/search',
    'baidu\\.com/s(?:\\?|$)', 'qwant\\.com/', 'you\\.com/search', 'perplexity\\.ai/search',
    'youtube\\.com/results'
  ].join('|') + ')', 'i');

export function isSearchResultsPage(url) {
  return SEARCH_PAGE_RE.test(String(url || ''));
}

/**
 * Addresses that carry a credential: a password or token in the query or the
 * fragment (OAuth puts access tokens in the fragment), an OAuth code, a
 * signed-link signature, a JWT, or a long opaque value under any name. Such a
 * page is never read and never kept, whatever list it is or is not on — the
 * address alone is the leak. Found in use: a registration form that put the
 * password in a GET query, and an insurer's "my details" page with a
 * 555-character token in the address.
 */
const SECRET_PARAMS = new Set([
  'password', 'passwd', 'pwd', 'pass', 'passcode', 'pin', 'otp', 'totp', 'mfa',
  'token', 'access_token', 'id_token', 'refresh_token', 'auth_token', 'authtoken', 'session_token',
  'auth', 'authorization', 'apikey', 'api_key', 'key', 'secret', 'client_secret',
  'session', 'sessionid', 'session_id', 'sid', 'phpsessid', 'jsessionid',
  'sig', 'signature', 'code', 'ticket', 'credential', 'credentials', 'jwt', 'bearer', 'nonce'
]);
const OPAQUE_VALUE_RE = /^[A-Za-z0-9_.~+/=-]{48,}$/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;

export function urlCarriesSecret(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return true;
  const carries = (params) => {
    for (const [k, v] of params) {
      if (SECRET_PARAMS.has(k.toLowerCase())) return true;
      if (JWT_RE.test(v)) return true;
      if (OPAQUE_VALUE_RE.test(v) && !/^\d+$/.test(v)) return true;
    }
    return false;
  };
  if (carries(u.searchParams)) return true;
  const frag = u.hash.slice(1).replace(/^[!/]+/, '');
  if (frag.includes('=')) {
    try { if (carries(new URLSearchParams(frag.split('?').pop()))) return true; } catch { /* not params */ }
  }
  return false;
}

/* ---------------------------------------------------------------- spaces */

/** A space is a named, emoji-tagged snapshot of a window's tabs. */
export function makeSpace({ name, emoji = '', tabs = [], groups = [] }) {
  const now = Date.now();
  return { id: uid(), name: name || 'New space', emoji, createdAt: now, updatedAt: now, tabs, groups };
}

/** First glyph only, so a pasted string can't blow up the row. */
export function cleanEmoji(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  return [...s][0] || '';
}

/* ------------------------------------------------------------ duplicates */

/**
 * Group open tabs that point at the same page.
 *
 * Pure, and shared by the service worker's `find-duplicates` and the footer's
 * live count — one definition of "the same page", so the number on the button
 * can never disagree with what the review sheet then offers to close.
 *
 * Comparison is canonical (see `normUrl`): tracking parameters ignored, query
 * order irrelevant, trailing slash trimmed. Pinned tabs are left out — they're
 * deliberate fixtures, not accidents.
 */
export function duplicateGroups(tabs) {
  const buckets = new Map();

  for (const t of (tabs || [])) {
    if (!t || t.pinned || !isSaveable(t.url)) continue;
    const key = normUrl(t.url);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }

  const groups = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.index - b.index);

    // Keeper preference: the active tab, else the cleanest URL (fewest tracking
    // parameters), else the leftmost. So a link opened from a newsletter loses
    // to the copy you already had open on the tidy URL.
    const keeper = list.find((t) => t.active) || list.slice().sort((a, b) => {
      const d = trackingParamsIn(a.url).length - trackingParamsIn(b.url).length;
      return d !== 0 ? d : a.index - b.index;
    })[0];

    groups.push({
      key,
      url: key, // the canonical form, so it's obvious what matched
      title: list[0].title || list[0].url,
      tabs: list.map((t) => ({
        id: t.id,
        title: t.title || t.url,
        url: t.url,
        active: !!t.active,
        index: t.index,
        tracked: trackingParamsIn(t.url),
        keep: t.id === keeper.id
      }))
    });
  }

  groups.sort((a, b) => b.tabs.length - a.tabs.length);
  return groups;
}

/** How many tabs Dedupe would actually close: every copy but the keeper. */
export function duplicateCount(tabs) {
  return duplicateGroups(tabs).reduce((n, g) => n + g.tabs.length - 1, 0);
}

/* ----------------------------------------------------------- scan policy */

/**
 * Which tabs a page-text read should open.
 *
 * Reading is one injection per tab and is query-independent — the text is kept
 * and searched locally — so this is not "who might match" but "who is readable
 * and not read yet". Three kinds of tab never enter the queue, for three
 * different reasons:
 *
 *   • excluded — by the never-read list, a private space, or the page itself
 *     (`isExcluded` returns the reason);
 *   • asleep   — frozen (Chrome froze it; nothing runs until you visit it —
 *     https://github.com/w3c/webextensions/issues/527) or discarded (unloaded;
 *     the wake path can reload it). Unless it was read before it slept, in
 *     which case it is simply searchable;
 *   • done     — already read, or refused/timed out and not retried until an
 *     explicit re-index.
 *
 * Kept pure so the frozen case is testable, which it isn't through a browser:
 * nothing an extension can do will freeze a tab on demand.
 */
export function planIndex(tabs, {
  exclude = new Set(),
  indexed = new Set(),
  failed = new Set(),
  isExcluded = () => null
} = {}) {
  const readable = (tabs || []).filter((t) =>
    t && /^https?:/i.test(t.url || '') && !exclude.has(t.id));

  const excluded = [];
  const eligible = [];
  for (const t of readable) {
    const why = isExcluded(t);
    if (why) excluded.push({ tab: t, why }); else eligible.push(t);
  }
  const sleeping = (t) => t.frozen === true || t.discarded === true;
  return {
    queue: eligible.filter((t) => !sleeping(t) && !indexed.has(t.id) && !failed.has(t.id)),
    asleep: eligible.filter((t) => sleeping(t) && !indexed.has(t.id)),
    excluded,
    searchable: eligible.filter((t) => indexed.has(t.id)).length
  };
}

/* ------------------------------------------------------------ appearance */

/**
 * How tab titles are drawn. Stored in `settings`, so it rides along with
 * export/import rather than being a separate thing to back up.
 */
export const APPEARANCE = {
  titleSize: 13,
  titleFont: 'system',
  customFont: '',
  wrapTitles: false
};

export const TITLE_SIZE_MIN = 11;
export const TITLE_SIZE_MAX = 18;

/** Stacks that need nothing installed beyond what the OS already ships. */
export const FONT_STACKS = {
  system: { label: 'System', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  sans: { label: 'Sans', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  serif: { label: 'Serif', stack: 'Georgia, "Times New Roman", Times, serif' },
  mono: { label: 'Mono', stack: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  custom: { label: 'Custom…', stack: '' }
};

/**
 * A font name typed by hand ends up inside a CSS property value, so strip the
 * characters that could end the declaration or start another one. Anything left
 * is quoted, which makes names with spaces work without further escaping.
 */
export function fontStackFor(settings = {}) {
  const key = settings.titleFont || APPEARANCE.titleFont;
  if (key !== 'custom') return (FONT_STACKS[key] || FONT_STACKS.system).stack;
  const name = String(settings.customFont || '').replace(/["';{}()<>\\]/g, '').trim();
  if (!name) return FONT_STACKS.system.stack;
  return `"${name}", ${FONT_STACKS.system.stack}`;
}

/** Clamp whatever is in storage into something drawable. */
export function readAppearance(settings = {}) {
  const size = Number(settings.titleSize);
  return {
    titleSize: Number.isFinite(size)
      ? Math.min(TITLE_SIZE_MAX, Math.max(TITLE_SIZE_MIN, Math.round(size)))
      : APPEARANCE.titleSize,
    titleFont: FONT_STACKS[settings.titleFont] ? settings.titleFont : APPEARANCE.titleFont,
    customFont: String(settings.customFont || ''),
    wrapTitles: !!settings.wrapTitles
  };
}

/* ------------------------------------------------------------ live spaces */

/**
 * A Space is a label on a tab, not a container of tabs.
 *
 * Switching a space changes what the panel draws and nothing else — no tab is
 * moved, closed, grouped or reloaded, so a switch costs zero browser calls and
 * cannot lose scroll position or form state. This is the one model that works
 * in Chromium: `tabs.hide()` is Firefox-only, and every alternative either
 * closes tabs (slow, lossy) or spends each tab's single native group on spaces,
 * which would collide with Rules.
 *
 * The cost is that membership has no durable home. Tab ids do not survive a
 * restart and Chromium has no `sessions.setTabValue`, so after every restart
 * membership is REBUILT by matching each space's saved URL list against the
 * tabs the browser restored. Hence `assignSpaces` below.
 */

/**
 * The space every tab starts in.
 *
 * It is a real space — first in the list, always present, never deletable —
 * rather than a bin for leftovers. On a fresh install everything is in it, and
 * you carve spaces out of it; a tab that ends up nowhere lands back here rather
 * than disappearing. The id is the historical 'unsorted' so that membership
 * written by an earlier build still resolves.
 */
export const MAIN = 'unsorted';
export const UNSORTED = MAIN;   // old name, kept so nothing has to be renamed at once
export const MAIN_DEFAULTS = { name: 'Main', emoji: '🏠' };

/**
 * A pinned tab shown in every space rather than just its own.
 *
 * Pinned tabs are per-space by default — that is the Arc behaviour and the one
 * people expect. Chromium permits it because a space here is a label, not a
 * group: the constraint that a pinned tab cannot belong to a native tab group
 * binds Rules, not Spaces. The browser's own strip still shows every pinned tab
 * from every space, which is unavoidable and doesn't matter if you live in the
 * panel.
 */
export const GLOBAL_PIN = '*';

export function makeLiveSpace({ name, emoji = '', id = '' }) {
  const now = Date.now();
  // An id may be supplied when recreating a space a snapshot referred to: the
  // tabs in that snapshot record the OLD id, so a fresh one would orphan every
  // one of them.
  return {
    id: id || uid(),
    name: name || 'New space',
    emoji,
    createdAt: now,
    updatedAt: now,
    manifest: []
  };
}

/**
 * Rebuild tab→space membership after a restart, from each space's saved URL
 * list and the order the browser restored tabs in.
 *
 * Chrome restores tab order faithfully, which is what makes this work. Three
 * rules, in order:
 *
 *   1. A URL claimed by exactly one space goes to that space.
 *   2. A URL claimed by several goes to the space of the tab immediately
 *      before it — runs of tabs from one space stay together, which is how a
 *      restored window actually looks.
 *   3. Anything unclaimed goes to Unsorted, never nowhere. A tab that belongs
 *      to no space would be invisible in every view, which is the one outcome
 *      worse than being in the wrong space.
 *
 * Pure, because it runs once per browser start and a mistake there is the
 * difference between "my tabs are organised" and "where did everything go".
 *
 * @param {{id:number,url:string,pinned?:boolean}[]} tabs   in tab-strip order
 * @param {{id:string,manifest:{url:string}[]}[]} spaces
 * @returns {{ byTab: Record<number,string>, matched: number, unsorted: number }}
 */
export function assignSpaces(tabs, spaces) {
  const claims = new Map(); // normalised url -> [spaceId]
  for (const sp of (spaces || [])) {
    for (const entry of (sp.manifest || [])) {
      const key = normUrl(entry && entry.url);
      if (!key) continue;
      if (!claims.has(key)) claims.set(key, []);
      const list = claims.get(key);
      if (!list.includes(sp.id)) list.push(sp.id);
    }
  }

  const byTab = {};
  let matched = 0;
  let unsorted = 0;
  let prev = null;

  for (const tab of (tabs || [])) {
    const owners = claims.get(normUrl(tab.url)) || [];
    let space;

    if (owners.length === 1) space = owners[0];
    else if (owners.length > 1) space = owners.includes(prev) ? prev : owners[0];

    if (space) matched++;
    else { space = UNSORTED; unsorted++; }

    byTab[tab.id] = space;
    // Pinned tabs sit in their own run at the head of the strip, so they say
    // nothing about which space the first unpinned tab belongs to.
    if (!tab.pinned) prev = space;
  }

  return { byTab, matched, unsorted };
}

/**
 * Group tabs the way the Rules pass should: one native group per (rule, space).
 *
 * A tab belongs to exactly one native group, so a single "Travel" group shared
 * across spaces would put every space's Travel tabs in one collapsible unit and
 * make the collapse state global. Chromium allows two groups to carry the same
 * title and colour — group identity is an opaque token, the title is not a key
 * — so each space gets its own.
 *
 * Which existing group belongs to which space is derived, not stored: a group
 * is owned by the space of its first member. A group whose members straddle two
 * spaces therefore sheds the strangers on the next pass, which is what should
 * happen after a tab is moved between spaces.
 *
 * @returns {{ key:string, ruleName:string, spaceId:string, groupId:number|null, tabIds:number[] }[]}
 */
export function planRuleGroups(tabs, rules, spaceOf, groups) {
  const active = activeRules(rules).filter(ruleGroups);
  if (!active.length) return [];

  const compiled = active.map((r) => ({ rule: r, pats: compileRule(r) }));
  const managed = new Set(active.map((r) => (r.name || '').toLowerCase()));
  const byId = new Map((groups || []).map((g) => [g.id, g]));

  // Owner of each group: the space of its first member in tab order.
  const owner = new Map();
  for (const t of tabs) {
    if (t.groupId === undefined || t.groupId === NONE) continue;
    if (!owner.has(t.groupId)) owner.set(t.groupId, spaceOf[t.id] || UNSORTED);
  }

  const wanted = new Map();
  for (const t of tabs) {
    if (t.pinned || !isSaveable(t.url)) continue;
    const hit = compiled.find((c) => ruleMatches(c.pats, t.url, t.title));
    if (!hit) continue;

    const space = spaceOf[t.id] || UNSORTED;
    const name = hit.rule.name || 'Group';
    const current = t.groupId !== undefined && t.groupId !== NONE ? byId.get(t.groupId) : null;
    const currentTitle = (current && current.title ? current.title : '').toLowerCase();

    // Already in the right group: right name AND right space.
    if (current && currentTitle === name.toLowerCase() && owner.get(t.groupId) === space) continue;
    // In a group the user made by hand — leave it alone.
    if (current && !managed.has(currentTitle)) continue;

    const key = `${name.toLowerCase()}\u0000${space}`;
    if (!wanted.has(key)) {
      // Reuse the existing group for this (rule, space) pair if there is one.
      const existing = (groups || []).find((g) =>
        (g.title || '').toLowerCase() === name.toLowerCase() && owner.get(g.id) === space);
      wanted.set(key, {
        key,
        ruleName: name,
        spaceId: space,
        color: hit.rule.color || 'grey',
        groupId: existing ? existing.id : null,
        tabIds: []
      });
    }
    wanted.get(key).tabIds.push(t.id);
  }

  return [...wanted.values()];
}

/* ----------------------------------------------------- rules that clash */

/**
 * Find pairs of rules that are fighting over the same tabs.
 *
 * Order already decides the outcome — both `planRuleGroups` and `planFiling`
 * take the first matching rule — so nothing here is ambiguous to the machine.
 * It is ambiguous to the person: two rules mentioning github.com, one grouping
 * as "Work" and one as "Code", produce a result neither of them describes on
 * its own, and there is nothing on screen to say why.
 *
 * Two rules only clash when they want the same action to come out *differently*.
 * A grouping rule and a filing rule matching the same tab are not in conflict —
 * that is the whole point of a rule having two independent actions, and the tab
 * gets both.
 *
 * Detected against the tabs you actually have open rather than by comparing
 * patterns: deciding whether two regexes can match the same string is not
 * something to guess at, and a clash you cannot currently observe is not worth
 * a warning.
 *
 * @returns {{winner:string, loser:string, kind:'group'|'space', tabIds:number[]}[]}
 *   `winner` is the rule that takes effect — the one earlier in the list.
 */
export function ruleConflicts(rules, tabs) {
  const active = activeRules(rules);
  if (active.length < 2) return [];

  const compiled = active.map((r) => ({ r, pats: compileRule(r) }));
  const KINDS = [
    { kind: 'group', plays: ruleGroups, value: (r) => (r.name || '').trim().toLowerCase() },
    { kind: 'space', plays: ruleFiles, value: (r) => r.spaceId }
  ];

  const found = new Map();
  for (const t of tabs || []) {
    if (!t || t.pinned || !isSaveable(t.url)) continue;
    const hits = compiled.filter((c) => ruleMatches(c.pats, t.url, t.title)).map((c) => c.r);
    if (hits.length < 2) continue;

    for (const { kind, plays, value } of KINDS) {
      const players = hits.filter(plays);
      if (players.length < 2) continue;
      const winner = players[0];
      for (const loser of players.slice(1)) {
        if (value(loser) === value(winner)) continue;   // same outcome — agreement, not conflict
        const key = `${winner.id}\u0000${loser.id}\u0000${kind}`;
        if (!found.has(key)) {
          found.set(key, { winner: winner.id, loser: loser.id, kind, tabIds: [] });
        }
        found.get(key).tabIds.push(t.id);
      }
    }
  }
  return [...found.values()];
}

/* ------------------------------------------------------ filing by rule */

/**
 * Which tabs a rule set wants to move into a different space.
 *
 * Deliberately narrow. Filing is destructive in a way grouping isn't — it takes
 * a tab out of the list you are looking at — so this refuses in four cases:
 *
 *   • a tab you placed by hand (`pinned` here means "space-pinned", not the
 *     browser's pinned strip): your decision outranks a pattern, always;
 *   • the tab you are looking at (`skip`): the panel follows the active tab, so
 *     filing it would yank the whole panel into another space mid-sentence;
 *   • browser-pinned tabs, which are meant to stay put;
 *   • a rule pointing at a space that no longer exists.
 *
 * Called both at event time (one tab, just navigated) and for the manual
 * "File open tabs" sweep — the difference is entirely in what the caller
 * passes as `skip`.
 *
 * @param {chrome.tabs.Tab[]} tabs
 * @param {object[]} rules
 * @param {Record<number,string>} spaceOf   tabId -> spaceId
 * @param {object} [opts]
 * @param {Record<number,boolean>} [opts.pinned]  tabs placed by hand
 * @param {Iterable<number>} [opts.skip]          tabs to leave alone
 * @param {Iterable<string>} [opts.spaceIds]      spaces that exist (Main is implicit)
 * @returns {Record<number,string>} tabId -> new spaceId, changes only
 */
export function planFiling(tabs, rules, spaceOf = {}, opts = {}) {
  const active = activeRules(rules).filter(ruleFiles);
  if (!active.length) return {};

  const compiled = active.map((r) => ({ rule: r, pats: compileRule(r) }));
  const pinned = opts.pinned || {};
  const skip = opts.skip instanceof Set ? opts.skip : new Set(opts.skip || []);
  const known = opts.spaceIds ? new Set([...opts.spaceIds, MAIN]) : null;

  const out = {};
  for (const t of tabs || []) {
    if (!t || t.pinned || pinned[t.id] || skip.has(t.id)) continue;
    if (!isSaveable(t.url)) continue;

    const hit = compiled.find((c) => ruleMatches(c.pats, t.url, t.title));
    if (!hit) continue;

    const want = hit.rule.spaceId;
    if (known && !known.has(want)) continue;            // rule points at a deleted space
    const now = spaceOf[t.id] || MAIN;
    if (now === want || now === GLOBAL_PIN) continue;   // already there, or rides along everywhere
    out[t.id] = want;
  }
  return out;
}

/* --------------------------------------------- which space is a window? */

/*
 * A note on what this is and isn't. Spaces don't switch — opening one never
 * closes anything. But a window opened *from* a space is still worth
 * remembering, for two reasons: so the panel can tell you which space you're
 * looking at, and so clicking that space again goes to the window it's already
 * in rather than opening a second copy.
 *
 * It lives in `chrome.storage.session`, so it's forgotten on browser restart —
 * which is correct, because the window ids it refers to are too.
 */

export const SPACE_KEY = 'activeSpace:';

export async function getActiveSpace(windowId) {
  try {
    const k = SPACE_KEY + windowId;
    return (await chrome.storage.session.get(k))[k] || null;
  } catch {
    return null;
  }
}

export async function setActiveSpace(windowId, spaceId) {
  try {
    const k = SPACE_KEY + windowId;
    if (spaceId) await chrome.storage.session.set({ [k]: spaceId });
    else await chrome.storage.session.remove(k);
  } catch { /* session storage is best-effort */ }
}

/* ------------------------------------------------- in-page preview card */

/**
 * Which edge of the browser window is the side panel docked on?
 *
 * There is no API for this, and screen coordinates can't be compared to find
 * out: Chrome reports `window.screenX` as the *browser window's* left edge for
 * both the panel and the page, so the two are equal whichever side the panel is
 * on. What is reliable is a mouse event's screenX, which comes from the OS
 * event itself. The cursor is over the panel when a row is hovered, so the
 * question becomes: which panel-width slice of the window is it in?
 *
 * @param {{cursorScreenX:number, windowLeft:number, windowWidth:number, panelWidth:number}} m
 * @returns {'left'|'right'}
 */
export function dockSide({ cursorScreenX, windowLeft, windowWidth, panelWidth }) {
  const w = Number(windowWidth) || 0;
  const panel = Number(panelWidth) || 360;
  if (!w || !Number.isFinite(cursorScreenX) || !Number.isFinite(windowLeft)) return 'right';

  const x = cursorScreenX - windowLeft;          // cursor, within the window
  const slack = 24;                              // window border and shadow
  const nearLeft = x <= panel + slack;
  const nearRight = x >= w - panel - slack;

  if (nearLeft && !nearRight) return 'left';
  if (nearRight && !nearLeft) return 'right';
  return x < w / 2 ? 'left' : 'right';           // panel wider than half a window
}

/**
 * Injected into the ACTIVE tab to draw the hover preview beside the side panel.
 *
 * A side panel cannot paint outside its own frame — no z-index or fixed
 * positioning escapes it — so the only way to show a card next to the panel is
 * to render it in the page. Everything lives in a shadow root so page CSS can't
 * reach it, it ignores pointer events, and it removes itself on any page
 * interaction or after a timeout, so a stale card can't be left behind.
 *
 * Pass null to remove. Returns true if it did something.
 */
export function PAGE_CARD(payload) {
  const ID = '__siderail_preview_host__';
  const existing = document.getElementById(ID);

  if (!payload) {
    if (existing) existing.remove();
    return true;
  }
  if (!document.body && !document.documentElement) return false;

  // A CLOSED shadow root, and this is not cosmetic. The card carries another
  // tab's title, host and group, and — when one has been captured — a
  // screenshot of it, and it is drawn into whichever page is in front. With an
  // open root that page can read `host.shadowRoot` and see all of it: hover a
  // banking tab while a hostile page is active and the hostile page has the
  // banking tab's screenshot. Closed, `element.shadowRoot` is null to the page.
  // The reference is kept on an expando, which lives in this isolated world
  // and is invisible to the page's own scripts.
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  let host = existing;
  let root = host ? host.__srRoot : null;
  if (host && !root) { host.remove(); host = null; }   // not ours, or the root is lost
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    root = host.attachShadow({ mode: 'closed' });
    host.__srRoot = root;
    (document.documentElement || document.body).appendChild(host);
  }

  // Only a data URL of the two types we produce goes into a src attribute.
  const thumb = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(payload.thumb || '')
    ? payload.thumb : '';

  // Which edge to hug. The panel works this out and tells us, because nothing
  // in the page can: Chrome reports `window.screenX` as the *browser window's*
  // left for both the page and the panel, whichever side the panel is docked
  // on, so comparing them always said "right" and pinned the card to the far
  // edge of the screen.
  const onLeft = payload.side === 'left';

  host.setAttribute('style', [
    'all: initial',
    'position: fixed',
    'z-index: 2147483647',
    'pointer-events: none',
    onLeft ? 'left: 10px' : 'right: 10px',
    onLeft ? 'right: auto' : 'left: auto',
    'top: 0px'
  ].join(';'));

  const chips = (payload.chips || [])
    .map((c) => `<span class="chip">${esc(c)}</span>`).join('');

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        width: 320px;
        font: 13px/1.4 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
        color: #1b1d21; background: #fff;
        border: 1px solid rgba(0,0,0,.14); border-radius: 10px;
        box-shadow: 0 14px 40px rgba(0,0,0,.28);
        overflow: hidden;
      }
      @media (prefers-color-scheme: dark) {
        .card { color: #e8eaed; background: #1b1d21; border-color: rgba(255,255,255,.14); }
        .sub { color: #9aa1ab !important; }
        .none { background: #232629 !important; color: #6b7280 !important; }
        .chip { color: #9aa1ab !important; background: #232629 !important;
                border-color: rgba(255,255,255,.12) !important; }
      }
      .shot { display:block; width:100%; aspect-ratio:16/10; object-fit:cover;
              object-position:top center; background:#f4f5f7; }
      .none { display:grid; place-items:center; width:100%; aspect-ratio:16/10;
              background:#f4f5f7; color:#9aa1ab; font-size:12px; text-align:center;
              padding:0 20px; line-height:1.5; box-sizing:border-box; }
      .body { padding: 10px 12px 12px; }
      .ttl { font-size:13px; font-weight:600; line-height:1.35;
             display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;
             overflow:hidden; margin:0 0 4px; }
      .sub { font-size:11.5px; color:#6b7280; }
      .chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:8px; }
      .chip { padding:1px 7px; border-radius:999px; font-size:10.5px; font-weight:600;
              color:#6b7280; background:#f4f5f7; border:1px solid rgba(0,0,0,.08); }
    </style>
    <div class="card">
      ${thumb
        ? `<img class="shot" src="${thumb}" alt="">`
        : `<div class="none">${esc(payload.noShot || 'No preview yet')}</div>`}
      <div class="body">
        <p class="ttl">${esc(payload.title)}</p>
        <div class="sub">${esc(payload.host)}</div>
        ${chips ? `<div class="chips">${chips}</div>` : ''}
      </div>
    </div>`;

  // Align with the hovered row, clamped to the viewport. `anchorY` is measured
  // from the top of the browser window frame; the page's own viewport starts
  // below the tab strip and toolbar, and outer-minus-inner height is that gap.
  requestAnimationFrame(() => {
    const h = root.querySelector('.card').getBoundingClientRect().height || 260;
    const chromeH = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0));
    const wanted = Number.isFinite(payload.anchorY) ? payload.anchorY - chromeH : 10;
    const top = Math.max(10, Math.min(wanted, window.innerHeight - h - 10));
    host.style.top = `${Math.round(top)}px`;
  });

  // Never leave one stranded.
  const kill = () => { const n = document.getElementById(ID); if (n) n.remove(); };
  clearTimeout(host.__srTimer);
  host.__srTimer = setTimeout(kill, 6000);
  if (!host.__srBound) {
    host.__srBound = true;
    ['pointerdown', 'wheel', 'keydown'].forEach((ev) =>
      window.addEventListener(ev, kill, { capture: true, once: true, passive: true }));
  }
  return true;
}

/* ------------------------------------------------- membership storage

 * One key per tab, not one key for everything.
 *
 * Membership used to live in a single `spaceOf` object. Both the panel and the
 * service worker read it, changed it and wrote the whole thing back — and there
 * is no atomic read-modify-write in chrome.storage. The worker's filing pass
 * runs on every tab creation and every navigation, so any placement the panel
 * wrote between that pass's read and its write was silently deleted. That is
 * why a tab opened in one space appeared in Main, and why a pinned tab kept
 * drifting back: not one bug, but a race that fired constantly.
 *
 * Per-tab keys remove the class entirely. Two writers touching different tabs
 * never collide, because they are no longer writing the same key. Nothing here
 * ever writes a whole map, so nothing can erase a placement it didn't know
 * about.
 */

export const SP = 'sp:';    // sp:<tabId>  -> spaceId
export const SPH = 'sph:';  // sph:<tabId> -> 1 when placed by hand

/**
 * Read the whole membership map, migrating the legacy single-object form the
 * first time it is seen.
 */
export async function readMembership(tabIds = null) {
  // `get(null)` deserialises EVERYTHING in storage.session — and that area
  // also holds up to ~4.5MB of base64 thumbnails. Every rules pass, which runs
  // on every tab creation and navigation, was paying to decode fifty
  // screenshots in order to read a few hundred bytes of membership. Callers
  // that know which tabs exist pass their ids and only those keys are fetched;
  // the whole-area form remains for the two callers that genuinely need to
  // enumerate (pruning stale keys, and diagnostics).
  let all = {};
  try {
    if (tabIds) {
      const keys = ['spaceOf', 'spacePinned'];      // legacy shape, migrated below
      for (const id of tabIds) keys.push(SP + id, SPH + id);
      all = await chrome.storage.session.get(keys);
    } else {
      all = await chrome.storage.session.get(null);
    }
  } catch { return { spaceOf: {}, spacePinned: {} }; }

  const spaceOf = {};
  const spacePinned = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(SP)) spaceOf[k.slice(SP.length)] = v;
    else if (k.startsWith(SPH)) spacePinned[k.slice(SPH.length)] = true;
  }

  // Legacy shape. Fold it in — without overwriting anything already migrated —
  // and retire it.
  if (all.spaceOf || all.spacePinned) {
    for (const [id, v] of Object.entries(all.spaceOf || {})) {
      if (spaceOf[id] === undefined) spaceOf[id] = v;
    }
    for (const [id, v] of Object.entries(all.spacePinned || {})) {
      if (v && spacePinned[id] === undefined) spacePinned[id] = true;
    }
    await writeMembership(spaceOf, spacePinned).catch(() => {});
    await chrome.storage.session.remove(['spaceOf', 'spacePinned']).catch(() => {});
  }

  return { spaceOf, spacePinned };
}

/** Write only the tabs named. Never removes a key it wasn't given. */
export async function writeMembership(spaceOf = {}, spacePinned = null) {
  const patch = {};
  for (const [id, v] of Object.entries(spaceOf)) if (v) patch[SP + id] = v;
  if (spacePinned) {
    for (const [id, v] of Object.entries(spacePinned)) if (v) patch[SPH + id] = 1;
  }
  if (!Object.keys(patch).length) return;
  await chrome.storage.session.set(patch).catch(() => {});
}

/** Forget these tabs entirely. */
export async function dropMembership(tabIds) {
  const keys = [];
  for (const id of tabIds || []) keys.push(SP + id, SPH + id);
  if (keys.length) await chrome.storage.session.remove(keys).catch(() => {});
}

/**
 * Remove placements for tabs that no longer exist.
 *
 * Per-tab keys don't tidy themselves the way replacing a whole map did, so this
 * runs at boot. Chrome reuses tab ids across restarts, and a stale key would
 * hand a brand-new tab someone else's space.
 */
export async function pruneMembership(liveIds) {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  let all = {};
  try { all = await chrome.storage.session.get(null); } catch { return 0; }
  const dead = Object.keys(all).filter((k) =>
    (k.startsWith(SP) || k.startsWith(SPH)) &&
    !live.has(Number(k.slice(k.indexOf(':') + 1))));
  if (dead.length) await chrome.storage.session.remove(dead).catch(() => {});
  return dead.length;
}

/** Does a storage.onChanged batch touch membership? */
export function membershipChanges(changes) {
  const spaceOf = {};
  const gone = [];
  let any = false;
  for (const [k, c] of Object.entries(changes || {})) {
    if (!k.startsWith(SP) && !k.startsWith(SPH)) continue;
    any = true;
    const id = k.slice(k.indexOf(':') + 1);
    if (k.startsWith(SP)) {
      if (c.newValue === undefined) gone.push(id); else spaceOf[id] = c.newValue;
    }
  }
  return { any, spaceOf, gone };
}

/* ------------------------------------------------------------ redaction */

/**
 * Luhn check — every payment card number passes it, and one random 16-digit
 * string in ten does, which is the false-positive rate accepted below.
 */
export function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g;
const SORT_RE = /\b\d{2}[- ]\d{2}[- ]\d{2}[ ,]*(?:a\/c|account|acct)?[ :]*\d{8}\b/gi;
// UK National Insurance: two letters (not D, F, I, Q, U, V; second also not O),
// six digits, suffix A–D. US Social Security: 3-2-4 with the invalid ranges out,
// which also keeps 3-3-4 phone numbers clear of it.
const NI_RE = /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g;
const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

/**
 * Strip what must never sit in an index even if a page slipped past every
 * exclusion: Luhn-valid card numbers (13–19 digits, spaces or dashes allowed),
 * IBANs, UK sort-code-and-account pairs, UK National Insurance numbers and US
 * Social Security numbers. Applied before anything is held, even in memory.
 * Cheap on an ordinary page; the difference between an embarrassing index
 * and a dangerous one on the page that got through.
 */
export function redact(text) {
  if (!text) return text || '';
  return String(text)
    .replace(CARD_RE, (m) => (luhnValid(m.replace(/[ -]/g, '')) ? '[card redacted]' : m))
    .replace(IBAN_RE, (m) => (m.replace(/[ -]/g, '').length >= 15 && /\d{2}/.test(m.slice(2, 4)) ? '[iban redacted]' : m))
    .replace(SORT_RE, '[account redacted]')
    .replace(NI_RE, '[ni redacted]')
    .replace(SSN_RE, '[ssn redacted]');
}

/** 32-bit FNV-1a, as hex. Enough to tell "the page changed" from "it didn't". */
export function textHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/* -------------------------------------------------- the old page index store
 *
 * Versions 0.23.0 to 0.25.0 kept what page-text search had read in an
 * IndexedDB database ('siderail-index') so a closed page could be found again.
 * 0.26.0 removed that: the text of a page lives only in the panel's memory
 * while the panel is open, and is never written anywhere. This is the one
 * IndexedDB call left in the shipped code — test/lint.js fails the build if
 * another appears. It deletes the old database on the first run after the
 * update and is harmless after that.
 */
export function removeOldIndexStore() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(false); return; }
      const req = indexedDB.deleteDatabase('siderail-index');
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch { resolve(false); }
  });
}
