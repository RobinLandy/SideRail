#!/usr/bin/env node
/**
 * Build vendor/exclusions.js — the sites whose pages SideRail must never read.
 *
 *   node tools/build-exclusions.mjs           # report only
 *   node tools/build-exclusions.mjs --apply   # fetch, build, write
 *
 * Page-text search (and the index behind it) reads the visible text of open
 * tabs. Some tabs must never be read: webmail, banks, personal messaging,
 * payment, health portals, password vaults. Nobody can enumerate those by hand,
 * so the base comes from the UT1 blacklists — the categorised domain lists the
 * Université Toulouse Capitole has maintained for school and workplace web
 * filters since the 1990s (CC BY-SA; see THIRD-PARTY-NOTICES.md). They are
 * French-run, so UK banks and several big webmail providers are missing;
 * ADDITIONS below fills those in, and KEEP lists team tools that a category
 * would otherwise sweep up.
 *
 * Categories deliberately NOT used:
 *   financial — turns out to be finance *information* sites (stock news,
 *               literacy courses): pages a person might well want to recall.
 *   gambling  — 32,000 domains; too heavy to ship for the benefit. A gap.
 *   adult     — millions of domains. A gap. The user list is the answer.
 *
 * Data, not code, like vendor/emoji.js. Shipped inside the package; no
 * runtime download, ever.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'vendor', 'exclusions.js');
const MIRROR = 'https://raw.githubusercontent.com/olbat/ut1-blacklists/master/blacklists';
const CATEGORIES = ['bank', 'webmail', 'chat', 'dating'];

/** Team tools that UT1's "chat" category lists but which people want indexed. */
const KEEP = new Set([
  'slack.com', 'discord.com', 'teams.microsoft.com', 'zoom.us', 'meet.google.com',
  'gitter.im', 'matrix.org', 'element.io'
]);

/** What UT1 does not know about. Edit freely; this file is the source of truth. */
const ADDITIONS = {
  webmail: [
    'mail.google.com', 'gmail.com', 'outlook.live.com', 'outlook.office.com',
    'outlook.office365.com', 'mail.proton.me', 'proton.me', 'app.hey.com', 'hey.com',
    'mail.yahoo.com', 'fastmail.com', 'icloud.com', 'mail.zoho.com', 'tuta.com', 'tutanota.com'
  ],
  messaging: [
    'web.whatsapp.com', 'whatsapp.com', 'messenger.com', 'web.telegram.org', 'telegram.org',
    'signal.org', 'web.wechat.com', 'wechat.com', 'chat.google.com'
  ],
  bank: [
    'barclays.co.uk', 'lloydsbank.com', 'lloydsbank.co.uk', 'monzo.com', 'starlingbank.com',
    'firstdirect.com', 'chase.co.uk', 'rbs.co.uk', 'co-operativebank.co.uk',
    'metrobankonline.co.uk', 'virginmoney.com', 'bankofscotland.co.uk', 'wise.com',
    'ulsterbank.co.uk', 'aib.ie', 'bankofireland.com', 'tide.co', 'atombank.co.uk',
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com',
    'usbank.com', 'ally.com', 'schwab.com', 'fidelity.com', 'vanguard.co.uk', 'vanguard.com',
    'hl.co.uk', 'ajbell.co.uk', 'interactivebrokers.com', 'trading212.com', 'freetrade.io',
    'nutmeg.com', 'moneybox.com',
    // cards and lenders — UT1's "bank" category stops at banks
    'capitalontap.com', 'americanexpress.com', 'capitalone.co.uk', 'aqua.co.uk', 'vanquis.co.uk',
    'newday.co.uk', 'jaja.co.uk', 'mbna.co.uk', 'tescobank.com', 'sainsburysbank.co.uk',
    'marcus.co.uk', 'zopa.com', 'curve.com', 'revolut.com', 'nationwide.co.uk', 'santander.co.uk',
    'halifax.co.uk', 'tsb.co.uk', 'natwest.com', 'hsbc.co.uk', 'hsbc.com', 'discover.com',
    'synchrony.com', 'sofi.com', 'chime.com'
  ],
  insurance: [
    'admiral.com', 'directline.com', 'aviva.co.uk', 'aviva.com', 'axa.co.uk', 'churchill.com',
    'hastingsdirect.com', 'lv.com', 'esure.com', 'morethan.com', 'privilege.com', 'elephant.co.uk',
    'diamond.co.uk', 'saga.co.uk', 'legalandgeneral.com', 'frontierinsurance.co.uk', 'abi.bcis.co.uk',
    'comparethemarket.com', 'moneysupermarket.com', 'confused.com', 'gocompare.com', 'uswitch.com',
    'geico.com', 'progressive.com', 'statefarm.com', 'allstate.com', 'lemonade.com'
  ],
  payment: [
    'paypal.com', 'dashboard.stripe.com', 'stripe.com', 'gocardless.com', 'klarna.com',
    'venmo.com', 'cash.app', 'checkout.com', 'clearpay.co.uk', 'afterpay.com', 'affirm.com',
    'squareup.com', 'sumup.com'
  ],
  crypto: ['coinbase.com', 'kraken.com', 'binance.com', 'gemini.com', 'crypto.com', 'blockchain.com'],
  accounting: ['xero.com', 'quickbooks.intuit.com', 'freeagent.com', 'sage.com', 'freshbooks.com'],
  health: [
    // the whole NHS estate, not three subdomains of it: forty-one vaccination-consent
    // pages were read before this line existed
    'nhs.uk', 'nhs.net', 'nhs.scot', 'nhs.wales', 'hscni.net',
    'patientaccess.com', 'systmonline.tpp-uk.com', 'babylonhealth.com', 'pushdoctor.co.uk',
    'livi.co.uk', 'mychart.com', 'patient.info', 'zocdoc.com', 'healthgrades.com',
    'bupa.co.uk', 'axahealth.co.uk', 'vitality.co.uk', 'westfieldhealth.com', 'healthhero.com',
    'simplyhealth.co.uk', 'pharmacy2u.co.uk', 'healthcare.gov', 'myhealthrecord.gov.au',
    'ameli.fr', 'doctolib.fr'
  ],
  vaults: [
    'my.1password.com', '1password.com', 'vault.bitwarden.com', 'bitwarden.com', 'lastpass.com',
    'dashlane.com', 'keepersecurity.com', 'nordpass.com', 'passbolt.com'
  ],
  government: [
    // service.gov.uk is every transactional GOV.UK service: tax, passports, DVLA, benefits
    'account.gov.uk', 'service.gov.uk', 'login.gov', 'irs.gov', 'ssa.gov', 'my.gov.au',
    'impots.gouv.fr', 'canada.ca',
    'photocard.tfl.gov.uk', 'contactless.tfl.gov.uk', 'oyster.tfl.gov.uk'
  ]
};

