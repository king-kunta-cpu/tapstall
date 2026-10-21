/**
 * Tapstall → Master Sheet CRM  (Apps Script, file 2 of N; additive, touches nothing it did not write)
 *
 * The sheet it is built for:
 *   https://docs.google.com/spreadsheets/d/1j_ktMLCRmLlk6TOb0-YddYGTmfHChyI29wu84j7SJ8o
 *
 * That sheet already runs two engines (STPi and DeskOS). This file adds Tapstall as a third,
 * without changing their columns, their script, or their triggers:
 *
 *   Tab 3  "3_CRM_Who_We_Talked_To"  — the 17-column contact ledger. This file only ever appends
 *                                       rows whose Lead ID starts with `tapstall-`, and only ever
 *                                       updates the Stage of those same rows.
 *   Tab 4  "4_Tomorrow_Queue"        — rebuilt from Tab 3 across all three engines, engine-aware.
 *   8_Tapstall_Pipeline              — created by this file: the funnel, the sync, the failures.
 *   9_Tapstall_Sync                  — created by this file: one row per stage pushed to Tapstall,
 *                                       so a push is idempotent and a 409 is visible, not silent.
 *
 * Setup, once (5 minutes):
 *   1. In the sheet: Extensions → Apps Script. Add a new file, paste this whole file, save.
 *   2. Project Settings → Script Properties:
 *        TAPSTALL_URL        https://tapstall.zlnew.workers.dev
 *        TAPSTALL_SHEET_KEY  the key minted for this sheet (never the platform admin secret)
 *        TAPSTALL_OWNER      simali            (optional; who new leads are assigned to)
 *   3. Reload the sheet. Menu: ⚡ Tapstall → Sync leads now.
 *   4. Menu: ⚡ Tapstall → Turn on 2-hour sync.
 *
 * What it will never do: send an email, a message or a post; claim a lead for a person; invent a
 * phone number, an address or a business name; touch a row that another engine wrote; hold money.
 * It reads the queue and moves a stage. The Worker judges every action — ownership, the
 * do-not-contact ledger and the honest status are decided there, not in this sheet.
 */

/* ------------------------------------------------------------------ configuration */

var TPS_DEFAULTS = {
  CRM_TAB: '3_CRM_Who_We_Talked_To',
  QUEUE_TAB: '4_Tomorrow_Queue',
  SYNC_TAB: '9_Tapstall_Sync',
  PIPE_TAB: '8_Tapstall_Pipeline',
  OWNER: 'simali'
};

/** The 17 columns of the Master Sheet, in order. Read from the header row at runtime; this list is
 *  only used to create columns that a fresh copy of the sheet is missing. */
var TPS_COLUMNS = [
  'Lead ID', 'Contact / Company Name', 'Country', 'Segment', 'Channel', 'Owner (simali/tafa)',
  'Last Talked Date', 'What We Discussed / Did Today', 'Stage', 'Next Follow-Up Date (Talk To Tomorrow)',
  'Next Action Required', 'Phone / WhatsApp', 'Email / Handle', 'Website / Link',
  'Deal Value ($)', 'MRR Value ($/mo)', 'Source'
];

/** Stage → the action the Worker understands. A stage nobody mapped is never pushed, and the
 *  ledger says so, rather than guessing at what "interesting" might mean. */
var TPS_STAGE_ACTIONS = {
  'contacted': 'contacted', 'called': 'contacted', 'emailed': 'contacted', 'whatsapp sent': 'contacted',
  'message sent': 'contacted', 'dm sent': 'contacted', 'first touch': 'contacted',
  'replied': 'replied', 'in conversation': 'replied', 'interested': 'replied', 'call booked': 'replied',
  'trial': 'trial', 'trial sent': 'trial', 'trial link sent': 'trial', 'demo sent': 'trial',
  'pitch sent': 'trial', 'proposal sent': 'trial',
  'won': 'closed', 'closed': 'closed', 'converted': 'closed', 'signed up': 'closed', 'live': 'closed',
  'dnc': 'dnc', 'do not contact': 'dnc', 'not interested': 'dnc', 'opted out': 'dnc', 'unsubscribe': 'dnc'
};

