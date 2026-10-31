# SideRail

SideRail is a Chrome extension that shows your tabs as a vertical list in the browser's side
panel, and helps you keep them in order. I built it for myself: I usually have far more tabs
open than Chrome or Helium's tab strip can cope with, and somewhere along the way I stopped looking at
the tab strip at all. It's free and open source, and I'm sharing it in case it's useful to
anyone else.

The short version: your tabs sit down the side of the window with their full titles, grouped
and sorted the way you want them, and a search box finds any open tab by its title, its
address or (if you allow it) the words on the page. Everything it knows stays on your
computer.

![SideRail docked on the left of a Chrome window: the Home space, with YouTube and Shopping groups made by rules](docs/screenshots/hero.png)

---

## What it does

- **Vertical tabs.** Every tab in the window in one list, with its full title. Drag to
  reorder, right-click to pin, mute, suspend or close, and hover for a preview card (with a
  thumbnail, once you've given SideRail access to pages).
- **Tab groups.** Chrome's own tab groups appear as collapsible sections, with a row of
  shortcuts at the top so you can jump straight to one. A single command gathers every loose
  tab in the window into groups by site.
- **Spaces.** Work, Home, a project, a holiday. A space is a label on a tab rather than a
  separate window, so switching between spaces is instant: nothing closes and nothing
  reloads.
- **Rules.** "Anything on github.com goes into a Code group, in my Work space." You write a
  rule once and SideRail files matching tabs as you browse.
- **Search.** Find an open tab by its title or address as you type, and by the text on the
  page if you let SideRail read pages. Your bookmarks and history can be included too, if you
  allow it. Only tabs that are open now are searched; nothing is kept once a tab closes.
- **Command palette.** One list for jumping to any tab, space or command.
- **Rewind.** A snapshot of your windows every five minutes (the last 50 are kept), so a
  crash or an accidentally closed window costs you very little. A snapshot always restores
  into a new window, so it can't overwrite what you have open.
- **Odds and ends.** A duplicate-tab finder that shows you what it would close before it
  closes anything, a clean reader view of most pages (using
  [Defuddle](https://github.com/kepano/defuddle)), and a one-click jump to an archived copy
  on archive.is.

---

## Privacy

A tab manager can see everything you have open, which is a lot to hand over to someone else's
software. So I've tried to make SideRail easy to check, rather than something you have to
take on trust:

- **It makes no network connections of its own.** No analytics, no telemetry, no update
  check. The test suite fails the build if any shipped file tries to open one. The only
  requests SideRail can cause are tabs you ask it to open.
- **It asks for no access to web pages when you install it,** and never leaves a script
  running in your pages. Searching page text, hover thumbnails and the reader view need to
  read pages, so Chrome asks you once, the first time you use one of them. A button in
  SideRail's settings takes the permission back.
- **Page text is never stored.** What SideRail reads from a page is held in memory while the
  panel is open, and is never written to disk. Card numbers, bank details, National Insurance
  and Social Security numbers are stripped out even from that.
- **Some pages are never read at all.** Banks, card issuers, insurers, webmail, messaging,
  health services, password managers and some 18,000 other sites are on a built-in list.
  Sign-in pages, search results and any address carrying a password or token are skipped too,
  and you can add your own sites or mark a whole space as private.
- **Nothing syncs.** Your spaces, rules and snapshots stay in this browser profile, in
  storage that no website or other extension can read.
- **You can read all of it.** About 7,700 lines of plain JavaScript with no build step, plus
  one pinned library for the reader view. [PRIVACY.md](PRIVACY.md) sets out exactly what is
  kept and where.
- **It doesn't look at your other extensions** (no `management` permission) and doesn't
  touch the security headers of pages you visit (no `declarativeNetRequest`).

It's open source under the Apache License 2.0, and it lives here on GitHub rather than in the
Chrome Web Store. That means you install it by hand (it takes a couple of minutes; see
[Install](#install)) and it never updates itself. I think that's the right trade-off for
something with this much access to your browser: nothing about it changes unless you choose
to update. It runs in Chrome and in other Chromium-based browsers, including Brave, Edge,
Vivaldi and Helium (which is what I use).

### Permissions, in full

```
tabs        read and manage the tab strip — the whole point
tabGroups   read and manage Chrome's native tab groups
sidePanel   render the panel
storage     save workspaces and snapshots to chrome.storage.local
alarms      fire the 5-minute snapshot timer
```

Optional, off until you ask for a feature that needs them:

```
bookmarks   search bookmarks from the command palette
history     search history from the command palette
scripting   \  page-text search and Defuddle — one prompt, all sites,
<all_urls>  /  revocable from inside the panel
```

There is no `host_permissions` key and no `content_scripts` key in the manifest — page
access is optional-only, and there are no persistent injected scripts even after you
grant it. The extension itself makes no network requests; the only ones it can cause are
tabs you asked it to open (the DuckDuckGo "search the web" fallback — change `WEB_SEARCH`
at the top of `sidepanel.js` — and archive.is).

Everything is stored by the extension on this computer. Nothing syncs, nothing is transmitted.

---

## Install

I've not yet deployed Siderail to the Chrome Store (but am intending to). Until then SideRail is installed manually from Github.

1. Download the latest `SideRail-<version>.zip` from the
   [releases page](https://github.com/RobinLandy/SideRail/releases) and unzip it somewhere
   permanent — the browser loads the extension from this folder every launch, so not
   Downloads. `~/SideRail` is fine. A git clone of this repository works the same way.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin SideRail to the toolbar. Click the icon to toggle the panel.

### Updating

SideRail never checks for new versions. To hear about them, choose **Watch → Custom →
Releases** on the repository, or look at Settings → About → Releases now and then. To update:

1. Download the new zip and unzip it.
2. Replace the **contents** of your SideRail folder with the new files.
3. On `chrome://extensions`, press the reload arrow on SideRail's card.

Your spaces, rules, snapshots and settings are stored by the browser against the extension's
identity, not in the folder, so they survive an update.
That identity is fixed by the `key` in the manifest: every copy of SideRail has the same
extension id, so you can even move the folder or load a fresh copy from a new one and the
data is still there. From a git checkout, `git pull` and the reload arrow do the same job.

The one thing not to do is press **Remove** first. Removing an extension deletes its data —
spaces, rules and snapshots — and the fixed `key` means
you never need to: **Load unpacked** from a new folder, or from a folder you have moved,
replaces the old registration in place and keeps the data. A copy loaded after Remove starts
empty.

### The developer-mode warning

Chrome shows a "Disable developer mode extensions" bubble on startup when unpacked
extensions are loaded. It is cosmetic — dismiss it and the extension keeps working. It is
the price of an extension that cannot silently update itself, which is rather the point.
Some Chromium-based browsers do not show it.

There is a permanent fix for anyone who wants one: pack the extension as a `.crx`, host an
update manifest, and allowlist the extension id through a managed-preferences policy. It
needs administrator rights and somewhere to host one XML file, so it is not the default.

---

## Shortcuts

| Key | macOS | Does |
|---|---|---|
| `Alt+B` | `⌘⇧B` | Open the panel |
| `Alt+G` | `⌘⇧G` | Group ungrouped tabs by domain |
| `Alt+Shift+G` | — | Ungroup everything |

These work from any page, and **Chrome does not let an extension set them** — there is no
API, deliberately, so a page can't steal a key from under you. Settings → Keyboard shows
the live bindings and takes you to `chrome://extensions/shortcuts`, which is the only place
they can be changed. Chrome also allows **at most four** suggested shortcuts per extension
— a fifth stops it loading at all — so *Ungroup everything* has no macOS default; bind it
there if you want it.

**There is no shortcut for the command palette, on purpose.** Chrome does not let an
extension move keyboard focus into its own side panel, so a browser-wide chord opened the
box and then sent your typing to the page behind it. An in-panel key worked, but only once
you had already clicked into the panel — by which point clicking is the same gesture. Both
were removed in 0.21.0. The palette opens from the **›** button beside the search box.

### In the panel

- **Click** a tab to switch to it
- **Cmd/Ctrl+click** to multi-select, **Shift+click** for a range
- **Middle-click** or the `×` to close
- **Right-click** for pin, mute, suspend, duplicate, copy URL, move to new window, close others/below
- **Drag** to reorder — dragging a selected tab moves the whole selection
- **Click a group header** to collapse it; right-click it to rename, ungroup or close the
  group. **Renaming a group that a rule created renames the rule too** — renaming only the
  group would be undone by the next rules pass, which would rebuild the old group and take
  those tabs back. The jump-bar position follows the new name
- `Esc` clears the search box, then the selection
- The **›** button beside the search box opens the command palette, carrying whatever you
  have already typed

---

## Page actions — Defuddle and archive.is

The footer buttons (and the right-click menu on any tab) offer:

- **Defuddle** — runs [Defuddle](https://github.com/kepano/defuddle) on the
  tab and replaces it with a clean reader view: article text, title, byline, images and
  code blocks, with the navigation, sidebars and footers stripped. A **Restore original**
  button sits at the top; reloading also puts everything back.
- **archive.is** — reloads the tab at `https://archive.is/<current url>`.

Both grey out on a page they can't act on — an internal page, or the new-tab page — rather
than disappearing.

Defuddle needs to run code inside the page, so it uses **the same one-time page-access
grant as page-text search** — you're asked once, never per site, and the "Revoke page
access" button drops it again. archive.is needs no permission at all.

### Keeping Defuddle current

**Manifest V3 forbids remotely-hosted code.** An extension may only execute JavaScript
shipped inside its own package, so there is no legitimate way to pull a newer Defuddle at
runtime — and, given why this extension exists, silently loading fresh third-party code is
exactly the risk we designed out in the first place. Auto-updating the library is neither
possible nor desirable here.

So: the bundle is **pinned and vendored** at `vendor/defuddle.js`, with its provenance
recorded in `vendor/defuddle-version.json` and the version shown in Settings → About.
Updating is one deliberate command:

```bash
node tools/update-defuddle.mjs           # check only — prints vendored vs latest
node tools/update-defuddle.mjs --apply   # vendor it and bump the extension version
```

`--apply` fetches the tarball from npm, replaces the bundle, records the new version, and
bumps SideRail's patch version so the build is distinguishable. Then run `node test/e2e.js`
and reload at `chrome://extensions`. The check-only mode touches the npm registry for a
version *string* — metadata, not code — and only when you run it by hand; the extension
itself never makes that request.

Defuddle is MIT-licensed and releases are at
<https://github.com/kepano/defuddle/releases>.

## Rules — automatic filing and tab groups

<p><img src="docs/screenshots/rules.png" width="374" alt="The Rules screen: when rules run, and the YouTube rule with its pattern"></p>

A rule is **a match plus up to two actions**: file matching tabs into a space, and put them
in a named tab group. Either can be left blank, and setting both is the normal case —
"YouTube goes to Entertainment, inside a YouTube group" is one rule, not two competing
ones.

Give it a name, a colour and a list of patterns, and every booking.com / easyjet.com /
expedia.com tab lands in **Travel** as you browse — and, if you point the space menu at
one, inside your **Trips** space as well.

Patterns, one per line:

| You type | It matches |
|---|---|
| `booking.com` | the site and its subdomains — `www.`, `secure.` — but **not** `elsewhere.com/?ref=booking.com` or `notbooking.com` |
| `jira` | anywhere in the URL (no dot, so it reads as a keyword) |
| `/trips/` | anywhere in the URL (contains a slash) |
| `*.expedia.*` | glob, `*` is a wildcard |
| `/^https:\/\/(www\.)?airbnb\./i` | regular expression |
| `title:SideRail` | the tab's **title** rather than its URL |
| `title:/^Inbox/i` | regex against the title |
| `url:github.com` | the URL, said explicitly — the default, so only ever for clarity |

A bare pattern reads the URL. One rule can mix fields (`title:invoice` alongside
`stripe.com`); patterns are OR-ed. The one asymmetry is deliberate: `booking.com` matches
the *host* of a URL, but a title has no host, so on a title the same text is matched
literally.

### When two rules want the same tab

**The rule higher in the list wins**, and each card has ↑ / ↓ to decide which that is. If
two rules are fighting over tabs you actually have open, the losing one says so on its
card — naming the rule beating it, how many tabs it's losing, and offering a *Put this
rule first* button.

Only real clashes are flagged. Two rules that would do the same thing agree rather than
conflict, and a rule that groups and a rule that files are not in competition at all: the
tab gets both, which is the point of a rule having two independent actions.

### Deleting a rule

A rule's tab groups are ordinary Chrome groups and don't vanish on their own, so deleting
a rule that currently holds tabs asks whether to **ungroup them too** or **keep the
groups**. Ungrouping closes nothing. Unticking *Group them in the tab strip* does the same
thing — it takes the existing groups apart rather than just declining to make new ones.

### Filing into spaces

Filing runs **on events, not on a schedule** — when a tab opens, when it navigates, and
when it first gets a title after navigating. A tab that has settled somewhere is never
re-examined. Two things are never filed:

- **The tab you're looking at.** The panel follows the active tab, so filing it would drag
  the panel into another space while you were still reading. It waits until you move on.
- **Anything you placed by hand.** Moving a tab into a space yourself pins that decision;
  no rule overrides it. (Deleting a space releases its tabs, and clears the filing action
  from any rule pointing at it.)

Rules only fire on events, so tabs that were already open when you wrote the rule need one
sweep: **"Run rules now"**, in Manage SideRail → Rules. It files *and* groups every tab in
the window including the active one — you asked for it — and the panel follows that tab
across. It is the only button of its kind: until 0.21.0 there were three, and the
differences between them were invisible from their labels.

Each rule card shows a live **"Matches N open tabs"** count you can expand to see
exactly which tabs it's catching before you commit — click any of them to jump
there. Colour is a click on the swatch — the change is pushed to the live Chrome tab group
straight away, and the jump-bar square recolours with it, even when no tabs need moving.
Toggle a rule off without deleting it.

The rule pass is deliberately conservative: it only moves tabs that are
ungrouped, or that are sitting in a group belonging to a *different* rule. **A tab
group you named by hand is never touched.** Applying twice in a row is a no-op,
which is what makes the automatic mode safe.

"Sort automatically as I browse" applies rules — both actions — when a tab opens,
navigates, or first gets a title.
Turn it off and use "Run rules now" by hand. Right-click any tab for
**New rule for &lt;domain&gt;**, or right-click a group header for **Make a rule from
this group** to turn an existing group into a permanent one.

## Searching

Type in the search box and the list narrows to tabs whose title or address matches, as you
type. Every word has to match, so adding words narrows the list, and initials work too (`gd`
finds Google Docs). Below the matching tabs, the results carry on in sections:

1. **Page text:** open tabs whose page mentions what you typed, even though the title and
   address don't. This needs permission to read pages; see below.
2. **Bookmarks** and **History**, if you've allowed SideRail to see them. Each bookmark shows
   the folder it lives in.
3. **Web:** a search engine search, as a last resort.

### Searching the text of open tabs

SideRail can't read pages when you install it. The first time you search, a box offers to ask
for that permission; Chrome asks once, for all sites, never site by site. **Revoke page
access**, under the results and in Settings, takes it back.

<p>
  <img src="docs/screenshots/page-access-ask.png" width="374" alt="Before page access: the offer to search inside the text of open tabs">
  <img src="docs/screenshots/page-text-search.png" width="374" alt="After: a search for microfoam finds four open tabs by their page text">
</p>

Each open tab is read once. A small reader is put into the tab, hands back the visible text
(without menus, headers and footers) and is removed; after that, every keystroke searches the
panel's own copy, so results appear as you type. Tabs Chrome has put to sleep can't be read
without waking them, so the results say how many there are, and a button wakes them, reads
them and puts them back to sleep.

**Nothing read is stored.** The text is held in the panel's memory while the panel is open,
and is dropped when its tab or the panel closes. It's never written to disk, never sent
anywhere, and never included in an export. Card numbers, IBANs, account numbers, National
Insurance and Social Security numbers are removed even from that copy.

**Some pages are never read.** Banks, card issuers, insurers, webmail, personal messaging,
dating, payment and health services, password managers and government services are on a
built-in list of about 18,000 sites, derived from the UT1 blacklists (CC BY-SA) with additions
for what they miss. Sign-in and account pages (`accounts.`, `login.`, `myaccount.` and so on)
and search engine results are skipped too, under the same switch. An address that carries a
password, token or sign-in code is never read, whatever the switch says. You can add your own
sites in Settings, under *Pages that are never read*, or mark a whole space **Private**. A page
can also decline on its own (`noindex`, a payment form or a login page), and the results say
which tabs were not read and why. Team chat such as Slack, Discord and Teams is deliberately
not on the list: it's exactly what you tend to want to find.

<p><img src="docs/screenshots/never-read.png" width="374" alt="Settings: the built-in never-read list, and a box for your own sites"></p>

## The command palette

<p><img src="docs/screenshots/palette.png" width="374" alt="The command palette after typing lis: two tabs from the Trips space, one from Home, and a web search"></p>

The **›** button beside the search box opens one ranked list over everything: **open tabs** from every
window — each showing which space it's in — **spaces** to switch to, **commands**, and
**bookmarks and history** if you've granted those optional permissions. Empty, it offers
recent tabs and the commands you're most likely to want.

The top line reads what you type as either somewhere to go or something to search for:

| You type | You get |
|---|---|
| `bbc.co.uk/news` | **Open** first — it's unambiguously an address |
| `bbc.co.uk news` | **both** — open `bbc.co.uk`, or search for the whole phrase, one arrow key apart |
| `how do tab groups work` | a search, and matching tabs |
| `localhost:3000`, `192.168.1.1` | **Open** — these are places |
| `v1.2.3`, `3.5`, `someone@example.com` | a search — dots alone don't make a URL |

A plain word never selects the web search: type `exa` and the first result is a tab you
have open, because pressing ↵ should not search the web for something already in front of
you. The web search is always there, at the bottom.

↑/↓ (or `Ctrl+N`/`Ctrl+P`) move and wrap, `Home`/`End` jump, ↵ runs, `Esc` closes. It's an
overlay rather than a view, so closing it leaves whatever you were looking at exactly as it
was — scroll position included.

## Finding your way around

The panel has two screens. The **tab list** is where you spend your time. **Manage
SideRail**, behind the cog, is where you set things up, and its back arrow returns you to the
tab list exactly as you left it.

The tab list, from top to bottom:

- **Search.** The box filters your tabs as you type and shows how many are open. The **›**
  beside it opens the command palette.
- **Spaces.** One entry per space, with its emoji and how many tabs it holds. Click to switch;
  drop tabs on one to move them there.
- **Pinned tabs** for the space you're in, as small tiles. Drag to reorder, or drag a tab onto
  the row to pin it.
- **Jump to a group.** One capsule per tab group: click to scroll to it, drag to reorder.
  The **⋯** on this row holds the window-wide actions: group tabs by site, ungroup everything,
  run your rules now, save the window as a space, export or import your data.
- **The tabs**, with tab groups as collapsible sections.
- **Three buttons along the bottom:** Dedupe, Defuddle (the reader view) and archive.is.

Manage SideRail has four sections: **Spaces**, **Rules**, **Rewind** and **Settings**. Each
has its own filter box, separate from the tab search, and everything in them can also be
reached from the command palette.

### Rewind

Every five minutes SideRail records what's open in each window, and which space each tab was
in, keeping the last 50 snapshots. Nothing is recorded when nothing has changed, so a quiet
evening doesn't push useful snapshots out. From any snapshot you can **Restore** it into a new
window (never over the top of what you have), **Re-pin** just the tabs that were pinned, or
**Keep as a space**. **Take one now** records one by hand.

<p><img src="docs/screenshots/rewind.png" width="374" alt="Rewind: two snapshots, each with its spaces, tabs and Restore, Re-pin and Keep as a space"></p>

### Dedupe

Dedupe finds tabs open at the same address and shows them to you before closing anything. It
suggests a copy to keep (the tab you're on, otherwise the one with the tidiest address,
otherwise the leftmost) and ticks the rest; you adjust the ticks and press Close, or Cancel.
Tracking parameters such as `utm_source` and `fbclid` are ignored when comparing addresses, as
is the order of the rest, so a link opened from a newsletter counts as a copy of the tab you
already had. Pinned tabs are never included.

<p><img src="docs/screenshots/dedupe.png" width="374" alt="Dedupe: one duplicate address, the copy to keep marked, the other ticked to close"></p>

---

## Files

```
manifest.json               MV3 manifest — the permission surface, all of it
common.js                   URL helpers, search matcher, rule engine, capture/restore, the page index store
background.js               service worker: commands, snapshot alarm, auto-rules, duplicate scan
sidepanel.html              panel markup
sidepanel.css               styles, light + dark via prefers-color-scheme
sidepanel.js                the UI
icons/                      app and toolbar icons
vendor/                     pinned Defuddle bundle + provenance, the emoji table, the never-read list
LICENSE, NOTICE             Apache-2.0, and the name and icon that are not part of the grant
THIRD-PARTY-NOTICES.md      licences of what ships inside the package
docs/screenshots/           the images in this README (not shipped in the package)
PRIVACY.md                  what is kept, where, and what never happens
SECURITY.md                 how to report a way round any of that
CHANGELOG.md                what changed in each version, and why
tools/package.mjs           builds the release zip from an allow-list
tools/build-exclusions.mjs  rebuilds vendor/exclusions.js from the UT1 lists and the additions
tools/update-defuddle.mjs   one-command Defuddle updater
test/e2e.js                 430-check suite, drives the real extension in a Chromium build
test/geometry.js            the panel's vertical budget, measured
test/bh.js                  bookmarks, history + screenshot capture (permission-promoted copy)
test/lint.js                static checks: imports, no network calls, no control characters
test/shot.js                renders the panel screenshots
```

## Running the tests

```bash
npm install          # once
npm run lint         # static, instant — also run automatically by the e2e suite
npm test             # lint + the browser suite + the geometry suite
npm run test:geometry  # the vertical budget on its own
npm run test:data    # bookmarks + history suite
npm run shots        # light/dark screenshots to eyeball
```

`test/geometry.js` deserves its own line. It measures the distance from the top of the
document to the first tab — the panel's scarcest dimension — at three widths, across rule
counts 0/4/5/8/20, and fails if anything pushes the list further down than the agreed
ceiling. It also holds the invariants that keep that number honest: the space switcher and
the jump strip stay on one row at any count, four real-world group names fit at 250px
without being squeezed to stubs, and nothing overlaps at 125% or 150% zoom with the largest
title size and wrapping on.

It exists because the redesign's whole justification was a quieter panel, and the first
draft of the spec would have made it 20–31% *taller*. It caught that, and then caught a
live defect in the build it was measuring: at 20 rules the jump strip was wrapping to three
rows. A budget you don't measure isn't a budget.

The tests need a Chromium-family browser. They look for `CHROME_BIN` first, then try
Helium, Chrome and Chromium in the usual macOS locations:

```bash
CHROME_BIN="/Applications/Helium.app/Contents/MacOS/Helium" npm test
```

**Google Chrome itself cannot run the suite.** Branded Chrome builds (137 and later) ignore
the flag that loads an unpacked extension, so a run against Chrome stops at "service worker
registered". Use Chromium, Helium, or Chrome for Testing — `npx playwright install chromium`
downloads one, under `~/Library/Caches/ms-playwright/` on a Mac — and point `CHROME_BIN` at
the binary inside it.

Installing Playwright normally downloads ~300 MB of its own browsers, which you don't
need if you point it at one you already have:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

`lint.js` exists because of a real bug: v0.3 called `normUrl()` in the bookmarks/history
search without importing it from `common.js`. Inside an async function that surfaces only
as `Uncaught (in promise) ReferenceError` in the extension's error list — the visible
symptom was simply that bookmarks *and* history returned nothing, with no error anywhere
in the UI. The linter compares each consumer's import list against `common.js`'s exports
in both directions, so that class of bug fails the build instead of quietly disabling a
feature.

`bh.js` exists because `chrome.permissions.request()` needs a trusted user gesture and
raises a modal that headless Chrome can't answer. It stages a copy of the extension whose
manifest promotes `bookmarks`/`history`/`scripting` to *required* permissions and tests
that. The code under test is byte-identical; only the grant path differs.

It loads the extension unpacked in real Chromium, opens tabs, and exercises grouping,
the dedupe review flow, search, rules, workspace save/restore, snapshots and the alarm.

Several checks exist purely as regressions for bugs found in use:

- search must reject the subsequence false positives (`supercharge` vs `github.com/0ponn/upstack`)
- row DOM nodes must be **reused** across tab updates, and repeated updates must cause
  near-zero DOM mutations — this is what stops a busy tab flickering the whole list
- the × and row activation must both work from `pointerdown` **alone**, since a
  re-render between press and release cancels the `click` event outright
- the context menu must close on outside click, scroll, Escape, pointer-away and a
  focused → unfocused transition — but must NOT close merely because the panel lacks
  focus, which in a real side panel is the normal state. Testing hasFocus() as an
  absolute value closed the menu on the first tick; only the transition is safe. A click
  landing in the web page raises no event the panel can see at all, so pointer-away is
  the practical stand-in
- the vendored Defuddle bundle must actually keep article text and drop nav/footer
- the page-text walk must honour its time budget on an 80k-node DOM
- every `common.js` helper a file uses must actually be imported by it
- the favicon and the tab title must share a centre line — measured against a real
  `<img>`, because the fault only shows with an inline-replaced element
- group-jump chips must carry the right letter and colour, must switch into the group,
  and must NOT steal the active tab when you're already in that group
- dragging a chip must reorder the bar, persist, and survive a panel reload
- changing a rule's colour must recolour an already-grouped set (a pass that moves zero
  tabs must still push the colour) and the chip must follow
- dedupe must close nothing before confirmation, and Cancel must close nothing
- a rule pass must be idempotent and must leave hand-named groups alone

It also asserts the manifest still has no host permissions and no content scripts, that no
shipped file makes a network call, and that the release zip holds exactly what it should —
so if a future edit widens the permission surface or the package, the suite fails.

---

## Reading the error list

`chrome://extensions` → Errors keeps entries until you press **Clear all**, and it renders
the source context by reading the file *currently on disk* while showing the line number
recorded *when the error happened*. After an update that means a stale error points at
completely unrelated code — the giveaway is that the highlighted line has nothing to do
with the message.

Both the panel and the service worker now stamp every uncaught error and unhandled
rejection with the running version:

```
[SideRail v0.7.0] unhandled rejection: TypeError: ...
```

So: press **Clear all**, use the extension, and anything that comes back is real. If it
carries no `[SideRail vX.Y.Z]` prefix, it predates the build you're running.

## Spaces

<p>
  <img src="docs/screenshots/space-work.png" width="374" alt="The Work space: Docs, Code and LinkedIn groups">
  <img src="docs/screenshots/space-coffee.png" width="374" alt="The Coffee space: a pinned tab, Wikipedia tabs and a YouTube group">
</p>

A space is a **label on a tab**, not a container of tabs. Switching between them makes
**zero browser calls** — nothing is closed, moved, grouped or reloaded — so it is instant
and cannot cost you a scroll position or a half-typed form.

- **Space bar** above the tab list: click a chip to switch, drag a tab onto one to move it.
- **Spaces view** to create, rename, reorder and delete. Deleting never closes a tab; its
  tabs fall back to Unsorted.
- **Right-click a tab → Move to <space>**, and it works on a multi-selection.
- New tabs open in the space you're looking at — including ⌘T, which Chromium quietly
  attributes to whichever tab happened to be on screen.
- **Main** is where everything starts — always first, always present, never deletable, and
  renameable. You carve spaces out of it, and a tab that belongs nowhere else returns to it.
- The panel **follows the browser**. Activate a tab from another space and the panel goes
  there with you — which is also what stops closing a tab from stranding you somewhere
  invisible, since Chromium has no successor-tab API.

**Pinned tabs are per-space**, as in Arc — the rule that a pinned tab cannot join a native
group binds Rules, not Spaces. They follow the same rule as every other tab: an unassigned
pin lives in Main. Right-click one for *Pin in every space*, which makes it ride along
everywhere and marks it with a small dot.

There is only ever **one real tab**, so closing a pinned tab closes it everywhere. Taking it
out of a space means moving it to another one.

**Rules give each space its own group.** A tab belongs to exactly one native group, so a
single shared *Travel* group would put every space's Travel tabs in one collapsible unit,
with one shared collapse state. Chromium lets two groups carry the same title and colour —
identity is an opaque token, the title is not a key — so Work gets a Travel group and
Personal gets its own.

### Where membership is kept

Which space a tab is in lives in `chrome.storage.session`, **one key per tab** —
`sp:<tabId>`, and `sph:<tabId>` to mark a tab you placed by hand.

That shape is deliberate. It used to be a single `spaceOf` object, and both the panel and
the service worker read it, changed it and wrote the whole thing back. `chrome.storage` has
no atomic read-modify-write, so any placement written between one writer's read and its
write was silently lost — and the worker's filing pass runs on every tab creation and every
navigation. Per-tab keys mean two writers touching different tabs never collide, because
they are no longer writing the same key.

Session storage is wiped on restart, which is correct: tab ids don't survive one either.
What survives is each space's saved URL list, described below.

### Surviving a restart

Tab ids don't survive a browser restart, and Chromium has no `sessions.setTabValue` — there
is **no way to attach durable data to a tab**. So membership is rebuilt every time the
browser starts, by matching each space's saved URL list against the order the browser
restored tabs in:

1. A URL only one space claims goes to that space.
2. A URL several claim follows the tab immediately before it — runs of tabs from one space
   stay together, which is what a restored window actually looks like.
3. Anything unclaimed goes to Main. Never nowhere.

Each space keeps an ordered URL manifest in `chrome.storage.local`, written on change and
debounced, and built from **every** window — a space can hold tabs in two windows, and a
per-window write would erase the other's. It is deliberately not written until membership
has been rebuilt: writing earlier would overwrite every space with whatever the browser
happened to restore, which after a dismissed crash prompt is nothing at all.

**After a crash or force-quit** Chrome shows a *user-gated* "Restore pages?" prompt rather
than restoring silently, and its own metrics show roughly 1.2–1.3% of restores return zero
tabs. If that happens the spaces are all still here — each shows its saved count and a
**Reopen** button. The worst case is a tab in the wrong space, or a manual reopen.

### Why not the other ways

| | What it does | Why not |
|---|---|---|
| Close and reopen | What 0.8.0 did | Seconds of reloading; scroll position, form contents and playing media all lost |
| A window per space | What 0.8.1 did | Instant and live, but you end up living across many windows |
| Collapsed native tab groups | What Lunma and Arcify do | Instant and live, but it spends each tab's single group on spaces — Rules would have to become sidebar decoration |
| **A label plus a filter** | What this does | The tab strip still shows every space's tabs — which matters only if you use the tab strip |

`tabs.hide()` — how Firefox extensions park tabs out of sight — **does not exist in
Chromium**, which is what rules out the option everyone actually wants.

## Hover previews

![Hovering a tab: a card with a thumbnail of the page, its full title, site and when it was last seen, drawn beside the panel](docs/screenshots/hover-preview.png)

Hovering a tab for a moment brings up a card with the **full title** (untruncated, up to
three lines), the **domain**, a **thumbnail** of the page, and state chips — pinned,
suspended, playing audio, muted, its group, when you last saw it, and how old the
screenshot is.

### How the thumbnails work, and their one limitation

`chrome.tabs.captureVisibleTab` can only photograph the **active** tab. There is no API
for capturing a background tab — so a thumbnail is taken each time you *visit* a tab and
cached against its id. Hovering shows you the page as it looked when you last had it open.

That means **a tab you haven't visited since the browser started has no thumbnail yet**,
and the card says so rather than showing an empty box.

Capture needs the same one-time page-access grant as page-text search and Defuddle. Until
that's granted, the card still shows title, domain and state — just no picture, and it
draws over the tab list instead of beside the panel. Grant or revoke it in
**Settings → Page access**.

Note that this grant belongs to the extension's **identity**, so anything that changes the
extension ID — including pinning it — drops it and it has to be granted again.

### Where the card appears, and why that was hard

The card is drawn **inside the page**, hugging the edge the panel is docked against — so
it sits right next to the panel instead of covering the tab list. A side panel cannot
paint outside its own frame, so there is no other way to put anything beside it.

The card can only be drawn into the tab **you are currently looking at**, because that is
the only surface next to the panel. If that tab is a `chrome://` page, an extension page,
the Web Store, a `file:` URL or a suspended tab, Chrome refuses the injection and the card
falls back to drawing inside the panel, over the list. It says so on its last line, so the
fallback is recognisable as a page that can't be drawn on rather than a bug.

Working out *which* edge took two attempts. There is no API for the panel's position, and
comparing `window.screenX` between the panel and the page doesn't work: Chrome reports the
**browser window's** left edge for both, so the comparison gives the same answer whichever
side the panel is on — which is why the card first appeared pinned to the far edge of the
screen. What is reliable is a mouse event's `screenX`, which comes from the OS event
itself. Since the cursor is over the panel whenever a row is hovered, the panel asks which
side of the window the cursor is in, and tells the page which edge to hug.

### The cache tidies itself

Images live in `chrome.storage.session`, which is **memory-backed and wiped on browser
restart** — thumbnails of your browsing never touch disk. On top of that:

- **One record per tab**, overwritten in place — repeated captures never accumulate
- **Removed the moment a tab closes**
- **Invalidated on navigation**, so you never see a picture of the previous page
- **Orphans swept** — any thumbnail whose tab no longer exists is dropped on the next pass
- **Capped two ways** — the newest 50, *and* a 4.5MB total budget, oldest evicted first.
  A count alone isn't enough: `storage.session` has a hard 10MB quota, and exceeding it
  makes writes fail silently.

Each image is **640px wide** — twice the 320px the card draws it at, so it stays sharp on a
Retina display — stored as a ~40–70 KB JPEG. The screenshot itself is captured as a **PNG**
and compressed once here, rather than captured as a JPEG and re-compressed, which used to
give the thumbnail two generations of artefacts.

### Why there's no per-tab memory figure

Because extensions can't get one. `chrome.processes` — the only API exposing per-tab
memory — is **Dev-channel only** and has been for over a decade. The alternatives are
worse than nothing: `chrome.debugger` shows a permanent "SideRail started debugging this
browser" banner and covers one tab at a time, and `performance.memory` reports only the
JavaScript heap, excluding the DOM, images, video and GPU memory that usually dominate —
a media-heavy page would look cheap.

Rather than show a confident number that's wrong, SideRail shows none. Chrome's own Task
Manager (**Window → Task Manager**) remains the accurate place to look.

### What a snapshot remembers

A snapshot records, per window: each tab's URL, title, pinned and muted state, which native
group it was in, and **which space it belonged to** — with a global pin recorded the same
way, since that's just another space id. It also stores the **names and emoji of your
spaces**, which is what lets a restore offer to bring back a space you've since deleted
rather than tipping its tabs into Main without comment.

That last part matters more than it sounds. Before 0.19 a snapshot held only browser state,
so a restore re-sorted the tabs by URL against whatever the spaces looked like *now* — which
is precisely wrong for a feature whose job is to undo changes.

Restoring always opens a **new window**, so it can never destroy what you have. Restored
tabs are marked as hand-placed, so the filing engine won't immediately move them somewhere
else and undo the restore.

Two things are deliberately *not* in a snapshot:

- **Rules.** Silently resurrecting a rule you deleted would be worse than not. Restored
  groups still come back with their name and colour, so if the rule still exists the next
  pass adopts them; if you deleted it, they arrive as ordinary hand-made groups that rules
  will never touch.
- **Settings and the jump-bar order.** Not session state.

For those, and for everything else, use Export data — Rewind is a tab time machine, not a
configuration backup.

## Backing up your data

Everything SideRail stores — Spaces, Rules, Rewind snapshots, settings and the jump-bar
order — lives in `chrome.storage.local`, which belongs to the **extension's identity**, not
to this folder. Because the manifest carries a fixed `key`, that identity is the same in
every copy, so moving the folder or reloading from a new one keeps the data, as long as you
never press **Remove**, which deletes it. Setting up on another machine, or installing a
store build (which has a different identity), does not keep it either:

- **Manage SideRail → Settings → Your data → Export data** writes a timestamped JSON file
  with everything.
- **Import data** reads it back.

Page text is never stored, so there is nothing of it to export.

Import accepts both this app's export format *and* a raw `chrome.storage.local` dump —
the shape you get from pasting `await chrome.storage.local.get(null)` into the panel's
developer console. Handy for lifting data out of a build that predates the Export button.

Import only replaces the keys present in the file; anything else is left alone. Backup
files are covered by `.gitignore`, since they contain your actual tab URLs and titles.

## Keeping the docs honest

Two files, two jobs:

- **README.md** — how SideRail works *now*. Updated whenever behaviour changes.
- **CHANGELOG.md** — what changed in each version, and why. Bug entries name the actual
  cause, not the symptom: several were subtle enough that the reasoning is worth keeping
  (an inline box reserving descender space; `hasFocus()` being false in a side panel by
  design; a missing import swallowed by an async rejection).

If a version ships without a changelog entry, that's a miss — say so.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm test` and add
a check for what you changed — the suite is the only thing standing between a behaviour and
its silent loss. Contributions are accepted under the Apache License 2.0, which covers
patents and needs no separate agreement; the name and icon stay with the project (see
`NOTICE`).

Bug reports are most useful with the diagnostics paste from Settings → Advanced. Read it
before you post it: it lists the site name of every tab you have open.

## Known limits

- **Panel width is Chrome's, not mine.** Dragging the inner edge to resize is stock
  Chrome behaviour — SideRail does nothing to enable it and nothing can. Chrome
  hard-codes a minimum width (raised from 320px to ~360px in Chrome 120) and the
  `chrome.sidePanel` API exposes no width control at all; Chrome also forgets your
  width on restart. This is [a long-standing open request](https://issues.chromium.org/issues/40926440).
  The **only** way to go narrower is an in-page sidebar injected via content scripts
  on every site — which is exactly the `<all_urls>` permission we set out to avoid.
  That's the real trade-off, and it's worth being clear that it's a genuine cost:
  Firefox and Vivaldi have no such floor.
- **The panel can't render over `chrome://` pages** — same native-panel constraint.
- **`Alt+B` opens the panel but can't close it.** Chrome has no close API. The toolbar
  button toggles properly; use that.
- **Restoring a large Space loads every tab at once.** Chrome won't let you create a tab
  pre-discarded. For a 50-tab space, expect a moment of churn.
- **Snapshots only cover normal windows** — incognito is excluded by design.
- **One window at a time.** The panel shows the window it lives in. That's Chrome's model.
- **A page can refuse to close.** If a tab has an `onbeforeunload` handler, Chrome shows
  its own "Leave site?" prompt and the tab stays until you answer. SideRail detects
  this and says "that page is asking to stay open" rather than looking broken.
- Not built, deliberately: link previews drawn over the page, drag gestures, hint mode,
  rocker gestures and type-to-select all need content scripts on every page, which would
  reopen the `<all_urls>` question. Cross-device sync and a custom new tab page need no
  extra host access and are open to a pull request.

---

## Changing it

It's plain ES modules, no build step. Edit a file, hit the reload arrow on
`chrome://extensions`, done. Some obvious knobs:

- `WEB_SEARCH` in `sidepanel.js` — the fallback search engine
- `MAX_SNAPSHOTS` in `common.js` — how deep Rewind goes (50)
- `periodInMinutes` in `background.js` — snapshot cadence (5)
- `--accent` and the `--g-*` group colours in `sidepanel.css`

## Licence, third-party software and warranty

SideRail is released under the **Apache License 2.0**; the full text is in
[LICENSE](LICENSE). [NOTICE](NOTICE) explains that the name and icon are not part of that
licence, so a fork should use its own.

It includes three pieces of other people's work, each under its own licence. The notices are
reproduced in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), which ships inside every
release:

- **[Defuddle](https://github.com/kepano/defuddle)**, by Steph Ango, which extracts the
  article for the reader view. MIT licence.
- **Unicode emoji data**, for the emoji picker when you name a space. Unicode License V3.
- **The UT1 blacklists**, maintained by Université Toulouse Capitole, which the built-in
  never-read list is derived from. Creative Commons Attribution-ShareAlike (CC BY-SA); the
  derived list in `vendor/exclusions.js` is under the same licence.

**No warranty.** SideRail is provided "as is", without warranties or conditions of any kind,
and without liability for any loss or damage that comes from using it. Sections 7 and 8 of
the licence set out the terms in full. In short: you use it at your own risk.