const apply = process.argv.includes('--apply');

async function fetchCategory(cat) {
  const res = await fetch(`${MIRROR}/${cat}/domains`);
  if (!res.ok) throw new Error(`${cat}: ${res.status}`);
  const text = await res.text();
  return text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
}

const valid = (d) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);

const fromUt1 = new Map();
for (const cat of CATEGORIES) {
  const list = (await fetchCategory(cat)).filter(valid).filter((d) => !KEEP.has(d));
  fromUt1.set(cat, list);
  console.log(`ut1/${cat.padEnd(8)} ${String(list.length).padStart(6)} domains`);
}

// One flat, de-duplicated, sorted list. Category is kept for the report only —
// at lookup time the question is just "is this host, or any parent, listed".
const all = new Set();
for (const list of fromUt1.values()) for (const d of list) all.add(d);
let added = 0;
for (const [cat, list] of Object.entries(ADDITIONS)) {
  for (const d of list) { if (!valid(d)) throw new Error(`bad addition in ${cat}: ${d}`); if (!all.has(d)) added++; all.add(d); }
}
const domains = [...all].sort();
console.log(`additions   ${String(added).padStart(6)} new`);
console.log(`total       ${String(domains.length).padStart(6)} domains`);

const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
const stamp = new Date().toISOString().slice(0, 10);
const body =
`// Generated by tools/build-exclusions.mjs on ${stamp}. Do not edit by hand.
//
// Sites whose pages SideRail never reads — not for page-text search, not for
// the index. Data, not code. Base: the UT1 blacklists (Université Toulouse
// Capitole, CC BY-SA) categories ${CATEGORIES.join(', ')}; plus additions
// for UK banks, webmail, messaging, payment, crypto, accounting, health,
// password vaults and government portals, and a keep-list for team tools.
// See THIRD-PARTY-NOTICES.md.
//
// Matching is by host suffix: "example.bank" lists the site and every
// subdomain of it.

export const EXCLUSIONS_META = ${JSON.stringify({
  builtOn: stamp,
  source: 'https://github.com/olbat/ut1-blacklists',
  categories: CATEGORIES,
  count: domains.length
}, null, 2)};

export const EXCLUDED_DOMAINS = ${JSON.stringify(domains)};
`;
if (!apply) {
  console.log(current ? `\nvendor/exclusions.js exists (${(current.length / 1024).toFixed(0)} KB). Run with --apply to rewrite.` : '\nRun with --apply to write vendor/exclusions.js.');
  process.exit(0);
}
writeFileSync(OUT, body);
console.log(`\nwrote vendor/exclusions.js (${(body.length / 1024).toFixed(0)} KB)`);