/** The opening a seller gets, per segment. Written to "Next Action Required" so the queue is a
 *  queue of sentences, not a list of names. */
var TPS_SEGMENT_ACTION = {
  agencies: 'Ask for the one thing: their clients\' orders. Offer to put a Tapstall order link on one client site, free, and let the statement do the talking.',
  accountants: 'Ask how clients send proof of payment today. Offer the month-end statement as the answer.',
  pos_resellers: 'Ask what they sell after the till. Offer the order link as the upsell that does not compete with the hardware.',
  associations: 'Ask for one member who takes orders by hand. Offer to set that member up as the example.',
  social_merchants: 'Ask what they sell and where the order lands. Offer a link that takes the order with the amount written down.'
};

/* ------------------------------------------------------------------ properties */

function tpsProps_() {
  var p = PropertiesService.getScriptProperties();
  return {
    url: (p.getProperty('TAPSTALL_URL') || 'https://tapstall.zlnew.workers.dev').replace(/\/+$/, ''),
    key: p.getProperty('TAPSTALL_SHEET_KEY') || '',
    owner: p.getProperty('TAPSTALL_OWNER') || TPS_DEFAULTS.OWNER,
    crmTab: p.getProperty('TPS_CRM_TAB') || TPS_DEFAULTS.CRM_TAB,
    queueTab: p.getProperty('TPS_QUEUE_TAB') || TPS_DEFAULTS.QUEUE_TAB,
    syncTab: p.getProperty('TPS_SYNC_TAB') || TPS_DEFAULTS.SYNC_TAB,
    pipeTab: p.getProperty('TPS_PIPE_TAB') || TPS_DEFAULTS.PIPE_TAB
  };
}

/* ------------------------------------------------------------------ pure helpers
 * Everything below this line to the next banner is a pure function: no SpreadsheetApp, no
 * UrlFetchApp. They are the part that can be tested outside Google, and the part where a mistake
 * would file the wrong business or push the wrong stage.
 */

/** `agencies` → `Tapstall · agencies`. The sheet already names its engines in the Segment column
 *  (`DeskOS · customs_ip`), so a Tapstall row has to be recognisable at a glance. */
function tpsSegmentLabel_(segment, extra) {
  var s = String(segment || 'other').toLowerCase().replace(/\s+/g, '_');
  return 'Tapstall · ' + (s || 'other') + (extra ? ' · ' + String(extra).slice(0, 24) : '');
}

/** The channel is a fact about the lead, not a preference: a number means WhatsApp is possible,
 *  an address means email is. Neither is invented. */
function tpsChannel_(lead) {
  var phone = String((lead && lead.phone) || '').trim();
  var email = String((lead && lead.email) || '').trim();
  if (phone && email) return 'WhatsApp / Email';
  if (phone) return 'WhatsApp';
  if (email) return 'Email';
  return 'Link only';
}

/** A lead's own words, then where to check them. The seller must be able to verify the hook in
 *  one click, or it is not a hook, it is a rumour. */
function tpsDiscussion_(lead) {
  var bits = [];
  var hook = String((lead && (lead.hook || lead.note)) || '').trim();
  if (hook) bits.push(hook.slice(0, 240));
  var src = String((lead && lead.source_url) || '').trim();
  if (src) bits.push('Check: ' + src);
  var score = Number(lead && lead.score);
  if (isFinite(score) && score > 0) bits.push('Signal score ' + score + '/100');
  bits.push('Found by ' + String((lead && lead.source) || 'tapstall'));
  return bits.join(' — ').slice(0, 900);
}

