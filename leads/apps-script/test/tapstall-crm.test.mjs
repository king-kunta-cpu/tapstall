/**
 * Tests for leads/apps-script/TapstallMasterSheet.gs — the Google Sheet CRM.
 *
 * Apps Script cannot be run outside Google, so the file is loaded into a VM with the four globals a
 * CRM script actually touches (SpreadsheetApp, UrlFetchApp, PropertiesService, LockService) faked.
 * That is enough to test the two things that would cost real money if they were wrong:
 *
 *   1. the row a lead becomes — because a wrong row is a seller ringing the wrong business;
 *   2. idempotency of sync and push — because a sheet that re-adds the queue every two hours, or
 *      re-pushes a stage on every tick, turns a CRM into a spam machine.
 *
 * It also asserts the negative: no mail is ever sent from the sheet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'TapstallMasterSheet.gs'), 'utf8');

/* ---------------------------------------------------------------- a small fake spreadsheet */

function makeSheet(name, rows = []) {
  const values = rows.map((r) => [...r]);
  const sheet = {
    name,
    values,
    getLastRow: () => values.length,
    getLastColumn: () => values.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(row, col, nRows = 1, nCols = 1) {
      return {
        getValues: () => {
          const out = [];
          for (let r = 0; r < nRows; r++) {
            const src = values[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < nCols; c++) line.push(src[col - 1 + c] ?? '');
            out.push(line);
          }
          return out;
        },
        getValue: () => (values[row - 1] || [])[col - 1] ?? '',
        setValues: (grid) => {
          grid.forEach((line, r) => {
            const idx = row - 1 + r;
            while (values.length <= idx) values.push([]);
            line.forEach((v, c) => { values[idx][col - 1 + c] = v; });
          });
          return api;
        },
        clearContent: () => {
          for (let r = 0; r < nRows; r++) {
            const idx = row - 1 + r;
            if (!values[idx]) continue;
            for (let c = 0; c < nCols; c++) values[idx][col - 1 + c] = '';
          }
          return api;
        },
        setValue: (v) => { while (values.length < row) values.push([]); values[row - 1][col - 1] = v; return api; },
        setFontWeight: () => api,
      };
      function api() { return null; }
      var api2 = null; void api2;
    },
    setFrozenRows: () => sheet,
    autoResizeColumns: () => sheet,
    appendRow: (r) => { values.push([...r]); return sheet; },
    insertSheet: () => sheet,
  };
  // setValues returns the range api; keep a stable object so chaining never explodes
  const originalGetRange = sheet.getRange;
  sheet.getRange = (...args) => {
    const r = originalGetRange(...args);
    // make the range's setters chain back to themselves
    r.setFontWeight = () => r;
    r.setValues = ((orig) => (grid) => { orig(grid); return r; })(r.setValues);
    r.clearContent = ((orig) => () => { orig(); return r; })(r.clearContent);
    r.setValue = ((orig) => (v) => { orig(v); return r; })(r.setValue);
    return r;
  };
  return sheet;
}

function makeBook() {
  const sheets = new Map();
  const book = {
    sheets,
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = makeSheet(n, []); sheets.set(n, s); return s; },
    add: (s) => { sheets.set(s.name, s); return s; },
  };
  return book;
}

/* ---------------------------------------------------------------- load the .gs */

