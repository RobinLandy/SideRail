# Changelog

Notable changes, newest first. Versions match `manifest.json`.

The README describes how SideRail works *now*; this file records what changed and,
where it matters, why. Bug entries name the actual cause rather than the symptom —
several were subtle enough to be worth not re-learning.

---

## 0.26.0 — the stored index is gone

Page-text search no longer keeps anything. From 0.23.0 to 0.25.0 what was read was
written to the extension's own IndexedDB database so a closed page could be found again
under "Pages you've read", with retention controls, a per-site list with Forget, a pause
switch, reading as you browse, and a term index in a worker (0.24.0). All of that is
removed. The first run of 0.26.0 deletes the database and drops the five retention settings
from the settings record, so nothing of it lingers on a machine that had it.

The reason, plainly. A store of page text is only as safe as the list of pages it must never
contain, and that list is a blacklist. The 0.25.0 audit found a registration address
carrying a password, insurer pages, NHS pages and a card portal in a real store after seven
weeks, and the gates added then are patches on a list that cannot be complete. Publishing
the code invites scrutiny of exactly that feature, and the honest answer to "what happens
when the list misses a site" was "the page sits on disk until retention drops it". Searching
the open tabs has no such answer to give: the text lives in the panel's memory, read once per
tab, and is gone when the panel closes. That was the feature from 0.22.0, and it is the
feature again.

What stays: full-text search of every open tab, the built-in and personal never-read lists,
the three gates (credential-bearing addresses, sign-in hosts, search results pages), Private
spaces, redaction before anything is held in memory, Re-index, and waking sleeping tabs to
read them. `index-worker.js` is deleted and `tokenise` with it.

Enforced, not promised: `test/lint.js` now fails the build if shipped code touches IndexedDB
for anything but deleting the old database, uses `chrome.storage.sync`, or creates a
Worker. `test/e2e.js` checks that the panel creates no database, that a database left by
0.23–0.25 is deleted, that the Settings screen offers no retention, as-you-browse or pause
controls, that text read from a page never reaches `chrome.storage.local`, and that the
retention keys are gone from the settings record after boot. The page-access chip says again
that the text stays in the panel and is never written to disk, which is true again.

Checked on disk, not only in code: a page whose text exists only after its script runs was
read by the panel and found by a search, and none of the 186 files in the browser profile
contained that text afterwards.

The README is rewritten for someone using SideRail rather than building it: a new
description and screenshots, the features in the order you meet them, everything about
privacy and permissions in one section, and a short section for developers at the end. The
design history, internals and test notes are gone (they live in the changelog and the code),
and it is about 40% shorter. A closing section names the licence, the three third-party
components and their licences, and the licence's warranty disclaimer.

## 0.25.0 — what should never have been kept, and a tree fit to publish

An audit of a real store after seven weeks of **Read pages as I browse**: 2,000 pages,
17.7 MB, retention doing exactly what it says. And, in among them, things that had no
business being there. The never-read list did its job for every site on it; the gaps were
the things no list can hold.

**Kept, and should not have been**

- **A registration page whose address carried the password.** The site put `password=` and
  the email address in the query string of a GET form, and SideRail stored that address as
  the record's key. The page had a password box, and the 0.22.0 decision not to refuse a
  page merely for having one was still right — the leak was the address, not the page.
- **Two insurance pages with a 555-character access token in the address**, one of them a
  74,000-character policy document; OAuth callback addresses carrying `code=`; a signed
  consent link.