function tpsDate_(d) {
  var x = (d instanceof Date) ? d : new Date(d);
  if (isNaN(x.getTime())) return '';
  return Utilities.formatDate(x, Session.getScriptTimeZone() || 'Africa/Harare', 'yyyy-MM-dd');
}

function tpsTomorrow_(from) {
  var d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + 1);
  return d;
}

/** One lead → one row of the 17-column contract. Pure: the same lead always produces the same row,
 *  which is what makes the append idempotent and the diff trustworthy. */
function tpsLeadToRow_(lead, opts) {
  var o = opts || {};
  var owner = o.owner || TPS_DEFAULTS.OWNER;
  var today = o.today ? new Date(o.today) : new Date();
  var business = String((lead && lead.business) || '').trim();
  var person = String((lead && lead.name) || '').trim();
  var label = business || person;
  if (business && person && person.toLowerCase() !== business.toLowerCase()) {
    label = business + ' · attn: ' + person;
  }
  return [
    tpsLeadId_(lead),
    label.slice(0, 160),
    String((lead && lead.country) || '').toUpperCase().slice(0, 8),
    tpsSegmentLabel_(lead && lead.segment, lead && lead.city),
    tpsChannel_(lead),
    owner,
    '',                                                  // Last Talked Date: blank is the truth
    tpsDiscussion_(lead),
    'New',
    tpsDate_(tpsTomorrow_(today)),
    TPS_SEGMENT_ACTION[String((lead && lead.segment) || '')] || TPS_SEGMENT_ACTION.agencies,
    String((lead && lead.phone) || '').slice(0, 24),
    String((lead && lead.email) || '').slice(0, 120),
    String((lead && lead.source_url) || '').slice(0, 400),
    0, 0,
    'tapstall'
  ];
}