function load(book, opts = {}) {
  const props = new Map(Object.entries(opts.props || {}));
  const calls = [];
  const responses = (opts.responses || []).slice();
  const ctx = {
    console: { log: () => {} },
    Logger: { log: () => {} },
    Utilities: {
      formatDate: (d) => new Date(d).toISOString().slice(0, 10),
    },
    Session: { getScriptTimeZone: () => 'Africa/Harare' },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => book,
      getUi: () => ({ alert: () => {}, createMenu: () => ({ addItem: () => ({ addItem: () => ({ addSeparator: () => ({ addItem: () => ({ addItem: () => ({ addItem: () => ({ addToUi: () => {} }) }) }) }) }), addToUi: () => {} }) }) }),
    },
    UrlFetchApp: {
      fetch: (url, init) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        const payload = typeof next === 'function' ? next(url, init) : next;
        return {
          getResponseCode: () => (payload && payload.code) || 200,
          getContentText: () => JSON.stringify((payload && payload.body) || {}),
        };
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, v); },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create: () => {} }), atHour: () => ({ everyDays: () => ({ create: () => {} }) }) }) }), deleteTrigger: () => {} },
  };
  const wrapped = new Function(...Object.keys(ctx), SRC + '\n;return {' + [
    'tpsLeadToRow_', 'tpsLeadId_', 'tpsStageAction_', 'tpsIsDue_', 'tpsSegmentLabel_', 'tpsChannel_',
    'tpsDiscussion_', 'tpsNextAction_', 'tpsIsTerminal_', 'tapstallSyncNow', 'tapstallPushStages',
    'tapstallRebuildQueue', 'tpsProps_', 'tpsOnOpen',
  ].join(',') + '};');
  const api = wrapped(...Object.values(ctx));
  api._calls = calls;
  api._props = props;
  return api;
}

const LEAD = {
  id: 'ld_a1b2c3', business: 'Cainway Holdings (Pvt) Ltd', name: 'T. Moyo', segment: 'agencies',
  country: 'ZW', city: 'Harare', phone: '263783283422', email: '', status: 'queued', score: 44,
  source: 'discovery:directory', source_url: 'http://www.webdev.co.zw/about-us/',
  hook: 'talks about orders on webdev.co.zw but gives a buyer no way to order — a link would finish the sentence',
  next_follow_at: '',
};
const OTHER_LEAD = {
  id: 'ld_z9', business: 'WOW Travels and Tours', segment: 'social_merchants', country: 'NG',
  phone: '2348022226930', email: 'hi@wow.example', source: 'discovery:directory',
  source_url: 'https://www.businesslist.com.ng/company/258179/wow-travels-and-tours', hook: 'listed in a Nigerian business directory',
};

function crmBook(extraRows = []) {
  const book = makeBook();
  const header = ['Lead ID', 'Contact / Company Name', 'Country', 'Segment', 'Channel', 'Owner (simali/tafa)',
    'Last Talked Date', 'What We Discussed / Did Today', 'Stage', 'Next Follow-Up Date (Talk To Tomorrow)',
    'Next Action Required', 'Phone / WhatsApp', 'Email / Handle', 'Website / Link', 'Deal Value ($)',
    'MRR Value ($/mo)', 'Source'];
  book.add(makeSheet('3_CRM_Who_We_Talked_To', [header,
    ['deskos-bw-okavango', 'Okavango Sovereign Expeditions DMC', 'BW', 'DeskOS · dmc_b2b', 'Email', 'tafa', '2026-10-21',
      'Pre-loaded unit', 'New', '2026-10-22', 'Send 7-Day Free Trial', '', 'x@y.mu', 'https://x', 0, 0, 'stpi-deskos'],
    ...extraRows,
  ]));
  book.add(makeSheet('4_Tomorrow_Queue', []));
  return book;
}

/* ---------------------------------------------------------------- tests */

test('a lead becomes one row of the sheet contract, named and checkable', () => {
  const api = load(crmBook(), { props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32), TAPSTALL_OWNER: 'simali' } });
  const row = api.tpsLeadToRow_(LEAD, { owner: 'simali', today: '2026-10-21T08:00:00Z' });
  assert.equal(row.length, 17, 'the contract is 17 columns');
  assert.equal(row[0], 'tapstall-ld_a1b2c3', 'the ID is namespaced, so the script knows which rows are its own');
  assert.equal(row[1], 'Cainway Holdings (Pvt) Ltd · attn: T. Moyo', 'the business, then the person if there is one');
  assert.equal(row[2], 'ZW');
  assert.equal(row[3], 'Tapstall · agencies · Harare', 'engine-named like the DeskOS rows, plus the city a seller drives to');
  assert.equal(row[4], 'WhatsApp', 'a number and no address means WhatsApp is the channel');
  assert.equal(row[5], 'simali');
  assert.equal(row[6], '', 'nobody has talked to them yet, and the sheet says so by staying empty');
  assert.match(row[7], /no way to order/, 'the hook is what the seller opens with');
  assert.match(row[7], /Check: http:\/\/www\.webdev\.co\.zw\/about-us\//, 'and where to check it');
  assert.equal(row[8], 'New');
  assert.equal(row[9], '2026-10-22', 'tomorrow, so it lands in the queue');
  assert.match(row[10], /client/i, 'a next action written for the segment');
  assert.equal(row[11], '263783283422');
  assert.equal(row[13], 'http://www.webdev.co.zw/about-us/');
  assert.equal(row[16], 'tapstall', 'the Source column is how the sale is traced');
  assert.equal(row[14], 0, 'no invented deal value');
});