- **A business credit-card portal** (seven statements' worth), **an insurer's account pages**
  and **forty-one NHS vaccination-consent pages**. UT1's "bank" category stops at banks, and
  the health additions named three NHS subdomains rather than the estate.
- **Sign-in and account pages** on Google, eBay, a supermarket and a transport authority.
  Small, but the kind of page that holds an address and a phone number.
- 324 **search-engine results pages**, the query in each address: a search history, not
  pages read.

**What changed**

- **An address that carries a credential is never read**, whatever list it is on and
  whatever the settings say: a password, token, OAuth code, signature or JWT under the usual
  names, a token in the fragment, or any opaque value of 48 characters or more.
  `urlCarriesSecret()` in `common.js` — the one gate with no switch.
- **A host whose first label is a sign-in word is never read** — `accounts.`, `login.`,
  `myaccount.`, `auth.`, `checkout.`, `billing.` and so on, on any site. No list can
  enumerate these; the label can. `hostLooksPrivate()`.
- **Search results pages are never read** — Google, Bing, DuckDuckGo, Kagi, Brave, Ecosia,
  Startpage, Yahoo, Yandex, Baidu, Qwant, You, Perplexity and YouTube's results page.
  `isSearchResultsPage()`. These two sit under the built-in list's switch.
- **The built-in list grew by 146 sites**: the whole of `nhs.uk` and the other UK health
  bodies, private health providers, insurers and comparison sites, card issuers and lenders,
  pay-later services, and every transactional GOV.UK service (`service.gov.uk`). UT1's dating
  category also grew upstream. 17,988 sites now.
- **National Insurance and Social Security numbers are redacted** before anything is kept,
  alongside card numbers, IBANs and account pairs.
- **All of it applies to what is already kept.** The retention pass at panel open drops any
  stored page the new rules cover, and search never offers one. On the audited store that is
  a few hundred pages, gone the next time the panel opens.

Two things the audit confirmed rather than changed: redaction had caught 34 card numbers
and 15 IBANs on their way in, and the nine card-shaped numbers that survived were LinkedIn's
thirteen-digit internal ids. Retention: nothing older than thirty days, exactly 2,000 pages,
17.7 MB of a 50 MB cap — at a hundred pages a day the page cap is the one that bites.

**Fit to publish**

The repository is being prepared for a public release under the Apache License 2.0.

- **`common.js` was a binary file.** Two raw NUL bytes sat in a template string — a key
  separator in the rule-conflict check — and every text tool from `grep` to GitHub's diff
  view had been treating the whole file as binary since. Written as `\u0000` now, and
  `test/lint.js` fails on any control character in a shipped file, so it cannot come back.
- **`LICENSE`, `NOTICE`, `PRIVACY.md`, `SECURITY.md`** and an issue template. The privacy
  note is written from the code and names every third party a click can reach.
- **Settings → About** shows the privacy note, the licence and the third-party notices in
  the panel, links to the releases and issues pages, and says plainly that SideRail never
  checks for updates and how to do one by hand.
- **`tools/package.mjs`** builds the release zip from an allow-list — and with `--store`, a
  zip with `manifest.json` at the root and without `key`, which is what the Web Store takes.
  The suite builds both and checks what is and is not inside.
- The manifest's description no longer claims "100% local, no host permissions", which was
  not defensible as written. It says what is true: nothing leaves your browser.
- This changelog no longer names a client or addresses one reader; the README no longer
  defines SideRail against another product and describes its own properties instead; the
  working documents stay out of the public tree.

No change to anything else.

---

## 0.24.0 — "Pages you've read" answers from a term index, off the panel's thread

Phase 3 of page-text search. The store search was a linear walk: correct at any size, fine
to about 50 MB, and slower past it. It is now an **inverted index** — every term mapped to
the pages that contain it — held in a **module worker** (`index-worker.js`) so the search
runs off the panel's thread. A query is a prefix lookup per term, an intersection, and an
exact-phrase check against only the candidate pages, fetched newest-first until the list is
full. Typing `qzwindex` finds a page containing `qzwindexed`; `engine vortex` does not match
a page that says `vortex engine`, because the phrase is confirmed against the page.

**Built once, kept current, never trusted blindly.** The index is built by one walk of the
store when the panel opens, updated as pages are written, and rebuilt after a prune, a
forget or an erase. Before answering, the worker compares the store's record count with its
own and rebuilds if they differ — so anything that writes to the store behind its back (a
test today, a service-worker writer tomorrow) cannot leave it stale. While it is building,
the old walk answers; the section label's tooltip says which path replied.

**Scripts without spaces.** Chinese, Japanese and Korean runs have no word boundaries to
split on, so they are indexed as character bigrams: 東京都 becomes 東京 and 京都. Everything
else is lowercase runs of letters and digits, two to forty characters.

**Nothing else changes.** Same store, same redacted text, same never-read list applied to
what comes back, same "not in Export", and the suite's no-network check now covers the
worker too. The index is memory and dies with the panel; nothing new is written anywhere.

---

## 0.23.0 — what you've read is kept, on this computer, with the same care as your history

Phase 2 of page-text search. Everything read is now kept on disk so it can be found again
after the tab is closed — and the privacy story is written down rather than implied.

**Where it lives, and who can read it.** The extension's own IndexedDB, in the Chrome profile
directory, one record per page keyed by its canonical address so a revisit replaces rather
than repeats. No other extension can open it — the browser partitions storage per extension
— and no website can. Any program running as you could read the files, exactly as it could
read Chrome's own history database; that is the bar, and the settings say so in those
words. It is never sent anywhere, never put in `chrome.storage.sync`, and — because it is not
in `chrome.storage.local` — **never included in Export**, so a backup on Dropbox cannot
carry the text of pages you read. Text only: no HTML, no images, no form values.

**Redacted before it is kept.** Luhn-valid card numbers, IBANs and UK sort-code-and-account
pairs are replaced with `[redacted]` before anything goes into memory or on disk. A page that
slipped past every exclusion is embarrassing rather than dangerous.

**Retention you control.** Settings → *What has been read*: keep for N days (30), at most N
pages (2,000), at most N MB (50); the oldest go first, and anything the never-read list has
since caught goes on the next prune. *Show* lists what is kept by site, largest first, with
*Forget* and *Forget & never read* on each. *Erase everything that was read* does what it
says, after asking.

**Closed pages come back.** Search now has a fourth section, *Pages you've read*: pages in
the store that are not open right now, newest first, streamed in as the walk finds them, with
when they were read and a snippet. Click to open. The live index still answers for open tabs;
the store answers for everything else.

**Read as you browse — off unless you turn it on.** When on, a page is read shortly after it
finishes loading and again when you leave its tab — the moment its content is what you saw,
which is what catches mail, chat and feeds that change without ever reloading. While the panel
is open, only with page access granted, never more than once every ten seconds per tab, and
through exactly the same exclusions, redaction and store as a search. *Pause reading* stops
everything new without touching what is kept.

**The suite now asserts no network.** `test/lint.js` fails if shipped code touches
`XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource` or `RTCPeerConnection`, if any
`fetch()` targets anything but the extension's own files or a data URL, or if the reader is
ever called through Defuddle's `parseAsync()`, whose extractors make requests. The privacy
claim is a test, not a sentence.

---

## 0.22.0 — page-text search reads once and searches as you type, and some pages are never read

**Read once, search many.** Page-text search used to inject a reader into every tab for every
query, wait on the slowest, and throw the answers away on the next keystroke. Now each readable
tab is read **once** into an in-memory index — its visible text with the page chrome stripped —
and every query is a local search over that text, live as you type, beside the title matches.
Reading starts on its own the moment you search with page access granted; measured on 40 tabs
(ten of them 200 KB pages) it took 308 ms, and refining the query afterwards re-read nothing.

The index outlives sleep. Text read while a tab was awake stays searchable after Chrome freezes
or discards it, which is the only way to search a frozen tab without visiting it — a 💤 on the
hit says so. Discarded tabs that were never read can still be woken, read and put back, four
at a time, as in 0.21.2. The index lives in the panel's memory only: it dies with the panel and
is never written to disk. That is the whole privacy story of this version.

**Pages that are never read.** Webmail, banks, personal messaging and the like must never be
read — not for search, not for anything. Three layers, all visible:

- **A built-in list** of ~15,000 sites, shipped in the package (`vendor/exclusions.js`), built
  by `tools/build-exclusions.mjs` from the UT1 blacklists — the categorised domain lists the
  Université Toulouse Capitole has maintained for school and workplace filters since the 1990s
  (CC BY-SA; see `THIRD-PARTY-NOTICES.md`) — using the `bank`, `webmail`, `chat` and `dating`
  categories. UT1 is French-run and misses Barclays, Lloyds, Monzo, Starling, First Direct and
  Chase, and Outlook, Proton and HEY; the builder adds those, plus payment, crypto, accounting,
  health portals, password vaults and government portals. Team chat — Slack, Discord, Teams —
  is deliberately *kept*: it is what people want to find. Two known gaps, stated rather than
  hidden: UT1's `gambling` (32,000 domains) is too heavy to ship, and `adult` (millions) is
  impossible; your own list is the answer for both.
- **Your own list**, in Settings → *Pages that are never read*, one per line in the rule
  syntax. And a space can be marked **Private** from its card, so nothing in it is read.
- **The page itself.** A `noindex` meta tag, a payment form (`cc-*` or one-time-code
  fields), or a login *page* — a password field on a page that is little else, or whose path
  says login — all decline to be read. A login *box* on an article is not a reason; the
  article is read normally.

The search results say what was not read and why — *"2 tabs never read — mail.google.com,
hsbc.co.uk. Settings"* — so the exclusion is something you can see working rather than trust.
A site added to the list is honoured at once, including against text already read.

**Housekeeping.** `PAGE_SCAN` and `planScan` are replaced by `PAGE_TEXT` and `planIndex`; the
"already ruled out" and "stalled" bookkeeping went with them. The machine-speed-dependent
"page scan honours its time budget" test — one of the two long-standing failures — is replaced
by one that asserts the mechanism (a zero budget returns partial at once) rather than the
clock.

---

## 0.21.2 — page-text search: two bugs, and the numbers behind "it's slow"

The question was why searching the text of open tabs is slow, and why it ignores sleeping tabs.
Measured before touching anything, on 80 tabs with twenty of them 400 KB pages: the whole
sweep through the real code path takes **624 ms**, about 5 ms of round trip and 1 ms of
walking per tab. Extracting a 150 KB page's text once costs under a millisecond. Throughput
is not where the slowness is.

It is in two other places. The sweep is bounded by its slowest tabs — a heavy page hits the
400 ms budget, a stalled one hits the 1.5 s timeout — and on a 150-tab browser several of
those per sweep is normal. And the design makes you pay that sweep again on every query,
because each keystroke discards the results and shows the button again. That is what "slow"
feels like. The fix for that is architectural and was designed here and shipped as 0.22.0
to 0.24.0 rather than done in this release: extract each page's text once and search it
locally as you type,
which also makes sleeping tabs searchable from what was read while they were awake.

**Two bugs, both fixed**

- **A freshly reloaded tab was recorded as a proven empty.** `PAGE_SCAN` reported a document
  with no body yet as a definitive zero (`partial: false`), so the panel put that tab into the
  "already ruled out" set and every longer query skipped it. A glance is not a search; it now
  reports `partial: true`, as does a document still being parsed.
- **"+ N suspended" had never worked.** It pushed the discarded tabs into the ordinary queue
  and injected into them. Injecting into a discarded tab throws — nothing reloads it — and the
  catch swallowed the error, so the button said "Scanned N tabs" having searched none of them.
  It now does what your second complaint asked for: **wakes each sleeping tab, waits for its
  page to finish loading, searches it, and puts it back to sleep** — four at a time, since each
  wake is a network fetch and a renderer. Cancelling mid-way puts any tab it had woken back
  too. The button says so: *Wake 12 sleeping tabs and search them.*

**What it still cannot do.** Chrome distinguishes *discarded* tabs (unloaded; `tabs.reload`
brings them back) from *frozen* ones (loaded but not running; they thaw only when you
activate them, and there is no API). Frozen tabs stay skipped and are counted as "asleep" in
the summary. Searching them without visiting each one needs the index above.

**Testing note.** `chrome.tabs.discard()` crashes headless Helium outright, so the wake path
could not be exercised by the suite. The reload-and-wait half was verified on a live tab
(reload → `complete` in 50 ms → the new document searched); the discard half is one API call
the *Suspend tab* menu item has used all along. Please try the button once in your own
browser.

---

## 0.21.1 — pre-publication review: one real leak, one real speed-up

A sweep before publishing: security, personal data, bugs, performance, licensing. This is
what changed in the code.

**A leak, fixed.** The hover preview is drawn into the active page, because a side panel
cannot paint outside its own frame. It was drawn inside an **open** shadow root — which any
page can read. The card carries the hovered tab's title, host, group and, once captured, its
**screenshot**, so a hostile page in front could obtain a picture of whatever tab you hovered
over. It needs page access granted and that page to be the active one, which is exactly the
situation when you are on it. The root is closed now; `element.shadowRoot` is null to the
page, and the reference lives in the isolated world where page scripts cannot see it. The
image `src` accepts only our own data URLs, and text is escaped rather than stripped.

**A speed-up, measured.** Reading membership scanned the *whole* of `storage.session` — the
area that also holds up to 4.5 MB of thumbnails — to get a few hundred bytes. Every rules
pass, on every tab creation and navigation, did that three times. With 4.15 MB in the area a
whole-area read costs 23.5 ms and a keyed read 1.4 ms; callers now pass the tab ids they
already have, and a pass reads once instead of three times.

**Smaller things.** Both message listeners check the sender. `esc()` escapes quotes. Import
checks that `spaces` is an array and `settings` an object before writing them — a malformed
backup used to import cleanly and then throw on the next render. The "Keep as a space"
dialog title was HTML-escaped into a `textContent` sink (mine, from 0.21.0).

**`test/lint.js` was lying.** Its literal-stripper blanked single-quoted strings in a pass
*before* double-quoted ones, so the literal `"'"` — as found in any escaper's lookup table —
opened a phantom string that swallowed code to the next `'`, `export` keywords included. It
reported seven missing exports that existed. One combined alternation pairs quotes
correctly. Same family as the vacuous tests: a checker that can produce confident fiction.

**Personal data.** Three code comments named a client and the author; the test suite used
the client's name as a fixture; an example email address was the author's. All scrubbed from
code and tests. The working documents are a separate decision, and stay outside the public
repository.

---

## 0.21.0 — the management screens say what they do

The four management panels were confusing: it was rarely obvious what a button would do
before you pressed it, and Rules was the worst of them. All three complaints were fair.
Working through them turned up two outright bugs as well as the wording.

**Rules: three buttons that did almost the same thing**

There were three ways to run your rules, and no way to tell them apart:

| Button | What it actually did |
|---|---|
| Apply to this window | Filed every tab except the active one, then grouped |
| Apply now (on every rule card) | **Exactly the same thing.** Never applied just that rule |
| File open tabs now | Filed every tab *including* the active one, and did not group |

So the real distinctions were whether the tab in front of you moved, and whether grouping
happened — neither of which any label hinted at, and one of the three was a plain lie about
its own scope. They are now one button, **Run rules now**, which files and groups everything
in the window including the active tab, and says so underneath itself. The palette command
and the overflow-menu item collapsed into the same single action.

**Rules: the card now reads in the order you think in**

A rule card used to go name → patterns → how many matched → the two action controls → and
finally the sentence explaining what those controls meant. It now reads as two labelled
bands: **Catches tabs matching**, then **Then does this**, with the plain-English summary
sitting directly under the controls it describes rather than three elements below them.
`File into` became `Move them to`, and the do-nothing option went from `— leave where it is —`
to `Nowhere — don't move them`.

Rule priority was explained in a paragraph at the very bottom of the screen, a long way from
the ↑↓ buttons that set it. There is now a line above the list, and the arrows have real
labels instead of a bare arrow and a tooltip. The pattern-syntax reference is folded into
`How to write a pattern` — still one click away, no longer six lines under every visit.

**Rewind: restoring a snapshot was quietly losing your spaces**

What happens to your spaces when you restore? The honest answer was: nothing good.
`restoreSnapshotWindow` — which puts each tab back in the space it was in, and offers to
recreate a space you have since deleted — **was written, and never called.** The Restore
button used the raw capture restore instead, which reopens the tabs and stops there, leaving
them to be re-sorted against today's rules. That is precisely backwards for a feature whose
job is to undo. The button is now wired to the function that was always meant to serve it.

**Rewind: "180 tabs · 1 window" answered none of the questions you had**

Snapshots have recorded which space each tab was in since the feature was written; nothing
displayed it. Each snapshot now shows its composition — `Main 120 · Work 8 · Travel 2` —
with a dashed outline on any space that has since been deleted.

`Save as space` is now `Keep as a space`, and it asks first. It flattens every window and
every space in the snapshot into one new space, which is a reasonable thing to want and an
unreasonable thing to discover afterwards. The dialog names the spaces being combined and
says the split is not kept.

The filter box above the list now says what it just did — *"Showing 3 of 50 snapshots — the
ones holding a tab that matches 'invoice'"* — rather than silently shortening the list.

**Spaces**

Both Spaces and Rewind opened with a sentence stuffed inside a **disabled text input**, which
reads as a field you are not allowed to type in rather than as an explanation. Both now have a
proper intro: what the screen is for, and the one thing you probably came to do. `12 open · 8
saved` became `12 tabs open now · 8 remembered`, because "saved" sounded like a second copy of
your tabs rather than a list of addresses to rebuild from.

**Settings: sorted into cards, with the developer tools folded away**

It was one long strip. It is now Tab titles · Page access · Your data · Keyboard · Advanced ·
About. *Panel measurements* and *Where does the panel end?* exist to settle a CSS argument and
read as broken features to anyone else, so they live behind **Advanced and troubleshooting**
along with Diagnostics — which now warns, before you copy, that the dump lists every site you
have open.

Backup moved here from the bottom of the Rules screen, under the pattern-syntax help, which is
nowhere anyone would look for it. `Reset to defaults` became `Reset tab titles`, since that is
all it ever reset.

**The palette shortcut is gone**

A fair complaint. Chrome does not let an extension move keyboard focus into its
own side panel, so the browser-wide ⌘K opened the box and then fed your typing to the page
behind it. The in-panel key did work — but only once you had already clicked into the panel,
at which point clicking the search box is the same gesture. Around that one marginal binding
sat a capture control, a reset, a test harness and two paragraphs explaining why its
better-known twin did not work.

All of it is removed: the `command-palette` command is out of the manifest, and the settings
card is now four lines about Chrome's shortcuts. Search itself is untouched — it opens from a
**›** button beside the search box, which is a visible affordance rather than a key you have
to be told about. What the palette should become is still an open question.

**A pass with my eyes open**

Screenshotting the four screens afterwards caught five things reading the code had not:
`Page access` appeared twice in a row on its own card; the grant button wrapped to three
lines; the ↑↓ that decide rule priority were 18px of `--fg-faint` beside a text field, which
is a poor place to hide the only control that resolves a clash; a space with nothing
remembered still said `· 0 remembered`; and the live match count — a button — was
indistinguishable from the sentence above it, which is precisely the complaint that started
this. It is now a pill that reads *Show the 3 open tabs this catches*.

The palette button also went in the wrong place first. Inside `.search-row` it shrank the
input out from under `#clear-search` and the tab counter, both positioned absolutely against
the row, so the counter overhung the field. It is a peer of the cog instead. The suite caught
that one; the screenshots caught the rest.

**Tests**

The palette-key tests are replaced by ones asserting the opposite: that no keystroke opens the
box, that the manifest declares no palette command, and that the button does — carrying
whatever you had already typed. Plus checks that Export/Import moved to Settings and left
Rules, and that the instrumentation really is folded shut rather than merely present.

---

## 0.20.5 — third-party licence notices, and a store-readiness assessment

No behaviour change.

**A licence breach, found and fixed**

Were we complying with the licences of anything third-party? We were not.
Two pieces of other people's work ship inside the extension package, and neither notice was
travelling with it:

- `vendor/defuddle.js` is MIT, © 2025 Steph Ango (@kepano). The minified bundle carries no
  licence banner of its own — zero `@license` or `/*!` comments — and there was no `LICENSE`
  or notices file anywhere in the repository. MIT requires the notice to be included in all
  copies.
- `vendor/emoji.js` is generated from Unicode's `emoji-test.txt` and is Unicode License V3
  data. The generated file credits the source URL in a comment, which is decent practice but
  is not the required copyright and permission notice.

`playwright` is Apache-2.0 and dev-only; it is never packaged, so there is no obligation.

Practical exposure was nil — distribution so far has been to one person from a private repo.
It would have become a real breach on the day anything was published. `THIRD-PARTY-NOTICES.md`
now carries the MIT text with the correct copyright line and the verbatim Unicode licence,
and it has to be included in any package that is distributed.

**Store readiness**

An internal readiness assessment answers "what would it take to publish this", with the caveat that not
publishing has been a standing constraint and asking the question is not the same as
deciding. The findings worth knowing even if the answer is no: the manifest's `key` must come
out for a first upload and the store then assigns a different extension ID, which means empty
storage unless you export and import around it; and the "100% local, no host permissions"
line in the description is not defensible as written, because `<all_urls>` is an optional
permission and the vendored Defuddle bundle contains third-party API calls that the shipped
code does not reach but a reviewer would find.

---

## 0.20.4 — README said the opposite of what 0.20.3 does

Docs only, no behaviour change. The README still described the rule 0.20.3 replaced: "New
tabs inherit the space of whatever opened them, else the space you're in." That is now
backwards, and it is the one line someone would have read to decide the fix was wrong.

---

## 0.20.3 — found it: ⌘T inherits from the tab you left behind

The diagnostics trace settled it. This is the fix for the bug 0.20.2 could not reproduce,
and both halves of the report are one cause, not two.

**What the trace showed**

```
17095  show    unsorted → Work
19142  place   tab 739944937  opener 739944911  via "opener"  showing Work  chose unsorted
19142  activated  tab 739944937  tabSpace unsorted  showing Work  act "follow"
19142  show    Work → unsorted
```

The tab is misplaced **first**, and the sidebar moves **afterwards** because it is now
genuinely looking at a tab that belongs to another space. I had the causality backwards in
0.20.2, where I supposed the panel wandering off was what dragged the new tab with it.

**The cause**

Switching space in the panel does not move the window's active tab — that is deliberate, and
it is the whole point of spaces being labels rather than containers. So when you switch to
Work, the tab actually on screen is still one of Main's. Press ⌘T and Chromium records that
tab as the new tab's `openerTabId`: not because anything opened it, but because Chromium
keeps the tab that was focused so it can hand focus back when the new tab closes.

`placeNewTab` ranked opener inheritance above the space on screen, unconditionally. So the
opener — a Main tab — won every time, and the new tab was filed into the space you had just
left. `onActivated` then did exactly what it is supposed to do: followed you to the space of
the tab now in front of you. That is the sidebar "switching by itself".

**A first fix that was wrong, and the test that caught it**

My first attempt kept opener inheritance and tried to exempt ⌘T from it, on the reasoning
that a new-tab page has no real relationship with whatever it was spawned alongside. The new
test failed, so I stopped and measured what `chrome.tabs.onCreated` actually reports on
Helium. Two things, neither of which I had assumed correctly:

- For a tab the **browser** creates — ⌘T and a link opened in a new tab alike — the event
  carries `url: ''` and no `pendingUrl` at all. The destination genuinely has not been
  decided yet, so there is nothing at that moment that tells the two gestures apart. The
  discriminator I had written could not exist.
- For a tab an **extension** creates with `chrome.tabs.create({openerTabId})`, the opener is
  missing from the event entirely.

That second one has an uncomfortable consequence: the test named "a tab opened from another
inherits its space" has been passing since 0.19 while exercising the no-opener path, and the
parent it picked was always already in the space the panel was showing, so the two rules
could never disagree. It is the fourth vacuous test in this project, and the same lesson as
the other three.

**The fix**

The space on screen wins. `placeNewTab` now takes the showing space of the tab's own window
first, and consults the opener only as a last resort, for a window with no showing-space on
record at all.

This is a real behaviour change and worth being plain about: a link opened in a new tab from
a page belonging to *another* space now lands in the space you are looking at, rather than
following its parent. I would have preferred to keep that inheritance, but it cannot be told
apart from ⌘T at the moment the decision has to be made, and getting it wrong for ⌘T is the
bug you have been living with. The space you are working in is the better default of the two.

**On the 0.20.2 `onActivated` guard**

Kept, and still hardening — a re-fire for the already-active tab should not move you out of a
space you just chose. It was never the fix, it is not the fix now, and the comment above it
that implied otherwise has been corrected rather than deleted, so the wrong theory is not
quietly rewritten out of the file.

**Tests**

The vacuous inheritance test is replaced by one that parks the opener in a space the panel is
demonstrably not showing and asserts that difference before concluding anything from it. A
second test drives a real `target=_blank` click, because that is the only way to get a tab
that carries an opener in `onCreated` at all — the shape every previous test missed.

Bisected both ways, which is the part 0.20.2 could not do. Against the old placement code the
new test fails with `unsorted vs here` — your bug, reproduced in the suite. Against the fix it
passes. The API-driven test passes either way, which is the vacuity above, stated as evidence
rather than as a suspicion.

**Two failures this release does not fix**

Both were already failing before this change and are unrelated to it — confirmed by running
the suite against the old placement code, not assumed:

- `the ignored parameters are reported per tab` expects three tracking parameters and gets
  two, with `fbclid` missing. `trackingParamsIn()` returns all three when called directly, so
  the tab's URL had already lost it by the time the check ran. Cause not established. The
  check's own selector — `t.url === clean.length ? 0 : t.url !== clean` — is also malformed;
  it compares a string to a number and works only by accident.
- `page scan honours its time budget on a huge DOM` expects a 40 ms budget to be exhausted;
  on your Mac the scan finishes in 32–35 ms, so it never goes partial. The assertion is
  machine-speed dependent and was written on slower hardware.

## 0.20.2 — I could not reproduce it, and I am not going to guess again

The report: switching to Work and pressing ⌘T opens the tab in Main, and the sidebar then
moves to Main by itself. **This release does not claim to fix that.** Here is
what happened instead.

**A reproduction that was lying to me**

I built a harness that did reproduce it, and the trace was unambiguous: `onActivated` fired
for a tab that was *already* active, the panel followed it back to Main, and the tab created
a moment later inherited Main. Cause found, fix written.

Then I checked the harness. It opened the panel as an ordinary **tab in the window under
test**. A real side panel is not a tab. So "the browser window regains focus" showed up in my
harness as a genuine tab switch, which is exactly the event I was blaming — an artefact of
the test, not behaviour of the product. Rebuilt so the panel document lives in its own
window and controls the window under test, the way Chrome actually arranges it, the bug does
not occur at all, with or without the fix.

Every previous release in this run named a cause I had reasoned my way to. This is the first
one where the evidence turned out to be manufactured by my own test, which is worse, and it
is why there is no fix here.

**Kept — the same-tab `onActivated` guard**

The panel now ignores `onActivated` for the tab it already believes is showing, and only
follows a genuine change. This is defensible hardening — a re-fire should never move you out
of a space you just chose — but it is **hardening, not the fix**, and it is labelled that way
because I have no reproduction that needs it.

**Added — a placement trace in the diagnostics dump**

The last 150 placement decisions the panel made, each with its reason: which tab, which
window, whether it inherited from an opener or took the window's showing-space, what it
chose, and every time the shown space changed and why. Also whether membership was trusted or
rebuilt from manifests at boot.

Ids and space ids only — no URLs, no titles. Same privacy shape as the rest of the dump.

To capture the bug: switch to Work, press ⌘T, watch it land in Main, then open
Settings → Diagnostics → Copy diagnostics **without closing the panel** and paste it into the
issue.
The `trace` array at the end will say which of us is wrong.

---

## 0.20.1 — two more ways a new tab landed in Main

0.20.0 removed the storage race, and my test for "a tab opened in a space stays there"
passed — because it opened tabs the way a *test* does. Reproducing it the way you do found
two more paths, both real, neither covered.

**Fixed — tabs the panel opens went to whichever window was focused**

Eight call sites used `chrome.tabs.create({ url })` with no `windowId`: the palette's
open-and-search rows, bookmark and history results, the web-search fallback, hover-card
links. From inside a side panel, "the current window" is **not reliably the window whose
tabs the panel is drawing** — the same trap `restoreCapture` already documents. A tab
landing in another window is then placed by *that* window's space, which reads exactly like
"it opened in the wrong space". They all target the panel's own window now.

**Fixed — a window whose panel is closed had nobody to place its tabs**

0.20.0 gave `onCreated` a `windowId` guard, because every open panel was placing every new
tab into **its own** active space. That was right, and it left a worse hole: if the panel for
that window happens to be closed, no listener claims the tab and it falls through to Main.

`placeNewTab()` now reads **the target window's** showing-space from storage rather than
using whichever panel happens to be listening. Correct in every case: any live panel answers
for the right window, and no window depends on its own panel being open.

**Added — Settings → Diagnostics → Copy diagnostics**

Dumps what SideRail actually believes: spaces and their manifest sizes, every rule and its
actions, and where each open tab is filed, per window. Hosts only — never full URLs or
titles, so pasting it doesn't hand over a browsing history.

I offered this two rounds ago and didn't build it. Three releases went on guessing at a
configuration I couldn't see, each fixing something real that wasn't the cause. If this
still misbehaves, that button ends the guessing.

---

## 0.20.0 — membership is one key per tab

Third attempt at the same report, and this time I reproduced both symptoms before touching
anything. They had one cause, and it was structural rather than a mistake in any single
function — which is why fixing individual functions kept not working.

**Membership lived in a single storage key that two processes wrote.**

`spaceOf` was one object. The panel read it, changed it and wrote the whole thing back. So
did the service worker's filing pass. There is **no atomic read-modify-write in
chrome.storage**, so any placement written between one writer's read and its write was
silently deleted — and the filing pass runs on **every tab creation and every navigation**.
The race wasn't rare; it fired constantly.

That explains both reports exactly:

- **A tab opened in Work appeared in Main.** The panel wrote the new tab's placement; the
  worker's pass, already holding a map from before that write, wrote its own version over
  the top. The placement was gone, and the panel's `|| MAIN` fallback drew it in Main.
- **Pinned tabs drifted back to Main.** Same mechanism, just more noticeable — a pin is the
  tab you notice in the wrong place.

**The fix: `sp:<tabId>` and `sph:<tabId>`, one key each.**

Two writers touching different tabs are no longer writing the same key, so they cannot
erase each other. Nothing writes a whole map any more, so nothing can delete a placement it
never knew about. `readMembership()` migrates the old single-object form the first time it
sees it, and `pruneMembership()` clears keys for tabs that no longer exist — per-tab keys
don't tidy themselves the way replacing a whole map did, and Chrome reuses tab ids across
restarts.

**Also fixed — every panel placed every new tab**

`tabs.onCreated` had no window guard. Each open panel placed the new tab into **its own**
active space, so a panel sitting in Main would file a tab you opened in Work into Main, and
whichever wrote last won. It now ignores tabs from other windows.

**Tests**

- The race, directly: writer A reads, writer B places a tab, A writes. Both survive — and
  the same check asserts that a whole-map write of A's stale view **would** have lost B's,
  so it fails if the storage shape regresses.
- Opening tabs while showing a space, with the worker's filing pass given time to run:
  all of them land in that space.
- Three older tests needed updating rather than fixing, because the storage shape they
  reached into no longer exists: "simulate a restart" now clears the per-tab keys, and the
  inheritance test picks an opener from the panel's own window, since the membership map
  now spans every window and Chrome drops a cross-window `openerTabId`.

**What I'd do differently**

Three releases, each fixing a real bug on the right code path, none of them the cause. What
finally worked was building a harness that reproduced your setup — a space, a pinned tab, a
filing rule, new tabs opening — and watching storage rather than reading code for a
plausible culprit. I had that harness by 0.19.2 and still only used it to confirm a
hypothesis instead of to go looking. Reproduce first, then read.

---

## 0.19.2 — the actual reason pinned tabs migrated

0.19.1 fixed a real bug and did not fix this one. Reproducing it properly found the cause,
and it was never about pinned tabs at all — pins were just where it showed first, because a
pin is the tab you notice in the wrong place.

**`rebuildMembership()` built the membership map from one window's tabs, then persisted it
over the whole map.**

`state.tabs` is the current window. `state.spaceOf` is browser-wide. The function replaces
the map and `persistMembership()` wrote it wholesale — so every boot deleted the placement
of every tab in **every other window**, permanently, with no second copy to recover from.
With two panels open they wiped each other's on every refresh. And once enough placements
were missing, the "same session or restart?" heuristic tipped over to *restart*, which
re-sorts everything by URL against the manifests — and anything not matched lands in Main.

Fixed in four places:

- **Membership is rebuilt from every window's tabs**, which is what it was always describing.
- **`persistMembership()` merges** instead of replacing. Two panels still race — one can be
  mid-refresh while the other writes — and a whole-map write from a momentarily incomplete
  view is unrecoverable. It now keeps stored entries for live tabs it has no opinion about.
- **`placeNewTab()` queues a manifest write.** A new tab's placement reached
  `storage.session` but never the durable record, so it was lost at the next restart.
- **Membership changed by someone else now queues one too.** The background filing engine and
  other windows' panels write `storage.session` directly; nothing was carrying that through
  to the manifest, so every automatically filed tab was one restart from Main.

**Tests**

A two-window case, which is what none of the pinned-tab tests had: file a tab in another
window, reload this window's panel, assert the placement survives. It fails on 0.19.1.

The Rewind snapshot test now waits for its tabs' URLs to actually land before capturing —
a tab still at `about:blank` isn't saveable and is excluded, so on a loaded machine that
test was measuring an empty snapshot rather than a bug. Two of the intermittent failures
I've been reporting were this.

**What I got wrong**

I shipped 0.19.1 having found *a* bug on the right code path and assumed it was *the* bug.
It wasn't, and you had to tell me twice. The lesson is in the method, not the code: 0.19.2
started by reproducing the failure end-to-end — pin, file, restart, second window — and the
cause was visible in the first run. I should have done that first.

---

## 0.19.1 — pinned tabs stop migrating to Main

**Fixed — a pinned tab filed into a space came back to Main on its own**

`rebuildMembership()` **replaces** `state.spaceOf` wholesale and then persists it. While
rebuilding it skipped pinned tabs:

```js
for (const t of state.tabs) {
  if (t.pinned) continue;          // ← left over from when pins were global
  state.spaceOf[t.id] = stored[t.id] || UNSORTED;
}
```

That line dates from before 0.13.1, when a pinned tab was global and had no space of its
own. Once pins became per-space it quietly destroyed them: every rebuild dropped each pinned
tab's placement, wrote the shortened map back to `storage.session`, and the panel's
`|| MAIN` fallback then drew the tab in Main. Because the rebuild runs on **every panel
boot**, a pin you filed into Work came back to Main the next time you opened the panel —
and the original placement was gone from storage, so nothing could recover it.

Pinned tabs are now included, like every other tab.

**Also fixed — the same-session heuristic counted the wrong things**

The decision between "same session, trust the stored map" and "restart, rebuild from the
manifests" compared the number of stored placements against the count of *unpinned* tabs.
In a window that is mostly pins that ratio drifts, and a wrong answer means a full rebuild
that re-sorts everything by URL. It now compares placements against all tabs.

**Added — pin chips carry `data-id`**

Tab rows always have, and the inconsistency is what made the first version of the
regression test measure nothing at all.

**A note on the test that nearly shipped green**

The UI half of this test — "is the pin drawn in Work's strip and not Main's" — passed
`undefined` as the tab id after an edit dropped an argument, so both halves were
`includes(undefined)` and the check was vacuous. It now asserts it is looking at a real id
before asserting anything about it. That is the third time a guard of this shape has earned
its place; if a check can pass by having nothing to look at, it will eventually do so.

---

## 0.19.0 — Rewind remembers your spaces

**Fixed — a snapshot recorded browser state, not SideRail state**

`captureWindow()` stored each tab's URL, title, pinned flag, muted flag and native group,
and nothing else. Not which space the tab was in, not the global-pin marker, not the spaces
themselves.

It *looked* like it worked, because `rebuildMembership()` re-sorts restored tabs by URL
against each space's **current** manifest. So membership was inferred from today's
configuration rather than remembered from the snapshot's — which fails silently in exactly
the cases you'd reach for Rewind:

- restore from before you deleted a space → every one of its tabs lands in Main, with
  nothing saying they used to be somewhere else;
- restore from before you reorganised a space → membership follows today's manifest;
- a global pin you have since un-globalled comes back as an ordinary tab.

**Now recorded:**

- **Which space each tab was in**, one short string per tab. Global pins need no special
  case — `*` is just another space id.
- **The spaces themselves** — id, name and emoji, not their URL lists. Enough to name one
  and offer it back, not a second copy of everything.

**And on restore:** if the snapshot refers to a space that no longer exists, you're asked
whether to **recreate it** or put those tabs in Main. Recreating **reuses the original id**,
because every tab in that snapshot records the old one and a fresh id would orphan exactly
what you're restoring. Restored tabs are marked as hand-placed, or the filing engine's next
pass would move them and undo the restore.

An id the snapshot never recorded — stale membership from a space that was already gone when
the snapshot was taken — is mapped to Main silently rather than offered back as a nameless
"Recovered space".

**Still not in a snapshot, on purpose:** rules, settings and the jump-bar order. Restoring
shouldn't resurrect a rule you deleted; Export data covers configuration. Rewind is a tab
time machine.

Restore still always opens a new window, so none of this can destroy what you have.

**Internal**

- New pure helper `missingSpacesIn(snapshot, liveSpaces)`.
- `makeLiveSpace()` accepts an `id`, used only on this path.
- `restoreCapture()` returns a `placed` list rather than writing membership itself — it
  touches no storage, and shouldn't start.
- The test deletes a space between capture and restore and proves the snapshot still knows
  its name and emoji, that a global pin round-trips, and that an unrecorded id is not
  offered back.
- `test/lint.js` earned its keep again: the new `missingSpacesIn` import didn't land when a
  patch script aborted early, and the linter named it rather than leaving a ReferenceError
  to surface at runtime.

---

## 0.18.1 — every emoji, one typeface, and a retraction

**Retracted — "fixed in Chrome 148"**

0.18.0 said the side-panel focus limitation was fixed in Chrome 148, on the strength of a
third-party product FAQ. **It isn't.** It still happens on Chromium 151. The claim is gone
from the panel, from Settings and from the README, and the code comment now says: don't put
a version number here again without a reproduction.

The limitation itself stands — an extension cannot move keyboard focus into its own side
panel — so the notice and the click-anywhere-to-type affordance remain the whole of the
answer. My apologies for passing on an unverified fix as fact.

**Fixed — the typeface setting only changed tab titles**

`--title-font` was applied to `.tab-row .title` alone, so choosing Serif left the space
names, captions, search field, footer and every dialog in the system font. A font setting
that changes half the text reads as a rendering bug, which is fair, because it was one. It
now applies to `body`, so everything inherits it. Two things keep their own family
deliberately: the rule-pattern box stays monospace, where alignment is the point, and emoji
render as emoji. The *size* slider remains tab-titles-only, which is what it says.

**Added — the whole emoji set, searchable**

Space emoji came from a hand-picked list of 40. Fine until the one you want isn't there.

- **1,897 emoji** in 9 groups, vendored from Unicode's own `emoji-test.txt` by a new
  `tools/build-emoji.mjs` — the same pattern as the Defuddle vendoring: run by hand, data
  rather than code, and the extension never makes the request itself.
- **Search by name.** Type `rocket`, `cat`, `red circle`. Every term must appear, and a
  word-start match outranks a mid-word one, so `car` leads with the car rather than
  `caricature`. `Enter` picks the first hit instead of submitting the dialog.
- The 40 suggestions still open the picker, so the common case needs no typing. Results cap
  at 240 tiles with a count, because rendering 1,897 buttons is slow and nobody scrolls
  that far.
- **Skin-tone and hair variants are excluded** — five copies of every gesture would bury
  everything else. The first pass at that filter missed 350 of them, because multi-person
  emoji list each participant's tone after a comma rather than a colon
  (`kiss: person, person, light skin tone, medium skin tone`). Caught by the test that
  counts them.

---

## 0.18.0 — the palette focus is Chrome's, not ours

**I was wrong about the cause, twice.** 0.16.0 and 0.17.4 both treated this as a race we
could win by asking for focus harder. It isn't. Instrumenting the real path settles it:

```
before shortcut:  hasFocus false, activeElement BODY
+200ms:           hasFocus false, activeElement pal-input, palette open
+1200ms:          hasFocus false, activeElement pal-input, palette open
after window.focus():  hasFocus false
```

`activeElement` is our input the whole time — the caret is exactly where it should be — but
`document.hasFocus()` never becomes true, so every keystroke goes to the web page. **Chrome
does not let an extension move keyboard focus into its own side panel.** `sidePanel.open()`
focuses the panel only when it was closed, which is why it worked *sometimes*: it worked
when the panel wasn't already open. `element.focus()` and `window.focus()` are no-ops from
inside a side panel, and there is no API for it.

This is a known Chromium limitation ([chromium-extensions
thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/nb058-YrrWc),
[w3c/webextensions#693](https://github.com/w3c/webextensions/issues/693)), reported fixed in
Chrome 148. It also explains the second report — the custom in-panel palette key "not
changing anything". It changes correctly; the keydown simply never reaches the panel.

**So: name it, don't fake it.**

- When the palette opens without keyboard focus it now says so across the top, quoting your
  Chrome version and what to do. A palette that silently swallows your typing is far worse
  than one that tells you where the typing went.
- **A click anywhere in the palette box** now puts the caret in the input, not just a hit on
  the 26px input itself — when that click is the only way to get focus, it shouldn't require
  aim.

**Fixed — Settings made the two shortcuts look like one**

They are labelled *Palette key — inside the panel only* and *Browser shortcuts — from any
page*, each saying plainly what it does and doesn't govern, with the focus limitation
written out underneath. There is also a **live test button**: click it, press your key, and
it lights up if the binding is right — so "the setting is broken" can be told apart from
"the key never reached the panel". Testing the key there no longer fires the palette over
the settings you're checking.

**Known flake**

Four checks in the duplicate-detection block (tracking-parameter twins) fail intermittently
on a slow machine and pass on a re-run. Timing in the scan, not a regression — noted here so
it isn't mistaken for one.

---

## 0.17.4 — the palette focus, properly this time

**Fixed — the palette still didn't reliably take the caret**

0.16.0 made the panel keep asking for focus until it got it. That was the right idea and
the wrong stopping condition: it **stopped at the first success**. Chrome hands the side
panel its focus some milliseconds *after* `sidePanel.open()` resolves, and whatever it
focuses then replaced the caret we had just placed. Winning the race once and stopping is
exactly how you lose it — and it explains the intermittency, because whether you won
depended on whether the panel was already open.

Two changes:

- The timed loop no longer exits early. It keeps checking across the whole 1.5s in which the
  panel might still be settling.
- A **`focusin` listener** on the document is the real backstop, and it holds indefinitely:
  whatever moves focus — the panel finishing its open, a stray click, Chrome focusing the
  body — if it lands outside the palette while the palette is up, it comes straight back.
  It lets go the moment the palette closes.

The test now steals focus four times at increasing delays, exactly as the browser does, and
asserts the caret returns each time — then asserts it is released once the palette closes,
so the panel doesn't become impossible to type in anywhere else.

**Fixed — the cog and the pinned tabs didn't line up**

The sticky block's content sat 4px from the right edge while the header sat 8px, so the
cog's right edge and the last pinned tile's right edge were 4px apart. Both are now 8px in
from each side, and the space switcher and group pills came into line with them.

**Added — text scaling is tested**

125% and 150% zoom, with the largest title size and wrapping on: no tab row overlaps the one
above it, a wrapped title doesn't run under the close button, and the footer, space switcher
and jump strip each stay on one row. All passing; the block guards against passing
vacuously by first asserting there are rows and close buttons to measure.

**Docs**

The README described 0.16.0 — the five-view nav, letter-square jump chips, the old footer,
Dedupe hidden-when-zero. Rewritten around the two shells, with the geometry suite documented
and the line-count claim corrected (~3135 → ~6400).

---

## 0.17.3 — focus rings, and the screenshot script again

- **`:focus-visible` now has a rule of its own**, once, for everything. Most controls in the
  panel set their own background or drop their border, which is enough to swallow the
  browser's default ring — and that ring is the only thing telling a keyboard user where
  they are. An outline with a positive offset sits outside the control's own paint, so
  nothing can hide it, in either theme. (The search field keeps showing focus through its
  accent border instead; a second ring around it was noise.)
- **`test/shot.js` was broken by the redesign** and had been failing silently on a timeout:
  it clicked a footer button that no longer exists, and reached Rules through a nav row
  that is now behind the cog. Fixed, and the dark-mode set is worth a look — the captions
  and pills hold up.

---

## 0.17.2 — one fewer line, two more pixels

- **The rule under the search field is gone.** Three separators inside 40px — that one, the
  space switcher's own line (removed in 0.17.1), and the sticky block's border and shadow —
  were two too many. The active space's blue underline ends that region well enough.
- **2px under the group pills**, so they aren't resting on the shadowed edge.

Net +1px. 210 against the 211 ceiling at 250 and 333, 178 against 179 at 400 — so the next
thing that wants height will have to argue for it, which is the point.

---

## 0.17.1 — the jump strip scrolls, and the header can breathe

**Changed — group jumps scroll sideways instead of hiding**

0.17.0 capped the strip at one row by hiding the overflow behind a `+N` menu. Scrolling is
simply better: it is the same gesture as the space switcher directly above, it costs no
click, and a group you can already half-see is a swipe away rather than two steps away.
The `+N` button and its measuring code are gone.

Pills no longer shrink to fit, either. Squeezing seven of them to their 54px floor so they
*nearly* fit gave the worst of both — unreadable stubs **and** a scroll. Each pill now
takes the width its name needs, capped at 108px so one long rule can't own the row.

**Changed — spacing in the header**

- 4px below the search field, before the rule, so the box isn't sitting on it.
- 4px above `Pinned in Main`.
- 4px above `↳ Jump to a group`.
- The grey rule under the space switcher is gone. The active space's blue underline already
  ends that row, and two horizontal lines 3px apart read as a mistake.

**On the vertical budget**

Those 12px had to come from somewhere. 7px came back from padding that was doing nothing —
above the search field, and between the header rule and the space switcher. The remaining
3px pushed past the old ceiling, so **`test/geometry.js` now carries a raised one**:
211/211/179 rather than 223/206/175.

That is recorded rather than quietly done, because raising a ceiling to make a test pass is
normally the wrong move. It isn't here: the redesign came in at 192px, well under budget,
and this spends some of that saving on deliberate breathing room. The test's job — catching
growth nobody asked for — is unchanged, and it still holds at every rule count.

---

## 0.17.0 — the redesign

Both stages. The everyday panel loses its persistent `Tabs / Spaces / Rules / Rewind / ⚙`
row, spaces become the one underlined switcher, the pinned and jump layers get named
captions instead of boxes, and management becomes a shell you visit rather than a fifth
tab.

**Changed — the everyday hierarchy**

- **Spaces are underlined text tabs**, 30px, one line, never wrapping. More spaces than fit
  scroll sideways rather than taking a second row. The scrollbar is suppressed with
  `scrollbar-width: none` and *no* `::-webkit-scrollbar` rule — declaring one puts Blink
  into classic-scrollbar mode, which reserves width permanently and beats the standard
  property. That is the 0.12.1 bug, and this is the door it would have come back through.
- **`Pinned in {space}`** and **`↳ Jump to a group`** name the two layers of small controls.
  Title case, 10.5px, sitting 2px above what they label and 9px below what precedes them —
  the asymmetric gap is what does the grouping, which is why neither layer needs a box.
- **Pinned tiles** are a responsive grid: they share the free width evenly and only wrap
  below 28px, so a narrow panel adds a row instead of clipping.
- **Group jumps are named capsules**, not coloured initials. `G` is only legible if you
  already know which G — and a pinned tile and a jump shortcut for the same service were
  otherwise the same small coloured square twice. Colour moved to a dot; the word carries
  the meaning; the capsule shape says "navigation, not a tab".
- The **window-actions `⋯`** moved from the pill row up onto the caption line. Its 28px was
  the difference between four group shortcuts fitting at 250px and only three, and the
  caption line beside it was empty.
- **The footer is three equal columns**, each an icon and a short label, always in the same
  order. **Dedupe greys out instead of vanishing** — three peers that come and go make the
  row a moving target.
- **Spaces management**: `Default` and `Showing` are separate badges, because Main is
  permanent whether or not you are looking at it and you can be looking at any space.
  Merging them would make each wrong half the time. The disabled `Always here` button is
  gone — a greyed button is still a button, and it implied a delete action existed
  somewhere.

### The vertical budget, with a test behind it

**Added — `test/geometry.js`, written before any of it**

The redesign's whole justification is a quieter everyday panel, and the first draft of the
spec would have made it 20–31% *taller* above the first tab. So the budget is now a test
rather than an intention. It measures the distance from the top of the document to the
first tab, with 12 pinned tabs, at three widths, across rule counts 0, 4, 5, 8 and 20:

| Width | Ceiling | 0.16.0 | 0.17.0 |
|---|---:|---:|---:|
| 250 px | 223 px | 223 | **204** |
| 333 px | 206 px | 206 | **204** |
| 400 px | 175 px | 175 | **172** |

The ceilings are measurements of 0.16.0, not aspirations, and they hold at *any* rule
count — the rule-count sweep exists because a budget that only holds at four groups is no
budget at all.

**Fixed — the jump strip grew a second row, and then a third**

Found by the new test, in the shipped build: at 20 rules the group-jump strip wrapped to
two rows at 333px and three at 250px, pushing the tab list down by up to 48px. It is now
capped at one row, measured rather than counted, with a **`+N`** button listing the rest by
name. Nothing becomes unreachable; it just stops costing a row. At least one shortcut
always stays on the strip — a row consisting only of "+20" would be worse than useless.

**Changed — browse and manage are shells, not five tabs**

- Browsing is not a peer of Settings. Modelling it as a fifth tab is what made the nav row
  spend permanent vertical space advertising four screens you rarely open.
- The everyday header is now the search field plus one **Manage SideRail** cog. The live
  tab count moved from the old Tabs button into the search field.
- The cog swaps the whole shell: back arrow, `Manage SideRail`, and exactly four sections —
  Spaces, Rules, Rewind, Settings. There is no Tabs section, because going back to tabs is
  going *back*.
- **Browse and management keep separate search text**, and each management section keeps its
  own filter. Carrying a rules filter into the tab list silently hides tabs, and nothing on
  screen would connect the two.
- Back restores the tab filter, the scroll position, and puts focus on the cog.
- The palette's Spaces/Rules/Rewind/Settings commands now enter management properly instead
  of calling `setView()` in isolation, which under the new shell would have shown a section
  with no way out.

**Changed — the icon, split in two**

- **`action.default_icon`** now uses newly drawn flat marks with a real alpha channel. A
  full-bleed opaque square reads as a sticker in a toolbar full of transparent glyphs, and
  the enamel tile at 16px was a smudge.
- **`icons`** keeps the rich Bauhaus Enamel tile for the extension-management page and the
  store, where it has room to be itself.
- A flat companion SVG ships in `icons/` for in-panel use at arbitrary DPI.
- Tested by decoding every icon in the extension's own context: sizes match their keys, the
  two families share no file, the toolbar set is genuinely transparent, and the enamel set
  is genuinely opaque.

**Internal**

- `openManage()` / `backToBrowse()` test helpers replace 19 hard-coded
  `.view-btn[data-view=…]` clicks, so the next structural change is one edit.
- The scrollbar-overlay test's forced viewport dropped from 260px to 200px tall: the shorter
  header meant the list stopped overflowing, and the "does it really overflow?" assertion
  added in 0.12.2 is what caught it. That guard has now paid for itself twice.
- `package.json` was stuck at 0.13.3; it tracks the manifest again.

---

## 0.16.0 — four things that were wrong

**Fixed — the palette needed a click before you could type**

- One `focus()` call is not enough. The panel may have been *created* by the very shortcut
  that opens the palette, in which case the call lands on a document that is still being
  set up; and a side panel opened by `sidePanel.open()` does not reliably hold keyboard
  focus straight away — the page you pressed the key on can keep it for a frame or two.
  Either way the caret ends up nowhere, which defeats the entire point of a shortcut.
- It now focuses immediately, again on the next frame, and then keeps asking for up to
  1.2s until the caret is really in the box — testing `document.hasFocus()` as well as
  `activeElement`, because the input can be "focused" in a document that has no keyboard
  focus at all, and then your typing goes to the web page. It also takes the caret back if
  the panel gains focus later while the palette is open.
- The test now parks focus elsewhere, fires the shortcut through the real worker message,
  and **types with no click in between**, asserting the characters land in the palette.

**Fixed — a rule's tab groups outlived the rule**

- Deleting a rule left the groups it had built standing, still holding their square in the
  jump bar, with nothing behind them. They are ordinary Chrome tab groups; nothing was
  taking them apart.
- Deleting a rule that currently holds tabs now asks: **delete and ungroup**, or **delete
  and keep the groups**. Ungrouping closes nothing — every tab stays open — and the
  jump-bar slot is released with it.

**Fixed — unticking "group them in the tab strip" left the group behind**

- Same cause. Switching grouping off stopped *new* groups being made but said nothing about
  the ones already on screen, so the setting looked ignored. It now takes them apart, and a
  full rules pass no longer rebuilds them.

**Added — rules that clash now say so**

- Two rules both mentioning github.com, one grouping as "Work" and one as "Code", produced
  a result neither of them described, with nothing on screen to explain it. Order has
  always decided — the first matching rule wins — but order was invisible.
- Each rule card now has **↑ / ↓**, and the losing rule carries a warning naming the rule
  beating it, how many open tabs it is losing, and a **"Put this rule first"** button.
- Only genuine clashes are reported. Two rules that would do the *same* thing agree rather
  than conflict, and a grouping rule and a filing rule over one tab **compose** — that is
  the whole point of a rule having two independent actions, and the tab gets both.
- Detected against the tabs you have open rather than by comparing patterns: whether two
  regexes can match the same string is not something to guess at, and a clash you cannot
  currently observe is not worth interrupting you for.

**Internal**

- New pure helper `ruleConflicts(rules, tabs)`, unit-tested for winner order, agreement,
  composition, filing-vs-filing clashes, disabled rules and rules that share no tab.
- 22 new checks, including the group teardown end-to-end (group made → grouping off →
  gone → rules re-run → still gone → back on → rebuilt → rule deleted → gone, with the
  tabs proven still open at each step) and the clash warning moving between cards when you
  reorder.

---

## 0.15.0 — the command palette

`Alt+K` / `⌘K` used to put the caret in the search box. It now opens a real palette: one
ranked list over tabs, spaces, commands, bookmarks and history, plus a top line that reads
what you typed as either a URL or a search.

**Added — the palette**

- **Sources in one list**, sectioned but ranked together: open tabs (every window, not just
  this one, each showing which space it's in), spaces to switch to, commands, and — if
  you've granted the optional permissions — bookmarks and history. Empty, it offers recent
  tabs and the commands you're most likely to want.
- **URL or search, decided rather than guessed.** `bbc.co.uk/news` leads with **Open**;
  `how do tab groups work` is a search with nothing to open. `bbc.co.uk news` is genuinely
  ambiguous, so it offers *both* — the site first, the search underneath, one arrow key
  apart.
- The detector is stricter than the omnibox on purpose, because a false "Open" is worse
  than a missing one: `v1.2.3`, `3.5`, `e.g.` and `someone@example.com` stay searches, while
  `localhost:3000` and `192.168.1.1` are places. `title:SideRail` and `note: buy milk` look
  like schemes but aren't, so they stay searches too.
- **A plain word never selects the web search.** Typing `exa` selects a tab you have open;
  pressing ↵ must not open a search engine for something already in front of you. The web
  search is always available, at the bottom.
- ↑/↓ (or `Ctrl+N`/`Ctrl+P`) move and wrap, `Home`/`End` jump, ↵ runs, `Esc` closes. It's an
  overlay, not a view — closing it leaves whatever you were looking at exactly as it was,
  scroll position included.
- Opening it while you're typing in the search box carries the text across.

**Added — a remappable palette key, and the truth about the other one**

Settings → **Keyboard** now has both halves of what "the shortcut" means:

- **Palette key in the panel** — ours, and settable right there. Click the field, press a
  combination. Stored as e.g. `Mod+Shift+P`, where `Mod` is ⌘ on macOS and Ctrl elsewhere,
  so one setting is right on both. A lone modifier or an unmodified letter is refused —
  a bare letter would make typing anywhere in the panel a minefield. Rebinding takes effect
  immediately, with no reload.
- **Browser shortcuts** — the chords that work from any page. **Chrome does not let an
  extension set its own shortcuts**; there is no API, deliberately, so a page can't steal a
  key from under you. So this reads the live bindings from `chrome.commands.getAll()`,
  shows them, and offers one button to `chrome://extensions/shortcuts`, which is the only
  place they can be changed.

**Changed**

- The worker now sends `open-palette` rather than `focus-search`. It still answers to the
  old name, because a service worker can outlive a panel reload.
- `Alt+K`'s manifest description is now "Open the command palette", which is what
  `chrome://extensions/shortcuts` shows you.

**Internal**

- `readIntent()` and `looksLikeHost()` are pure and unit-tested — 12 checks on the cases
  above, including the ones that must *not* be treated as URLs.
- 32 more checks: the palette opening from a real worker message (a page can't
  `sendMessage` to itself, so faking it from the panel would have proved nothing), arrow
  wrap-around, ↵ on a tab result switching rather than opening a second copy, Esc leaving
  the view underneath untouched, the in-panel key rebinding live, and a screenshot at
  `test/shots/palette.png` so a broken overlay is visible rather than merely untested.

---

## 0.14.0 — one kind of rule, with two things it can do

Until now SideRail had rules that made tab groups, and spaces you filed things into by
hand. This release joins them: **a rule is a match plus up to two actions** — *file into
this space*, and *group them in the tab strip*. Either may be blank. Nothing you had
changes: a rule saved before this release has no filing action and keeps grouping exactly
as it did.

**Added — file into a space**

- Every rule card now has a space menu ("File into") and a grouping checkbox. Setting both
  is normal and not a conflict: the tab lands in the space *and* in that space's own group,
  which is what "YouTube goes to Entertainment, inside a YouTube group" means. A card says
  in words what it will do, and says so plainly if you have switched both actions off.
- Filing happens **on events, not on a timer**: when a tab opens, when it navigates, and
  when it first gets a title after navigating. Settled tabs are never re-examined, so a tab
  that has found its home stays there.
- **The tab you are looking at is never filed.** The panel follows the active tab, so filing
  it would drag the whole panel into a different space mid-sentence. It waits until you
  leave.
- **A tab you moved by hand is never moved again by a rule.** Hand placements are recorded
  separately (`spacePinned`) and outrank every pattern. Deleting a space releases its tabs
  so rules can have another go at them, and clears the filing action from any rule that
  pointed at it.
- **"File open tabs now"** appears once any rule files, and sweeps the backlog — every open
  tab, including the active one, since you asked explicitly. The panel follows that tab to
  its new space rather than letting the page you are reading vanish from the list.

**Added — matching on the title, not just the URL**

- A pattern can name the field it reads: `title:SideRail`, `title:/^Inbox/i`, `url:github.com`.
  A bare pattern still means the URL, which is what every rule written before today meant.
- Everything else works the same on both fields — substrings, `*` globs, `/regex/i`. One
  exception, deliberately: `booking.com` matches the *host* when read against a URL, but a
  title has no host, so on a title it is plain text.
- One rule can mix the two (`title:invoice` + `stripe.com`); patterns are OR-ed as before.

**Changed — ⌘K opens the palette on macOS**

- Was ⌘⇧K. Worth knowing: **⌘K is taken inside Slack, Notion, Linear and GitHub**, and an
  extension shortcut wins over the page. If you use one of those daily, rebind it at
  `chrome://extensions/shortcuts`.

**Internal**

- New pure helper `planFiling(tabs, rules, spaceOf, opts)`, tested the way `assignSpaces`
  and `planRuleGroups` are: it decides, the worker acts. Filing runs before grouping in each
  pass, since which space a tab is in decides which group it lands in.
- Title changes are throttled per navigation. Sites that rewrite their title continuously
  ("(3) Slack") would otherwise trigger a pass per unread badge.
- 32 new checks, including the engine end-to-end through the service worker: a real tab
  navigating, membership changing with no panel involved, and the active tab and the
  hand-placed tab both staying put.

---

## 0.13.3 — the keyboard shortcuts were silently dead

**Fixed — this is why nothing happened when you pressed the shortcut**

- `chrome.sidePanel.open()` requires a user gesture, and **the gesture does not survive an
  `await`**. The command listener was `async` and awaited `currentWindowId(tab)` before
  opening the panel. That call resolves instantly when the tab already carries a windowId,
  but it still yields a microtask — enough for Chrome to consider the gesture spent. The
  panel then refused to open, with no error anywhere a user could see, so every shortcut
  did nothing at all. ([crbug 344767733](https://issues.chromium.org/issues/344767733))
- The listener is now synchronous and calls `open()` as its first statement. Everything
  that can wait, waits.
- A **static test** pins the rule: the listener must not be `async`, and nothing may be
  awaited before `sidePanel.open()`. It reads the shipped source and strips comments first
  — the first version was tripped by the comment explaining the rule.

**Added — macOS shortcuts**

- macOS has no Alt key, so `Alt+B`/`Alt+K`/`Alt+G` arrive as Option chords nobody would
  guess. macOS now gets **⌘⇧B** (open panel), **⌘⇧K** (palette) and **⌘⇧G** (group by
  domain).
- Still exactly **four** suggested shortcuts. A fifth is not ignored — the extension fails
  to load outright with "Too many commands specified". There's a test for that too.
- ⌘K is free in Chrome on macOS (the Ctrl+K omnibox binding is Windows/Linux only), but
  binding it would shadow ⌘K inside Slack, Notion, Linear and GitHub, where it is the
  near-universal palette key. ⌘⇧K avoids that. If you want ⌘K anyway it is one line, or
  assignable yourself at `chrome://extensions/shortcuts`.
- Note that the ID change reset any shortcuts you had assigned by hand — suggested keys are
  re-applied automatically, user-assigned ones are not.

## 0.13.2 — page access after the ID change

**The cause, which 0.13.0 should have warned about**

- Optional permissions belong to the extension's **identity**, not its folder. Pinning the
  ID in 0.13.0 therefore dropped the `<all_urls>` + `scripting` grant along with
  `storage.local`. The export/import instructions covered the data and said nothing about
  the permission — so previews fell back to drawing over the tab list, thumbnails stopped
  being captured, and page-text search went quiet, all looking like regressions.

**Added**

- **Settings → Page access**, with Grant and Revoke and a plain statement of what each
  costs. Previously the only way to grant it was a chip inside a page-text search result,
  which is nowhere near where you are when the preview misbehaves.

**Fixed**

- The fallback card printed its reason twice — *"Can't sit beside the panel — needs page
  access to sit beside the panel"*. The prefix comes from CSS, so the reason has to read as
  a continuation. A test now asserts it doesn't repeat the sentence.

## 0.13.1 — Main is a real space; pins are properly per-space

**Changed — Unsorted is now Main**

- It is a **first-class space**: first in the bar, first in the Spaces view, always listed,
  renameable, and never deletable. Everything starts there and you carve spaces out of it,
  rather than it being a bin for leftovers. Deleting a space returns its tabs to Main.
- **Main is now a move target.** It wasn't, which meant a tab could be moved out of Main
  and never back — an obvious gap that only shows up once you try it.

**Fixed — pinned tabs were not actually per-space**

- 0.13.0 treated an *unassigned* pinned tab as global, so every pin you already had showed
  in every space and the feature looked like it wasn't there. That default was mine and it
  was wrong: pinned tabs now follow exactly the same rule as every other tab, with no
  special case. An unassigned pin sits in **Main**, which is always visible, so nothing can
  go missing.
- Riding along in every space is **opt-in per pin** — right-click → *Pin in every space* —
  and a global pin carries a small dot so the two kinds are tellable apart at a glance.
- Worth stating plainly, because it can't be otherwise: there is only ever **one real tab**.
  Closing a pinned tab closes it everywhere. "Removing it from this space" means moving it
  to another one, not closing it.

**Fixed — two bugs the new restart test found**

- **A manifest could be wiped for a space with no live tabs.** After a restart that restored
  nothing — a dismissed crash prompt, or a browser set to open a New Tab page — the first
  debounced write would replace every saved list with an empty one, destroying the only
  record of what each space held. Delaying the write until membership was rebuilt did *not*
  prevent this, because membership would legitimately be empty. A space's list is now only
  overwritten once we have actually seen a live tab in it.
- **The showing space could outlive the space itself** — deleted in another window, or
  replaced by an import — leaving the panel filtering on an id nothing matches and drawing
  an empty list. It falls back to Main.

**Added**

- After membership is rebuilt on startup, one rules pass runs. The worker's auto-rules see
  restored tabs before any panel exists, so they file everything into Main's groups; this
  re-splits them into each space's own group without waiting for a tab event.

**Tests**

- **The restart path, end to end.** Clearing `storage.session` is exactly what a restart
  does to us — new tab ids, no membership, only the manifests left — so the test does that,
  reloads the panel against live tabs, and asserts every tab is matched back to its space.
  Both bugs above were found by writing it.
- A pinned tab shows only in its own space; a global one rides along and is marked.

## 0.13.0 — Spaces, for real this time

**⚠️ Read this before reloading: export your data first.**

This build pins the extension ID with a manifest `key`, which Chrome treats as a
**different extension** — new identity, empty `chrome.storage.local`. Rules, snapshots and
settings do not come across on their own.

1. On the **current** build: Rules view → **Export data**.
2. Reload the extension.
3. **Import data**.

If you forget: your old data still exists under the old ID. Delete the `"key"` line from
`manifest.json`, reload, export, put the line back, reload, import. Nothing is destroyed —
it's just addressed to a different name.

**Why pin it at all.** An unpacked extension's ID is a SHA-256 of its folder's absolute
path, so moving or renaming `SideRail/` silently orphans everything it has stored. That was
survivable when the stakes were a rule list. With Spaces it costs your whole tab
organisation.

**Added — Spaces**

- A **space is a label on a tab**, not a container. Switching makes **zero browser calls**:
  nothing is closed, moved, grouped or reloaded, so it is instant and cannot cost you a
  scroll position or a half-typed form. There is a test asserting every tab's id, index,
  URL and group are byte-identical across a switch.
- A **space bar** above the tab list: click to switch, drag a tab onto a chip to move it.
- The **Spaces view** manages them — create, rename, reorder, delete, and Reopen for tabs
  the browser didn't bring back.
- Right-click a tab → **Move to <space>**. Works on a multi-selection.
- New tabs inherit the space of whatever opened them, else the space you're in.
- **Unsorted** catches anything unassigned. A tab can never be lost by belonging to no
  space, which is the one outcome worse than being in the wrong one.
- The panel **follows the browser**: activate a tab from another space — Ctrl+Tab, the tab
  strip, a link — and the panel goes there with you. Chromium has no successor-tab API, so
  this is also what stops closing a tab stranding the panel somewhere you can't see.

**Pinned tabs**

- Pinned tabs are **per-space**, as in Arc. Chromium permits this because a space is a
  label: the rule that a pinned tab cannot join a native group binds Rules, not Spaces.
- A pinned tab you have **not** assigned shows in **every** space. Without that, every pin
  you already had would have vanished the moment spaces arrived — which is exactly what the
  first run of this did, and what the test suite caught.
- Right-click a pinned tab to switch between *Pin in every space* and *Pin to this space only*.

**Rules — one group per (rule, space)**

- A tab belongs to exactly one native group, so a single shared *Travel* group would put
  every space's Travel tabs in one collapsible unit with one shared collapse state. Each
  space now gets its own. Chromium allows it: two groups may carry the same title and
  colour, because group identity is an opaque token and the title is not a key.
- A tab in the wrong space's group is moved to its own on the next pass. Hand-made groups
  are still never touched.

**Surviving a restart**

- Tab ids do not survive a browser restart and Chromium has no `sessions.setTabValue`, so
  membership is **rebuilt** by matching each space's saved URL list against the order the
  browser restored tabs in. A URL one space claims goes there; a URL two claim follows the
  tab before it; anything unclaimed goes to Unsorted.
- Each space keeps an ordered **URL manifest** in `storage.local`, written on change and
  debounced. It is deliberately **not** written until membership has been rebuilt — writing
  earlier would overwrite every space with whatever the browser happened to restore, which
  after a dismissed crash prompt is nothing at all.
- The manifest is built from **every window**, not just this one. A space can hold tabs in
  two windows, and a per-window write would have erased the other's.

**Multi-window**

- A tab dragged into another window keeps its id, and therefore its space. The panel there
  follows it rather than letting it vanish.
- Another window's activity no longer moves this panel: the activation handler is gated on
  the window id.

**Migration**

- The old saved-snapshot Spaces become live spaces, with their saved tabs as the starting
  manifest. The legacy `workspaces` key is left untouched, so nothing is lost if this needs
  undoing.

## 0.12.3 — proving where the width goes

**Changed**

- The fallback preview card now states its reason **at the top**, as a strip above the
  thumbnail, rather than as a footnote below it. That card only ever appears when the
  preview can't sit beside the panel, and the reason was being missed under a thumbnail
  that draws the eye — so the card kept reading as a positioning bug.
- **Panel measurements** in Settings now report the document width, the window width, the
  list width, the list's gutter, *the document's* gutter, and the right padding. The window
  and document widths differ only if this document is reserving a scrollbar; if they match,
  any remaining strip belongs to the browser chrome around the panel.
- **Show edges** flashes a border on the exact edge of this document for three seconds. A
  channel inside that border is ours and fixable here; a channel outside it is the browser's
  and no extension can reach it.
- `scrollbar-width: none` also on `html`/`body`. `overflow: hidden` should already mean no
  document scrollbar, but a reserved one there would be invisible in the layout and would
  read exactly like a channel down the right-hand edge.

**Tests**

- Two new checks that would have caught this class of problem directly: the list spans the
  **full** width of the document, and the document reserves no scrollbar of its own.

## 0.12.2 — the popover over the panel was never the hover card

**Fixed — the real cause, after four attempts at the wrong thing**

- Tab rows carried a `title` attribute, which produces the **browser's own
  tooltip**: a plain two-line box with the title and URL. Native tooltips are drawn by the
  OS, so unlike anything this document can paint they **spill outside the panel and land on
  top of it** — and they appear a beat *after* the hover card, so a correctly-placed card
  beside the panel was still followed by a plain box over the rail a moment later.
- Every previous "preview position" fix — 0.9.0's docked-side detection, 0.10.1's fallback
  reasons — was aimed at a different popover. Those changes were real fixes to real bugs;
  they just weren't this one. The attribute is gone from tab rows; the hover card already
  carries the full title and the domain. It stays on text-hit rows and pinned chips, which
  have no card and where the tooltip is the only way to see the URL.
- A test now asserts no tab row carries a `title` attribute, so this specific thing cannot
  come back quietly.

**Fixed — the scrollbar channel, part two**

- `scrollbar-width` and `::-webkit-scrollbar` do not cooperate: **any** ::-webkit-scrollbar
  rule puts Blink back into custom-scrollbar mode and takes precedence over the standard
  property. 0.12.1 declared both, so two mechanisms were arguing and which one won depended
  on the build. Only `scrollbar-width: none` remains.
- The view's right padding drops from 6px to 3px. There is no scrollbar to clear any more,
  and every pixel there comes straight off the end of a tab title.

**Added**

- **Panel measurements** in Settings: panel width, list width, reserved scrollbar gutter,
  right padding. "There's still a channel on the right" can't be settled by looking — a
  reserved gutter, the view's padding and the panel's rounded edge all look the same. Now
  it's four numbers.

## 0.12.1 — the scrollbar stops taking a column

**Fixed**

- The list reserved **8px of width for a scrollbar at all times**, scrolling or not. The
  cause was styling it: touching `::-webkit-scrollbar` opts Blink into a *classic*
  scrollbar, which takes its width out of the layout permanently — unlike the overlay one
  macOS would otherwise draw over the content. On a panel Chrome won't let go below ~360px,
  that was a standing bite out of every tab title.
- The native scrollbar is now removed outright (`scrollbar-width: none`, plus a zero-width
  `::-webkit-scrollbar` for older Chromium), and a **thin overlay indicator** is drawn over
  the content while you scroll, fading out about a second after you stop. Chosen over simply
  un-styling the bar because that would still reserve space wherever the OS is set to always
  show scrollbars — this behaves the same everywhere.
- The indicator is positioned `fixed` against the panel rather than inside the scroller: a
  child of a scrolling box scrolls with it, and `position: sticky` would still occupy a
  column, which is the thing being reclaimed. It ignores pointer events, so it can't swallow
  a click meant for a row underneath.
- The sheet's scrollbar is now thin rather than 8px. It's a temporary overlay, so its gutter
  costs nothing permanent.

**Tests**

- The first version of this check passed while proving nothing: the harness gives the panel
  a large viewport, so the list never overflowed and every assertion about the indicator was
  vacuously true. The test now forces a realistic 360×420 panel and asserts the overflow is
  real before checking anything that depends on it.

## 0.12.0 — a footer that says what it can do

**Changed**

- **Dedupe appears only when there is something to dedupe**, and its label is the count:
  **Dedupe (4)** — four being the number of tabs it would actually close, every copy but
  the keeper. It tracks the tab strip live: open another copy and it goes to five, close it
  and it drops back, and it disappears entirely at zero.
- **Defuddle** and **archive.is** are buttons on the footer instead of items behind a **⋯**
  menu, with the shorter labels. They grey out when the tab in front of them isn't a web
  page, rather than offering something that would fail.
- The **Tabs** label carries the window's tab count — *Tabs (37)*.

**How the count stays honest**

- The grouping rule moved into `common.js` as `duplicateGroups()` / `duplicateCount()`, and
  the service worker's `find-duplicates` now calls it too. One definition of "the same
  page", so the number on the button can never promise four and then have the review sheet
  offer three.
- The count is deliberately **not** part of the render signature. Every URL and pinned flag
  is already in there, so anything that could change the count already forces a redraw —
  including it would mean parsing 130 URLs on every tab event just to decide to do nothing.

## 0.11.0 — page-text search stops waiting on tabs that can't answer

Your sweep read *"Scanned 128 tabs · 80 timed out"*. Almost all of that minute was spent
waiting on tabs that were never going to reply, at full price, six at a time.

**The cause**

- Chrome freezes idle tabs under Energy Saver. **A frozen tab runs nothing** — no timer, no
  event handler, no injected script. And `executeScript` does not reject for one: it
  **queues** the injection until the tab thaws, so the promise never settles either way and
  the only thing ending the wait is our own 4-second timeout
  ([w3c/webextensions#527](https://github.com/w3c/webextensions/issues/527)). Eighty frozen
  tabs × 4s ÷ 6 slots ≈ 53 seconds of doing nothing.

**Fixed**

- **Frozen tabs are skipped, not waited on.** `tab.frozen` (Chrome 132+) tells us before we
  start. They're reported as *asleep* so the number is visible rather than mysterious.
- **Concurrency 6 → 24.** Each tab runs the reader in its own renderer process; the panel is
  only holding promises. Six was throttling a queue with no contention to relieve.
- **Per-tab timeout 4s → 1.5s.** Affordable once the pathological case is excluded up front.
- **`injectImmediately: true`**, so a tab that is still loading doesn't sit behind
  `document_idle` burning the timeout.
- **Typing narrows the sweep.** A page with no occurrence of *exten* cannot contain
  *extension*, so once a tab is proven empty it is never opened again while you keep typing.
  Shown as *N already ruled out*. The shortcut is dropped the moment a query stops extending
  the previous one, and per tab on navigation or close.
- **A tab that times out is remembered** and left out of the next keystroke's sweep rather
  than re-paid for every time. **Rescan** forgets all of it and genuinely re-asks.
- The in-page walk budget rises 250ms → 400ms, so fewer results come back *truncated* — a
  trade that was only affordable once the waiting stopped.

**Fixed — a bug this exposed**

- `resetScan()` runs on every keystroke, and was wiping the learned page facts along with
  the run state. Those record something about *pages*, not about a query, so clearing them
  per keystroke made the narrowing worthless. They now survive typing, and are dropped per
  tab on navigation or close.

**Tests**

- The selection policy is now a pure function, `planScan()`, because the frozen case cannot
  be reproduced through a browser — nothing an extension can do freezes a tab on demand. It
  is checked directly against synthetic tabs: frozen, discarded, `chrome://`, excluded,
  already-ruled-out, and timed-out.
- `bh.js` runs a real sweep and asserts it completes, reports itself, and that a longer
  query re-opens fewer tabs than the shorter one did.

## 0.10.1 — the hover card explains where it is

**Fixed**

- The preview card sits beside the panel by drawing itself **into the tab you are looking
  at** — the only surface next to the panel, since a side panel cannot paint outside its own
  frame. When that tab is a `chrome://` page, an extension page, the Web Store, a `file:`
  URL or a suspended tab, injection is refused and the card falls back to drawing inside the
  panel, over the list. That fallback was **silent**, so it read as the positioning having
  broken again rather than as a page that can't be drawn on.
- The fallback card now states the reason on its last line — *"Beside the panel: the open
  tab is a chrome:// page, which blocks overlays — switch to a normal page"*. Same for a
  missing page grant, a suspended tab, and a page that refuses the overlay.
- The page grant was read **once at startup**. Granting or revoking it anywhere else — in
  another window's panel, or from `chrome://extensions` — left this panel believing the old
  answer until it was reloaded, which could strand it on the fallback permanently.
  `permissions.onAdded` / `onRemoved` now keep it current.

**Tests**

- Every previous hover check drove `PAGE_CARD` directly, which proved the card *draws* but
  never that the panel *reaches for it*. `bh.js` now hovers a real row with a real mouse and
  asserts which of the two cards appeared — and that the fallback explains itself when the
  active tab is a `chrome://` page. That gap is exactly why this reached you twice.

## 0.10.0 — Settings

**Added**

- A **cog** to the right of Rewind opens a **Settings** view:
  - **Text size** of tab titles, 11–18px.
  - **Font** — System, Sans, Serif, Mono, or **Custom**, where you type the name of any font
    installed on the machine. A live preview shows whether the name took.
  - **Wrap long titles** onto a second line instead of truncating. Rows that need the second
    line grow; the rest stay as they were.
- A preview pane below the controls, with a deliberately long title, so the difference
  between truncating and wrapping is visible without leaving the view.
- **Reset to defaults**, which touches only the appearance keys and leaves the rest of
  `settings` alone.

**How it works**

- The settings drive **CSS custom properties** rather than restyling rows, so a change costs
  one style recalculation and never rebuilds the list — instant with hundreds of tabs, and
  no row loses its scroll position or drag state.
- They live in the existing `settings` key, so they ride along with Export / Import instead
  of being a separate thing to back up. Values are clamped on read, so a hand-edited or
  imported file can't produce an unreadable panel.
- A hand-typed font name ends up inside a CSS property value, so it is stripped of the
  characters that could end the declaration and then quoted.
- The search box hides in Settings — nothing there is searchable, and a box that does
  nothing reads as broken.

**Fixed — in the test tooling**

- `test/lint.js` blanked string literals before regex literals, so a regex containing a
  quote — like the font-name sanitiser — looked like the start of a string, swallowed the
  rest of the file, and made every export after it appear to vanish. It reported six
  confident, entirely fictional "does not export it" failures.
- Regex literals are now blanked first, and a **blind-spot check** compares the exports
  found before and after literal-stripping: if stripping loses one, the linter reports
  *itself* as the fault and keeps the name, so a broken scanner can never again invent
  missing-export failures. Verified by planting a regex the heuristic can't see.

## 0.9.3 — rename a group, and the rule behind it

**Added**

- **Right-click a group heading → Rename group…**
- If that group was made by a rule, **the rule is renamed too**, and the dialog says so
  before you commit. Renaming only the group would be silently undone: the next rules pass
  looks for a group titled after the rule, doesn't find one, builds a fresh group with the
  old name and moves these tabs back into it.
- The jump-bar order is keyed by group **name** — Chrome regenerates group ids on restart,
  so an id-keyed order would reset every morning — which means a rename would have dropped
  the chip to the end of the bar. The saved position now follows the new name.

**Fixed**

- Dialog messages are set as HTML, and user-typed names were interpolated into them raw.
  Names now go through an escape helper.

## 0.9.2 — recovering pinned tabs from Rewind

**Added**

- **Re-pin N tabs** on any Rewind snapshot that holds pinned tabs: pins them back into the
  current window without dragging the whole snapshot along with them. Nothing is closed,
  and anything already open here is skipped, so pressing it twice can't give you two of
  everything.
- Snapshots have always recorded pinned state — `takeSnapshot` captures whole windows —
  so pinned tabs lost while 0.9.0's spaces were dropping them are recoverable from the
  rolling buffer rather than rebuilt by hand.

## 0.9.1 — Spaces back in the view bar; sharper previews

**Changed — Spaces is a view again, between Tabs and Rules**

- The dropdown at the top of the panel is gone. Spaces is a view like Tabs, Rules and
  Rewind, and each space is a card: emoji, name, tab count, pinned count, when it was last
  saved, and buttons for Open / Add to this window / Update / Rename / Delete. The search
  box filters spaces by name.

**Fixed — a space no longer drops your pinned tabs**

- `captureWindow` was called with `includePinned: false`, left over from the switcher,
  where pinned tabs were window furniture that had to survive a switch. As a snapshot that
  was wrong: opening a space gave you a window with no pinned tabs, and it looked like they
  had disappeared. Spaces now save pinned tabs and restore them pinned.

**Fixed — opening the same space twice**

- Opening a space that is already open now goes to that window instead of making a second
  copy of the same tabs, which then drift apart. A window opened from a space is marked
  **THIS WINDOW** on its card, so it's visible which space you're in — the thing the 0.9.0
  header lost when it started showing a count instead of a name.
- The binding is session-only and is picked up across windows: another window's panel
  opening a space updates this one, via a `chrome.storage.onChanged` listener for the
  session area rather than only `local`.

**Fixed — blurry hover thumbnails**

- Three things compounded. The screenshot was captured as a **JPEG** and then re-encoded as
  a JPEG, so it carried two generations of artefacts; it was stored **320px wide** and drawn
  at 320 CSS px, which is half the pixels a 2x display needs; and it was re-encoded at
  quality 0.6.
- Now captured as a **PNG** (lossless, and thrown away immediately), stored at **640px** —
  2x the card — at quality 0.78, with high-quality downscaling. Roughly 40–70 KB each,
  against 10–25 KB before.
- The cache cap becomes two caps: the newest **50**, *and* a **4.5MB budget**, measured on
  the stored base64 string. `storage.session` has a hard 10MB quota, and a count alone could
  sail past it and start failing writes silently.

## 0.9.0 — switching retired; the hover card finds the right edge

**Changed — Spaces are saved snapshots again**

- **Switching is gone.** A space is a saved set of tabs and nothing else. Clicking one
  opens it in a new window; **＋** adds its tabs to the window you're already in. Neither
  closes, replaces or reloads anything.
- **Right-click → Replace this window… is removed**, along with the active-space tracking
  behind it (`activeSpace:` and `spaceWindows` session keys, and the ✓ on the current
  space). No space is "the one you're in" any more, so the button reads *Spaces · N*.
- **Update from this window now asks first.** Overwriting a space's saved tabs is the only
  destructive act left in the feature, so it no longer happens on a single click.
- Deleting says plainly that nothing open is closed, and no longer offers to close tabs.

**Why**

- Both buildable switchers were unliveable: swapping a window's contents means closing and
  reloading (slow, and scroll position and form state are lost), and a window per space
  means living across many windows. Keeping tabs alive *and* hidden *and* in one window
  needs `tabs.hide()`, which **Chromium does not have**. Rather than ship a third
  compromise, the ambition is dropped and the feature does one thing reliably.

**Fixed — the hover card appeared on the far side of the screen**

- The in-page preview worked out which edge to hug by comparing `window.screenX` between
  the panel and the page. Chrome reports the **browser window's** left edge for *both*, so
  the comparison returned the same answer whichever side the panel was docked on, and the
  card always pinned itself to the right of the screen instead of beside the panel.
- The panel now derives the docked side from the **cursor's** screen position, which comes
  from the OS event and is genuine, measured against the window's own rect, and tells the
  page which edge to use. Vertical alignment is derived the same way instead of from
  `screenY`.

**Tests**

- The in-page card checks had been reporting *skipped* since 0.7.0 and had therefore never
  run: the test runner has no network, so every page was really a `chrome-error://` page,
  which cannot be injected into. The suite now serves one page from a local HTTP server,
  and those checks run — 32 in `bh.js`, up from 21.
- `dockSide()` is a pure function with its own checks, including a window away from the
  screen origin and a panel wider than half its window.
- The flicker budget was a flat mutation count, which scaled badly as the suite's tab count
  grew. It is now two checks: **zero** row insertions or removals (the actual guarantee),
  and an incidental-churn budget proportional to the number of rows.

## 0.8.1 — spaces stop closing tabs (fixes 0.8.0)

**Fixed — 0.8.0 was destructive and should not have shipped that way**

- **Creating a space immediately switched to it**, which closed the current window's tabs.
  Creating a space now touches nothing: it is added to the list, empty, and opens only
  when you click it.
- **Clicking a space no longer replaces the current window.** It opens the space in its own
  window, or focuses that window if it is already open — instantly, with tabs still live.
  Nothing is closed and nothing reloads.
- Tabs that refused to close during a 0.8.0 switch (pages with `beforeunload` handlers)
  were left behind and then re-grouped by the rules, which is what made a new space appear
  to have inherited tabs and rule groups.

**The reason for the redesign**

- In-window switching required closing and reloading, which is slow for a large space and
  loses scroll position and form contents. `chrome.tabs.hide()` — how Firefox extensions
  park tabs out of sight — **does not exist in Chromium**. Vivaldi can do it because
  Vivaldi is the browser. A window per space is the only way to keep tabs alive, and it is
  instant.

**Kept, but explicit**

- The destructive path survives as **right-click → Replace this window…**, behind a warning
  stating how many tabs it closes and that scroll position and form contents are lost.

## 0.8.0 — Spaces as a Vivaldi-style switcher

**Changed**

- Spaces moved out of the view tabs into a **dropdown at the top of the panel**, showing
  emoji, name and tab count per row, with the current space ticked. Views are now
  Tabs / Rules / Rewind.
- **Clicking a space switches the current window** rather than opening a new one. A **⧉**
  button on each row opens it in a new window instead.
- Spaces reorder by dragging the **≡** grip, and the order persists.

**Added**

- Emoji per space, chosen at creation and changeable later.
- Right-click a space: Rename, Change emoji, Update from this window, Open in a new
  window, Delete.
- A promise-based dialog component, because `confirm()` can't offer three options and
  several of these decisions genuinely have three.

**Safety, since switching closes tabs**

- The **outgoing space is auto-saved** before switching, so switching back and forth
  loses nothing.
- If the window belongs to no space, switching **asks** — save first, switch anyway, or
  cancel — instead of silently closing unsaved tabs.
- Switching replaces only tabs a space could have saved. **Pinned tabs** are left alone as
  window furniture, and **`chrome://` / extension pages** are never closed, since a space
  can't restore them.
- Deleting warns with the real consequence, and offers *keep tabs open* vs *close them*
  when deleting the space you're currently in.

**Known difference from Vivaldi**

- Vivaldi keeps a workspace's tabs alive in the background; these are snapshots reloaded
  from URLs, so scroll position, form state and playing media don't survive a switch.
  Keeping tabs alive needs browser-level control no extension has.

## 0.7.0 — hover previews

**Added**

- **Hover card** on tab rows: full untruncated title (up to three lines), domain,
  page thumbnail, and state chips — pinned, suspended, playing audio, muted, group,
  last seen, and the age of the screenshot.
- **Thumbnail cache** in `chrome.storage.session` (memory-backed, wiped on browser
  restart, never written to disk). Self-tidying five ways: one record per tab
  overwritten in place, removed when a tab closes, invalidated on navigation,
  orphans swept, and capped at the newest 80. Images downscaled to 320px, ~10–25 KB.

**Not built, deliberately**

- **Per-tab RAM.** No stable API exists. `chrome.processes` is Dev-channel only;
  `chrome.debugger` shows a permanent "started debugging this browser" banner and
  covers one tab at a time; `performance.memory` reports only the JS heap, excluding
  the DOM, images and video that usually dominate. A wrong number is worse than none.

**Known limitation**

- `captureVisibleTab` can only photograph the *active* tab, so thumbnails exist only
  for tabs visited since the browser started. The card says so rather than showing an
  empty box.

## 0.6.3 — dedupe ignores tracking parameters

**Fixed**

- Duplicate detection compared raw URLs, so
  `github.com/obra/superpowers?utm_source=…` and `github.com/obra/superpowers`
  were treated as different pages. `normUrl` now drops tracking parameters (all
  `utm_*`, ad click ids, newsletter tokens, referral params), sorts the remainder so
  `?a=1&b=2` matches `?b=2&a=1`, and trims a trailing slash.

**Guarded against over-matching**

- Meaningful parameters survive — `youtube.com/watch?v=…` still distinguishes videos.
- Fragments that look like client-side routes (`#/inbox`) are kept; only decorative
  ones are dropped.
- Each row shows which parameters were ignored, so a match is always explainable.
- The keeper now prefers the **cleanest** URL, so a newsletter link loses to the tidy
  copy already open.

## 0.6.2 — context menu stopped vanishing

**Fixed**

- Right-click menu appeared and disappeared within ~150ms. The 0.4.2 dismissal fix
  polled `document.hasFocus()` and hid the menu when false — but **Chrome routinely
  never gives a side panel focus at all**, so it was false from the moment the menu
  opened. Dismissal now keys off a focused → unfocused *transition*, never the
  absolute value.
- Added pointer-away dismissal (1.2s) and an 8s cap, because a click landing in the
  web page raises no event a side panel can observe.

## 0.6.1 — favicon alignment

**Fixed**

- Tab titles looked aligned to the bottom of the favicon. The icon sat in an unstyled
  `<span>`, which is an *inline* box and so reserved descender space below the image:
  21.19px of box around a 16px icon, pushing it 2.59px high. The slot is now an exact
  16×16 grid.

## 0.6.0 — renamed to SideRail

**Changed**

- Renamed from Navigator throughout: manifest, UI, docs, error stamps, the snapshot
  alarm and internal DOM markers. The `navigator` **Web API** was explicitly excluded —
  a blind find-and-replace would have broken Copy URL.
- **Storage keys deliberately unchanged** (`workspaces`, `snapshots`, `rules`,
  `settings`, `groupOrder`), so existing data imports without translation.
- Moved out of Dropbox to a plain local folder and into a private Git repository.

**Added**

- **Export / Import** for all stored data, in the Rules view and the overflow menu.
  Import accepts both this app's export format and a raw `chrome.storage.local` dump,
  so backups from older builds restore without editing.
- `.gitignore` (blocks junk, keys, `.env`, backups, screenshots) and `package.json`
  with test scripts. Tests now find a browser via `CHROME_BIN` instead of a hardcoded
  path.
- Rename guards in the test suite: manifest name, zero "Navigator" in shipped code,
  `navigator.*` Web API still present, storage keys unchanged.

## 0.5.0 — jump-bar reordering

**Added**

- Drag to reorder the group-jump chips. Order persists, keyed by **group name** rather
  than group id — Chrome regenerates group ids on restart, so an id-keyed order would
  silently reset each morning.
- Group, Ungroup and Save moved into a right-justified **⋯** menu on the jump bar,
  alongside Apply rules and Reset order. The bar renders even with no groups, so those
  stay reachable.

**Fixed**

- Changing a rule's colour did nothing once its tabs were already grouped: `applyRules`
  only called `tabGroups.update()` for groups it was *moving tabs into*, so a pass that
  moved nothing skipped the colour. Colour is now synced on every pass.

## 0.4.2 — version-stamped errors

**Added**

- Uncaught errors and unhandled rejections in both the panel and service worker are now
  stamped `[SideRail vX.Y.Z]`. `chrome://extensions` keeps errors until cleared and
  renders source context from the file *currently on disk* against the line number
  recorded *then* — so a stale error points at unrelated code. The stamp makes stale
  entries obvious.

## 0.4.1 — the silent search failure

**Fixed**

- Bookmarks *and* history both returned nothing. `searchExtras` called `normUrl()`
  without importing it; the ReferenceError rejected the whole function, so bookmarks
  computed before the throw were discarded along with history. Inside an async callback
  it surfaced only as `Uncaught (in promise)` in the extension error list, with no
  symptom in the UI.

**Added**

- `test/lint.js` — a static check comparing each file's imports against `common.js`'s
  exports in both directions, so this class of bug fails the build. Verified by
  reintroducing the exact bug.

## 0.4.0 — group jump bar

**Added**

- Sticky **group-jump bar**: one coloured square per tab group, labelled with the first
  letter. Click to scroll to the group and switch to its most recently used tab — or
  just scroll, if you're already in it.

**Fixed**

- Page-text scanning took >10s on heavy pages. The `NodeFilter` callback crossed into JS
  for every text node; filtering inline took an 80k-node page from seconds to ~150ms.
  Added a 250ms in-page budget and a 4s per-tab timeout, since `executeScript` queues
  behind the page's own main thread.
- Bookmarks and history now query independently and defensively, re-check the permission
  per search, and surface API errors in the UI instead of failing silently.

## 0.3.0 — page text, Defuddle, versioning

**Added**

- **Page-text search** across open tabs, behind a one-time optional `<all_urls>` grant
  with a Revoke button in the panel. No persistent content scripts. Six tabs at a time,
  suspended tabs skipped unless asked, cancellable.
- **Defuddle** reader view and **archive.is**, sharing that same grant. Defuddle is
  pinned and vendored — MV3 forbids remotely-hosted code — with a one-command updater
  at `tools/update-defuddle.mjs`.
- Bookmark results show their folder path; history searches far deeper with *Show N more*.
- Pinned tabs drag to reorder.
- Version numbering introduced, shown in the Rules view and in the release filename.

## 0.2 (as delivered — manifest was not bumped)

The build that prompted version numbering: it shipped as "v0.2" while `manifest.json`
still read `0.1.0`, which made builds indistinguishable.

**Fixed**

- Pinned strip made sticky.
- Tab list flicker: rows are now keyed and reused, with a render-signature short-circuit
  and `onUpdated` filtered to rendered properties. Repeated updates went from hundreds of
  DOM mutations to zero.
- Search returned nonsense: a plain subsequence matcher matched "supercharge" inside
  unrelated GitHub URLs. Replaced with host → title → URL → initials ranking, with
  constrained subsequence matching as a last resort on the title only.
- The × and row activation now fire on `pointerdown`. A re-render between mousedown and
  mouseup moves the node and cancels the `click` outright — the cause of "sometimes it
  does nothing".

**Added**

- **Rules**: named, coloured, pattern-matched tab groups applied automatically. Bare
  domains match host and subdomains; globs and regexes supported. Hand-named groups are
  never touched, and a second pass is a no-op.
- **Dedupe now reviews** rather than closing on its own — a sheet listing every copy with
  a suggested keeper, pre-ticked, and Cancel closes nothing.

## 0.1.0 — first build

Vertical tab list with groups and a pinned strip, Spaces (save/restore windows), Rewind
(rolling five-minute snapshots, last 50), Alt+K command palette, Alt+G domain grouping,
multi-select with bulk actions, drag-to-reorder, and a context menu.

Five permissions, no host access, no content scripts.