/** The Lead ID is namespaced, so this file can prove a row is its own before it edits it. */
function tpsLeadId_(lead) {
  var id = String((lead && lead.id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  return id ? 'tapstall-' + id : '';
}

/** Stage (as a human typed it) → Worker action, or '' if nobody mapped it. Case and punctuation
 *  are the human's business; the mapping is ours. */
function tpsStageAction_(stage) {
  var s = String(stage || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s === 'new' || s === 'queued' || s === 'research hold') return '';
  if (TPS_STAGE_ACTIONS[s]) return TPS_STAGE_ACTIONS[s];
  // a stage line like "Trial Sent 21/10" or "DNC (asked)" still maps on its first words
  var words = s.split(' ');
  for (var i = words.length; i > 0; i--) {
    var probe = words.slice(0, i).join(' ');
    if (TPS_STAGE_ACTIONS[probe]) return TPS_STAGE_ACTIONS[probe];
  }
  return '';
}

/** One next-action line per engine, because "Send 7-Day Free Trial" is the wrong sentence to hand
 *  a Tapstall seller and "ask for one client site" is the wrong one for DeskOS. */
function tpsNextAction_(row) {
  var r = row || {};
  var engine = String(r.source || '').toLowerCase();
  var stage = String(r.stage || '').toLowerCase();
  if (engine === 'tapstall') {
    var seg = String(r.segment || '').toLowerCase();
    for (var k in TPS_SEGMENT_ACTION) {
      if (TPS_SEGMENT_ACTION.hasOwnProperty(k) && seg.indexOf(k) !== -1) {
        if (stage === 'contacted') return 'Second touch: send the one-page statement sample. Two days, then move on.';
        if (stage === 'replied') return 'Book ten minutes. Offer to set up one client site free, today.';
        if (stage === 'trial sent') return 'Check the trial landed. Ask for the first order link to go live.';
        return TPS_SEGMENT_ACTION[k];
      }
    }
    return 'Open the page the hook came from, then open with the hook.';
  }
  if (engine === 'stpi-deskos') return 'Send 7-Day Free Trial (/trial) or Whop Checkout Link';
  if (engine === 'stpi-leads') return 'Send the STPi pitch and the trial link';
  return String(r.nextAction || '').trim() || 'Open the row and decide the next step.';
}

function tpsIsTerminal_(stage) {
  var a = tpsStageAction_(stage);
  return a === 'dnc' || a === 'closed';
}

function tpsIsDue_(nextFollow, today) {
  if (!nextFollow) return false;
  var d = new Date(nextFollow);
  if (isNaN(d.getTime())) return false;
  var horizon = today ? new Date(today) : new Date();
  horizon.setDate(horizon.getDate() + 1);
  horizon.setHours(23, 59, 59, 999);
  return d.getTime() <= horizon.getTime();
}

/* ------------------------------------------------------------------ the feed */

/** Pull the queue. Returns {ok, leads, via, at, error}. Never throws at the caller: a CRM that
 *  dies because a Worker was cold is worse than one that reports it. */
function tpsFetchLeads_(cfg, limit) {
  var url = cfg.url + '/api/leads/sheets-feed?code=sheet&key=' + encodeURIComponent(cfg.key)
    + '&fmt=json' + (limit ? '&limit=' + encodeURIComponent(limit) : '');
  var res;
  try {
    res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    return { ok: false, error: 'network: ' + String(e && e.message || e), leads: [] };
  }
  var code = res.getResponseCode();
  var body = res.getContentText() || '';
  if (code === 401) return { ok: false, error: 'key refused (401) — TAPSTALL_SHEET_KEY is wrong or was rotated', leads: [] };
  if (code !== 200) return { ok: false, error: 'HTTP ' + code + ': ' + body.slice(0, 160), leads: [] };
  var data;
  try { data = JSON.parse(body); } catch (e) { return { ok: false, error: 'unparseable feed', leads: [] }; }
  if (!data || data.ok !== true || !data.leads) return { ok: false, error: 'feed said: ' + body.slice(0, 160), leads: [] };
  return { ok: true, leads: data.leads, via: data.via || '', at: data.at || '', count: data.leads.length };
}

/* ------------------------------------------------------------------ sheet plumbing */

function tpsSheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function tpsCrm_(cfg) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(cfg.crmTab);
  if (!sh) throw new Error('Tab "' + cfg.crmTab + '" not found. Set TPS_CRM_TAB if the tab was renamed.');
  return sh;
}

/** Header names → column numbers, read live, so a column inserted by the other engine does not
 *  silently shift our writes into the wrong place. */
function tpsColumns_(sh) {
  var width = Math.max(sh.getLastColumn(), TPS_COLUMNS.length);
  var head = sh.getRange(1, 1, 1, width).getValues()[0];
  var map = {};
  for (var i = 0; i < head.length; i++) {
    var name = String(head[i] || '').trim();
    if (name) map[name] = i;
  }
  // tolerate the two columns whose header text drifts (owner list, follow-up phrasing)
  function find(re) {
    for (var j = 0; j < head.length; j++) if (re.test(String(head[j] || ''))) return j;
    return -1;
  }
  return {
    id: map['Lead ID'] !== undefined ? map['Lead ID'] : 0,
    name: map['Contact / Company Name'] !== undefined ? map['Contact / Company Name'] : 1,
    country: map['Country'] !== undefined ? map['Country'] : 2,
    segment: map['Segment'] !== undefined ? map['Segment'] : 3,
    channel: map['Channel'] !== undefined ? map['Channel'] : 4,
    owner: find(/^owner/i),
    lastTalked: find(/^last talked/i),
    discussion: find(/^what we discussed/i),
    stage: map['Stage'] !== undefined ? map['Stage'] : 8,
    nextFollow: find(/^next follow/i),
    nextAction: find(/^next action/i),
    phone: find(/^phone/i),
    email: find(/^email/i),
    website: find(/^website/i),
    deal: find(/^deal value/i),
    mrr: find(/^mrr/i),
    source: map['Source'] !== undefined ? map['Source'] : head.length - 1,
    width: head.length
  };
}

/* ------------------------------------------------------------------ sync: Tapstall → sheet */

/**
 * Append leads Tapstall found that the sheet has never seen. Idempotent: the set of existing Lead
 * IDs is read once, and a lead already present is skipped, so running this every two hours for a
 * year adds one row per lead, not one row per run.
 */
function tapstallSyncNow() {
  var cfg = tpsProps_();
  if (!cfg.key) return tpsAlert_('Set TAPSTALL_SHEET_KEY in Project Settings → Script Properties first.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return tpsAlert_('Another sync is still running. Try again in a moment.');

  var out = { added: 0, seen: 0, skipped: 0, error: '' };
  try {
    var crm = tpsCrm_(cfg);
    var cols = tpsColumns_(crm);
    var last = crm.getLastRow();
    var existing = {};
    if (last > 1) {
      var ids = crm.getRange(2, cols.id + 1, last - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        var v = String(ids[i][0] || '');
        if (v) existing[v] = true;
      }
    }

    var feed = tpsFetchLeads_(cfg, 400);
    if (!feed.ok) {
      out.error = feed.error;
      tpsLog_('sync failed: ' + feed.error);
      tpsWritePipeline_(cfg, { error: feed.error });
      return tpsAlert_('Tapstall did not answer: ' + feed.error);
    }
    out.seen = feed.leads.length;

    var rows = [];
    for (var j = 0; j < feed.leads.length; j++) {
      var lead = feed.leads[j];
      var id = tpsLeadId_(lead);
      if (!id || existing[id]) { out.skipped++; continue; }
      // a lead with no way to answer is not a lead; Tapstall should not send one, and the sheet
      // must not invent one
      if (!lead.phone && !lead.email && !lead.source_url) { out.skipped++; continue; }
      var row = tpsLeadToRow_(lead, { owner: cfg.owner });
      // pad to the table width if another engine added columns after ours
      while (row.length < cols.width) row.push('');
      rows.push(row);
      existing[id] = true;
    }

    if (rows.length) {
      // one write, not one per row: quotas are real and a burst of appends is slow and fragile
      crm.getRange(crm.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      out.added = rows.length;
    }

    tpsLog_('sync: ' + out.added + ' added, ' + out.skipped + ' already known, ' + out.seen + ' in feed');
    tpsWritePipeline_(cfg, { added: out.added, seen: out.seen, skipped: out.skipped, via: feed.via, at: feed.at });
    PropertiesService.getScriptProperties().setProperty('TPS_LAST_SYNC', new Date().toISOString());
    return tpsAlert_('Tapstall: ' + out.added + ' new lead' + (out.added === 1 ? '' : 's')
      + ' added to ' + cfg.crmTab + ' (' + out.seen + ' in the queue, ' + out.skipped + ' already here).'
      + (out.added ? '\n\nStage them there as you work them; the sheet pushes the stage back to Tapstall.' : ''));
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ write-back: sheet → Tapstall */

/**
 * Push the stage of every Tapstall row whose stage changed since it was last pushed. The ledger tab
 * holds the last stage successfully pushed per lead, so this is safe to run on a timer: an unchanged
 * row is not a request, and a rejected one is visible with its HTTP code.
 */
function tapstallPushStages() {
  var cfg = tpsProps_();
  if (!cfg.key) return tpsAlert_('Set TAPSTALL_SHEET_KEY first.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return tpsAlert_('Another Tapstall job is running.');

  var pushed = 0, failed = 0, unmapped = 0;
  try {
    var crm = tpsCrm_(cfg);
    var cols = tpsColumns_(crm);
    var last = crm.getLastRow();
    if (last < 2) return tpsAlert_('Nothing in ' + cfg.crmTab + ' yet.');
    var width = cols.width;
    var data = crm.getRange(2, 1, last - 1, width).getValues();

    var ledger = tpsSheet_(cfg.syncTab, ['Lead ID', 'Stage', 'Action', 'HTTP', 'Result', 'At']);
    var seen = {};
    var lLast = ledger.getLastRow();
    if (lLast > 1) {
      var lr = ledger.getRange(2, 1, lLast - 1, 5).getValues();
      for (var i = 0; i < lr.length; i++) seen[String(lr[i][0] || '')] = String(lr[i][1] || '');
    }

    var newRows = [];
    for (var r = 0; r < data.length; r++) {
      var row = data[r];
      var id = String(row[cols.id] || '');
      if (id.indexOf('tapstall-') !== 0) continue;          // another engine's row: never touched
      var stage = String(row[cols.stage] || '').trim();
      if (!stage) continue;
      var action = tpsStageAction_(stage);
      if (!action) { if (stage.toLowerCase() !== 'new') unmapped++; continue; }   // 'New' is not an event
      if (seen[id] && seen[id].toLowerCase() === stage.toLowerCase()) continue;   // already pushed

      var body = {
        code: 'sheet', key: cfg.key, id: id.replace(/^tapstall-/, ''), action: action,
        note: String(row[cols.discussion] || '').slice(0, 200)
      };
      if (action === 'follow') body.follow_days = 2;
      var res = tpsPost_(cfg.url + '/api/leads/act', body);
      newRows.push([id, stage, action, String(res.code), res.text.slice(0, 200), new Date()]);
      if (res.code === 200) { pushed++; seen[id] = stage; }
      else failed++;
    }

    if (newRows.length) {
      ledger.getRange(ledger.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    }
    tpsLog_('push: ' + pushed + ' accepted, ' + failed + ' refused, ' + unmapped + ' unmapped stage(s)');
    tpsWritePipeline_(cfg, { pushed: pushed, failed: failed, unmapped: unmapped });
    return tpsAlert_('Tapstall: ' + pushed + ' stage' + (pushed === 1 ? '' : 's') + ' pushed'
      + (failed ? ', ' + failed + ' refused (see ' + cfg.syncTab + ')' : '')
      + (unmapped ? '. ' + unmapped + ' row(s) have a stage nobody mapped — put the word in TPS_STAGE_ACTIONS.' : '.'));
  } finally {
    lock.releaseLock();
  }
}

function tpsPost_(url, body) {
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    return { code: res.getResponseCode(), text: res.getContentText() || '' };
  } catch (e) {
    return { code: 0, text: 'network: ' + String(e && e.message || e) };
  }
}

/* ------------------------------------------------------------------ tomorrow queue */

/**
 * Rebuild the queue across all three engines. It is a view, not a second ledger: nothing is written
 * to Tab 3, nothing is created for a row that is terminal, and a row with no date is not "due today"
 * by accident.
 */
function tapstallRebuildQueue() {
  var cfg = tpsProps_();
  var crm = tpsCrm_(cfg);
  var cols = tpsColumns_(crm);
  var last = crm.getLastRow();
  if (last < 2) return tpsAlert_('Nothing to queue.');
  var data = crm.getRange(2, 1, last - 1, cols.width).getValues();

  var due = [];
  var today = new Date();
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var stage = String(row[cols.stage] || '').trim();
    if (tpsIsTerminal_(stage)) continue;
    var when = row[cols.nextFollow];
    if (!when) continue;
    if (!tpsIsDue_(when, today)) continue;
    due.push({
      business: String(row[cols.name] || ''),
      country: String(row[cols.country] || ''),
      segment: String(row[cols.segment] || ''),
      channel: String(row[cols.channel] || ''),
      owner: cols.owner >= 0 ? String(row[cols.owner] || '') : '',
      stage: stage,
      phone: String(row[cols.phone] || ''),
      email: String(row[cols.email] || ''),
      website: String(row[cols.website] || ''),
      source: String(row[cols.source] || ''),
      nextAction: cols.nextAction >= 0 ? String(row[cols.nextAction] || '') : '',
      when: when
    });
  }
  due.sort(function (a, b) {
    var da = new Date(a.when).getTime() || 0, db = new Date(b.when).getTime() || 0;
    if (da !== db) return da - db;
    return String(a.owner).localeCompare(String(b.owner));
  });

  var sh = tpsSheet_(cfg.queueTab, [
    'Owner (simali/tafa)', 'Next Follow-Up Date', 'Contact / Company Name', 'Country', 'Segment',
    'Channel', 'Stage', 'Next Action Required', 'Phone / WhatsApp', 'Email / Handle', 'Website / Link', 'Source Engine'
  ]);
  var head = sh.getRange(1, 1, 1, 12).getValues()[0];
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 12)).clearContent();
  var rows = [];
  for (var j = 0; j < due.length; j++) {
    var d = due[j];
    rows.push([d.owner, tpsDate_(new Date(d.when)), d.business, d.country, d.segment, d.channel, d.stage,
      d.nextAction || tpsNextAction_(d), d.phone, d.email, d.website, d.source || 'tapstall']);
  }
  if (rows.length) sh.getRange(2, 1, rows.length, 12).setValues(rows);
  sh.getRange(1, 1, 1, 12).setValues([head]);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, 12);
  tpsLog_('queue rebuilt: ' + rows.length + ' row(s) due');
  return tpsAlert_(rows.length + ' in tomorrow\'s queue across every engine. Tapstall rows: '
    + rows.filter(function (r) { return String(r[11]).toLowerCase() === 'tapstall'; }).length + '.');
}

/* ------------------------------------------------------------------ pipeline health */

/** One screen that answers "is this working", because a sync that silently fails every two hours is
 *  worse than no sync: you plan against a number that stopped moving. */
function tpsWritePipeline_(cfg, patch) {
  var p = PropertiesService.getScriptProperties();
  var state = {};
  try { state = JSON.parse(p.getProperty('TPS_STATE') || '{}'); } catch (e) { state = {}; }
  for (var k in (patch || {})) if (patch.hasOwnProperty(k)) state[k] = patch[k];
  state.last_run = new Date().toISOString();
  p.setProperty('TPS_STATE', JSON.stringify(state).slice(0, 1800));

  var sh;
  try { sh = tpsSheet_(cfg.pipeTab, ['Tapstall pipeline', 'Value']); } catch (e) { return; }
  var crm = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.crmTab);
  var counts = { total: 0, by_stage: {}, by_segment: {}, by_country: {}, due_tomorrow: 0 };
  if (crm && crm.getLastRow() > 1) {
    var cols = tpsColumns_(crm);
    var data = crm.getRange(2, 1, crm.getLastRow() - 1, cols.width).getValues();
    for (var i = 0; i < data.length; i++) {
      var id = String(data[i][cols.id] || '');
      if (id.indexOf('tapstall-') !== 0) continue;
      counts.total++;
      var st = String(data[i][cols.stage] || 'New');
      counts.by_stage[st] = (counts.by_stage[st] || 0) + 1;
      var seg = String(data[i][cols.segment] || '');
      counts.by_segment[seg] = (counts.by_segment[seg] || 0) + 1;
      var co = String(data[i][cols.country] || '');
      counts.by_country[co] = (counts.by_country[co] || 0) + 1;
      if (!tpsIsTerminal_(st) && tpsIsDue_(data[i][cols.nextFollow], new Date())) counts.due_tomorrow++;
    }
  }
  var rows = [
    ['Tapstall rows in the CRM', counts.total],
    ['Due tomorrow or overdue', counts.due_tomorrow],
    ['Last sync', PropertiesService.getScriptProperties().getProperty('TPS_LAST_SYNC') || 'never'],
    ['Last run', state.last_run || 'never'],
    ['Last feed size', state.seen || 0],
    ['Added last sync', state.added || 0],
    ['Stages pushed last run', state.pushed || 0],
    ['Refused last run', state.failed || 0],
    ['Last error', state.error || 'none'],
    ['', ''],
    ['By stage', counts.by_stage],
    ['By segment', counts.by_segment],
    ['By country', counts.by_country],
    ['', ''],
    ['Rule', 'This sheet reads the Tapstall queue and moves a stage. It never sends, never claims a lead and never invents a contact. The Worker judges every action.']
  ];
  var flat = [];
  for (var r = 0; r < rows.length; r++) {
    var v = rows[r][1];
    flat.push([rows[r][0], (v && typeof v === 'object') ? JSON.stringify(v) : v]);
  }
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
  sh.getRange(2, 1, flat.length, 2).setValues(flat);
  sh.autoResizeColumns(1, 2);
}

function tapstallStatus() {
  var cfg = tpsProps_();
  var feed = tpsFetchLeads_(cfg, 1);
  var state = {};
  try { state = JSON.parse(PropertiesService.getScriptProperties().getProperty('TPS_STATE') || '{}'); } catch (e) { state = {}; }
  tpsAlert_([
    'Sheet key: ' + (cfg.key ? 'set (' + cfg.key.length + ' chars)' : 'MISSING'),
    'Worker: ' + cfg.url,
    'Feed: ' + (feed.ok ? 'reachable, ' + (feed.count || 0) + ' lead(s)' + (feed.via ? ' via ' + feed.via : '') : 'FAILED — ' + feed.error),
    'Last sync: ' + (PropertiesService.getScriptProperties().getProperty('TPS_LAST_SYNC') || 'never'),
    'Last run: ' + (state.last_run || 'never') + (state.pushed ? ', ' + state.pushed + ' pushed' : ''),
    'Last error: ' + (state.error || 'none')
  ].join('\n'));
}

/* ------------------------------------------------------------------ triggers + menu */

function tapstallSyncTick() {
  tapstallSyncNow();
  tapstallPushStages();
}

function tapstallQueueTick() {
  tapstallRebuildQueue();
}

function tapstallInstallTriggers() {
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    var h = all[i].getHandlerFunction();
    if (h === 'tapstallSyncTick' || h === 'tapstallQueueTick') ScriptApp.deleteTrigger(all[i]);
  }
  ScriptApp.newTrigger('tapstallSyncTick').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('tapstallQueueTick').timeBased().atHour(6).everyDays(1).create();
  tpsAlert_('On. Tapstall syncs and pushes stages every 2 hours; the queue rebuilds at 06:00.\n\n'
    + 'The other engines\' triggers are untouched.');
}