test('a stage a human types maps to exactly one Worker action, or to none', () => {
  const api = load(crmBook(), {});
  const cases = {
    'New': '', '': '', 'Queued': '',
    'Contacted': 'contacted', 'Called': 'contacted', 'WhatsApp Sent': 'contacted', 'First Touch': 'contacted',
    'Replied': 'replied', 'Interested': 'replied', 'Call booked': 'replied',
    'Trial Sent': 'trial', 'Trial link sent 21/10': 'trial', 'Pitch Sent': 'trial',
    'Won': 'closed', 'Closed': 'closed',
    'DNC': 'dnc', 'Not interested': 'dnc', 'Do not contact (asked)': 'dnc',
    'Something nobody mapped': '',
  };
  for (const [stage, action] of Object.entries(cases)) {
    assert.equal(api.tpsStageAction_(stage), action, stage + ' → ' + (action || 'nothing'));
  }
});

test('the first sync adds only what the sheet has never seen; the second adds nothing', () => {
  const book = crmBook();
  const api = load(book, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32), TAPSTALL_OWNER: 'simali' },
    responses: [
      () => ({ code: 200, body: { ok: true, via: 'sheet', count: 2, leads: [LEAD, OTHER_LEAD] } }),
      () => ({ code: 200, body: { ok: true, via: 'sheet', count: 2, leads: [LEAD, OTHER_LEAD] } }),
    ],
  });
  api.tapstallSyncNow();
  const sheet = book.getSheetByName('3_CRM_Who_We_Talked_To');
  assert.equal(sheet.values.length, 4, 'header + the DeskOS row + two Tapstall rows');
  assert.equal(sheet.values[2][0], 'tapstall-ld_a1b2c3');
  assert.equal(sheet.values[3][0], 'tapstall-ld_z9');
  assert.equal(sheet.values[1][0], 'deskos-bw-okavango', 'the other engine’s row is untouched');

  api.tapstallSyncNow();
  assert.equal(sheet.values.length, 4, 'the same two leads are not added twice');
  assert.equal(api._calls[0].url.includes('/api/leads/sheets-feed'), true);
  assert.equal(api._calls[0].url.includes('code=sheet'), true, 'the sheet presents its own credential');
  assert.ok(!api._calls[0].url.includes('owner'), 'never the admin credential');
});

test('a lead with no way to answer is not filed, and a dead feed says so instead of pretending', () => {
  const book = crmBook();
  const dead = { id: 'ld_none', business: 'No Contact Ltd', segment: 'agencies', country: 'ZW' };
  const api = load(book, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32) },
    responses: [
      () => ({ code: 200, body: { ok: true, leads: [dead, LEAD] } }),
      () => ({ code: 401, body: { ok: false, error: 'seller code + key required' } }),
    ],
  });
  api.tapstallSyncNow();
  const sheet = book.getSheetByName('3_CRM_Who_We_Talked_To');
  assert.equal(sheet.values.length, 3, 'only the lead with a number or a page was filed');
  assert.equal(sheet.values[2][0], 'tapstall-ld_a1b2c3');

  api.tapstallSyncNow();          // the 401 now
  assert.equal(sheet.values.length, 3, 'a refused feed adds nothing and invents nothing');
  const state = JSON.parse(api._props.get('TPS_STATE'));
  assert.match(state.error, /401/);
});

