# Privacy

SideRail runs entirely inside your browser, on your computer. This note says what it
keeps, where, and what it never does. It is written from the code, and the
parts that can be enforced by a test are: `test/lint.js` fails the build if any shipped
file makes a network call or opens a database, and `test/e2e.js` checks that nothing read from
a page reaches the data Export carries.

## What is stored, and where

| What | Where | Notes |
|---|---|---|
| Spaces, rules, Rewind snapshots, settings, jump-bar order | `chrome.storage.local` | A snapshot holds the addresses and titles of the tabs that were open; the last 50 are kept. This is what **Export data** writes out and **Import data** reads back. |
| Which space each tab is in; hover-preview thumbnails | `chrome.storage.session` | Memory only, wiped when the browser closes. Thumbnails never touch disk and are capped at 50 images and 4.5 MB. |
| Text read by page-text search | the panel's memory, only while the panel is open | Never written to disk. See below. |

Nothing is put in `chrome.storage.sync`, so nothing follows you to another computer.

## Page-text search

Searching inside pages means reading the visible text of a tab, and that needs **page
access**: the optional `<all_urls>` and `scripting` permissions. They are not granted at
install. The first time you use a feature that needs them the browser asks once, for all
sites, and you can take the grant back in Settings → Page access or on the extensions
page. There are no content scripts: a small reader is placed in a page only to read it,
hands back text, and is gone.

**When pages are read.** When you search, the open tabs that have not been read yet are
read, once each. Tabs the browser has put to sleep are read only if you press the button
that wakes them. Nothing is read while you are not searching.

**Where the text goes.** Into the panel's memory, and nowhere else. It is never written to
disk, never put in `chrome.storage`, and is gone when the panel closes. Versions 0.23.0 to
0.25.0 kept read pages in an IndexedDB database so a closed page could be found again;
0.26.0 removed that feature and deletes the database the first time it runs. The build
fails if shipped code opens IndexedDB for any other reason.

**Redaction, before anything is held.** Card numbers that pass the Luhn check, IBANs, UK
sort-code-and-account pairs, UK National Insurance numbers and US Social Security numbers
are replaced with a marker before the text enters memory. Email addresses, names and
everything else on the page are kept as they are.

**What is never read.** Each of these is checked before a page is read, and a rule you add
applies at once.

- A built-in list of about 18,000 sites: banks, card issuers, insurers, webmail, personal
  messaging, dating, payment services, health services, password vaults and government
  services. It is built from the UT1 blacklists (CC BY-SA) with additions, and ships inside
  the extension; nothing is looked up anywhere.
- Any host whose first label is a sign-in or account word: `accounts.`, `login.`,
  `myaccount.`, `auth.`, `checkout.`, `billing.` and the like.
- Search-engine results pages, which are your search history rather than a page you read.
- Any address that carries a password, token, OAuth code, signature or similar credential.
  This one cannot be switched off.
- Every page in a space you have marked **Private**.
- Your own patterns, in Settings → Pages that are never read.
- Pages that ask not to be: `noindex`, a login form, a payment form.

The built-in list and the host and search-page rules share one switch in Settings; the
results say which tabs were not read and why.

## What SideRail never does

- It makes **no network requests of its own**. No analytics, no telemetry, no crash
  reporting, no update check. The build fails if that changes.
- The only requests it can cause are tabs you ask it to open, each a visible click: the web
  search at the bottom of the command palette (DuckDuckGo unless you change `WEB_SEARCH` in
  `sidepanel.js`), **Open in archive.is**, and the Releases and Report a problem links under
  Settings → About, which go to GitHub.
- The reader view (Defuddle) runs on the page's own HTML, locally. The vendored library
  contains code paths that could fetch from third-party sites; SideRail calls only its
  synchronous parser, and the test suite fails if that changes.

## Permissions

| Permission | Why |
|---|---|
| `tabs`, `tabGroups` | Read and manage the tab strip and native tab groups. The whole point. |
| `sidePanel` | Draw the panel. |
| `storage` | Keep spaces, rules and snapshots. |
| `alarms` | The five-minute snapshot timer. |
| `bookmarks`, `history` (optional) | Search them from the command palette, only if you grant them. |
| `scripting` + `<all_urls>` (optional) | Page-text search, hover-preview thumbnails and the reader view, only if you grant them. |

There is no `host_permissions` key and no `content_scripts` key in the manifest.

## Diagnostics

Settings → Advanced → **Copy diagnostics** puts a JSON report on your clipboard for bug
reports: the version, your space and rule names, and, for every open tab, its site name
and which space it is in. Titles and full addresses are not included, but the list of sites
is yours to read before you paste it anywhere.

## Removing everything

Closing the panel drops everything page-text search read. Uninstalling the extension
removes everything else it stored: the browser deletes an extension's storage with it.

## Questions

Open an issue on the repository. For anything that looks like a way to read or send data
that should not be readable or sent, see `SECURITY.md`.