function tapstallRemoveTriggers() {
  var all = ScriptApp.getProjectTriggers();
  var n = 0;
  for (var i = 0; i < all.length; i++) {
    var h = all[i].getHandlerFunction();
    if (h === 'tapstallSyncTick' || h === 'tapstallQueueTick') { ScriptApp.deleteTrigger(all[i]); n++; }
  }
  tpsAlert_(n ? 'Tapstall timers removed. The other engines keep theirs.' : 'No Tapstall timers were installed.');
}

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('⚡ Tapstall')
    .addItem('Sync Tapstall leads now', 'tapstallSyncNow')
    .addItem('Push stage changes to Tapstall', 'tapstallPushStages')
    .addSeparator()
    .addItem('Rebuild tomorrow\'s queue (all engines)', 'tapstallRebuildQueue')
    .addItem('Pipeline health', 'tapstallStatus')
    .addSeparator()
    .addItem('Turn on 2-hour sync', 'tapstallInstallTriggers')
    .addItem('Turn off Tapstall timers', 'tapstallRemoveTriggers')
    .addToUi();
}

function tpsAlert_(msg) {
  try { SpreadsheetApp.getUi().alert(String(msg)); } catch (e) { Logger.log(msg); }
  return msg;
}

function tpsLog_(msg) {
  try { console.log('[tapstall] ' + msg); } catch (e) { Logger.log('[tapstall] ' + msg); }
}