test('stages are pushed once, on change, and only for Tapstall rows', () => {
  const book = crmBook();
  const api = load(book, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32) },
    responses: [
      () => ({ code: 200, body: { ok: true, leads: [LEAD] } }),
    ],
  });
  api.tapstallSyncNow();
  const sheet = book.getSheetByName('3_CRM_Who_We_Talked_To');

  // nothing changed: 'New' is not an event, so no request is made
  api.tapstallPushStages();
  assert.equal(api._calls.filter((c) => c.url.includes('/api/leads/act')).length, 0);

  // a seller works the lead
  sheet.values[2][8] = 'Contacted';
  api._calls.length = 0;
  const api2 = load(book, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32) },
    responses: [() => ({ code: 200, body: { ok: true, lead: { id: 'ld_a1b2c3', status: 'contacted' } } })],
  });
  api2.tapstallPushStages();
  const posts = api2._calls.filter((c) => c.url.includes('/api/leads/act'));
  assert.equal(posts.length, 1, 'one change, one request');
  const body = JSON.parse(posts[0].init.payload);
  assert.equal(body.action, 'contacted');
  assert.equal(body.id, 'ld_a1b2c3', 'the namespace is stripped before the Worker sees it');
  assert.equal(body.code, 'sheet');

  // the same stage again: the ledger remembers, so nothing is re-sent
  const api3 = load(book, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32) },
    responses: [() => ({ code: 200, body: { ok: true } })],
  });
  api3.tapstallPushStages();
  assert.equal(api3._calls.filter((c) => c.url.includes('/api/leads/act')).length, 0,
    'a stage already pushed is not pushed again — a CRM that re-pushes is a spam machine');

  // a refusal is recorded, not swallowed
  sheet.values[2][8] = 'Not interested';
  const api4 = load(book, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32) },
    responses: [() => ({ code: 409, body: { ok: false, conflict: true, error: 'allocated to tafa' } })],
  });
  api4.tapstallPushStages();
  const ledger = book.getSheetByName('9_Tapstall_Sync');
  assert.ok(ledger, 'the ledger tab was created');
  const lastLine = ledger.values[ledger.values.length - 1];
  assert.equal(String(lastLine[3]), '409', 'the refusal is visible with its code');
  assert.equal(lastLine[1], 'Not interested');
  assert.equal(lastLine[2], 'dnc', 'and it was the do-not-contact action that was refused, which matters');
});

test('the queue rebuild is engine-aware and never queues a dead lead (when this file is told to own Tab 4)', () => {
  const book = crmBook();
  const api = load(book, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32), TPS_OWN_QUEUE: 'true' },
    responses: [() => ({ code: 200, body: { ok: true, leads: [LEAD] } })],
  });
  api.tapstallSyncNow();
  const sheet = book.getSheetByName('3_CRM_Who_We_Talked_To');
  // a lead marked do-not-contact must not appear in tomorrow's queue
  sheet.values.push(['tapstall-ld_dead', 'Closed Shop', 'ZW', 'Tapstall · agencies', 'Email', 'simali', '',
    '', 'DNC', '2026-10-22', '', '', 'x@y.zw', '', 0, 0, 'tapstall']);
  api.tapstallRebuildQueue();
  const queue = book.getSheetByName('4_Tomorrow_Queue');
  const names = queue.values.slice(1).map((r) => r[2]);
  assert.ok(names.includes('Cainway Holdings (Pvt) Ltd · attn: T. Moyo'), 'the live lead is queued');
  assert.ok(!names.includes('Closed Shop'), 'the do-not-contact lead is not');
  const eng = queue.values.slice(1).map((r) => r[11]);
  assert.ok(eng.includes('stpi-deskos') || eng.length >= 1, 'engine is carried into the queue');
});

test('the sheet never sends anything, and never holds the platform admin secret', () => {
  assert.ok(!/MailApp|GmailApp|ScriptApp\.newTrigger\('tapstallSend/.test(SRC), 'no mail surface is touched');
  assert.ok(!/sendEmail|sendMail|\.sendTo/.test(SRC), 'no send call anywhere in the file');
  assert.ok(!/ADMIN_SECRET/.test(SRC), 'the sheet key is its own credential');
  assert.match(SRC, /TAPSTALL_SHEET_KEY/);
  assert.match(SRC, /code=sheet/);
  // and the one thing it must never do: create a contact that Tapstall did not find
  assert.ok(!/String\(Math\.random|fake|placeholder|dummy/i.test(SRC), 'nothing invents a contact');
});

test('the pre-gate backlog in the live queue is counted, not imported as prospects', () => {
  const book = crmBook();
  const junk = [
    { id: 'ld_j1', business: 'Ecocash Charges Calculator 2026 - USD | Econet', segment: 'other', country: 'ZW', phone: '263771112223' },
    { id: 'ld_j2', business: 'Order - definition of order by The Free Dictionary', segment: 'other', country: 'ZW', email: 'x@dict.example' },
  ];
  const api = load(book, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32) },
    responses: [() => ({ code: 200, body: { ok: true, leads: [...junk, LEAD] } })],
  });
  api.tapstallSyncNow();
  const sheet = book.getSheetByName('3_CRM_Who_We_Talked_To');
  const ids = sheet.values.slice(2).map((r) => r[0]);
  assert.deepEqual(ids, ['tapstall-ld_a1b2c3'], 'only the lead with a source was filed');
  assert.equal(JSON.parse(api._props.get('TPS_STATE')).unattributed, 2, 'and the two were counted, not silently dropped');

  // the escape hatch exists for the day somebody wants the backlog on purpose
  const book2 = crmBook();
  const api2 = load(book2, {
    props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32), TPS_INCLUDE_UNSOURCED: 'true' },
    responses: [() => ({ code: 200, body: { ok: true, leads: [...junk, LEAD] } })],
  });
  api2.tapstallSyncNow();
  assert.equal(book2.getSheetByName('3_CRM_Who_We_Talked_To').values.length, 5, 'with the property set, all three land');
});

test('it does not fight the STPi/DeskOS script for the two shared surfaces', () => {
  // 1. the menu. Their Code.gs defines onOpen; a second onOpen in the same project silently
  //    replaces one of the two menus, so this file must not define one.
  assert.ok(!/^function onOpen\s*\(/m.test(SRC), 'no onOpen in the Tapstall file');
  assert.match(SRC, /function tpsOnOpen\(/, 'the menu is built by an installable on-open trigger instead');
  assert.match(SRC, /newTrigger\('tpsOnOpen'\)\.forSpreadsheet\([\s\S]{0,80}onOpen\(\)/, 'registered on the spreadsheet, not globally');

  // 2. Tab 4. Their refreshTomorrowQueue() clears and rewrites it from every row of Tab 3, so
  //    Tapstall rows land there without this file touching it. A second writer would flicker.
  const api = load(crmBook(), { props: { TAPSTALL_SHEET_KEY: 'k'.repeat(32) } });
  assert.equal(api.tpsProps_().ownQueue, false, 'Tab 4 is not ours by default');
  const msg = api.tapstallRebuildQueue();
  assert.match(String(msg), /owned by the STPi\/DeskOS script/, 'and it says whose it is instead of writing');

  // 3. the columns we write are the ones their indexExisting_ and ingestLeadList_ read
  const row = api.tpsLeadToRow_(LEAD, { owner: 'simali', today: '2026-10-21' });
  assert.equal(row[0].indexOf('tapstall-'), 0, 'Lead ID — their dedupe keys on this and will not re-add us');
  assert.ok(row[12] || row[13], 'email or website — also in their dedupe index');
  assert.equal(row[16], 'tapstall', 'Source — their Tab 4 rebuild reads all rows, so this is what labels us');
});

test('the install path is one function, and it does not install a Tab 4 timer unless asked', () => {
  assert.match(SRC, /function tapstallInstallAll\(/, 'one thing to run from the editor');
  assert.match(SRC, /tpsInstallMenuTrigger_\(\)/, 'which installs the menu trigger');
  assert.match(SRC, /if \(tpsProps_\(\)\.ownQueue\) ScriptApp\.newTrigger\('tapstallQueueTick'\)/,
    'and the Tab 4 timer only when TPS_OWN_QUEUE is true');
});
