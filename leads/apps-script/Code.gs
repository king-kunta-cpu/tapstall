/**
 * TapStall — Google Sheets command surface (seller CRM).
 *
 * Six tabs, one script. Setup (once):
 *   1. Extensions → Apps Script, paste this file in.
 *   2. Project Settings → Script Properties: add these two:
 *        TAPSTALL_CODE  = your seller code (or "owner")
 *        TAPSTALL_KEY   = your seller key (owner: use the admin secret)
 *      Optional: TAPSTALL_ORIGIN (default https://tapstall.zlnew.workers.dev)
 *   3. Reload the sheet → menu "TapStall" appears. Run "Set up tabs", then
 *      "Sync my leads", and optionally "Install auto-sync (30 min)".
 *
 * How it works: "Sync my leads" pulls your queue from the Worker into the Leads
 * tab. Tick the DO column (claim / contacted / replied / trial / closed / dnc /
 * release), then "Send actions (DO column)" posts them to the same door every
 * other surface uses — the Worker judges ownership, so a lead another seller
 * already claimed comes back as a conflict in the RESULT column, never a
 * silent double-pitch. Nothing here bypasses the 2-signal rule or the DNC
 * ledger: the sheet only proposes actions; the Worker is the judge.
 */
var TABS = ["DASHBOARD", "Leads", "NEW_CONTACTS", "DELETIONS", "REGISTER_SELLER", "SEND_SCHEDULE"];
var ACTIONS = ["claim", "contacted", "replied", "trial", "closed", "dnc", "release", "reopen"];

function props_() {
  var p = PropertiesService.getScriptProperties();
  return {
    origin: p.getProperty("TAPSTALL_ORIGIN") || "https://tapstall.zlnew.workers.dev",
    code: p.getProperty("TAPSTALL_CODE") || "",
    key: p.getProperty("TAPSTALL_KEY") || ""
  };
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("TapStall")
    .addItem("Set up tabs", "setupTabs")
    .addItem("Sync my leads", "syncLeads")
    .addItem("Send actions (DO column)", "sendActions")
    .addItem("Export NEW_CONTACTS (hunted rows)", "exportNewContacts")
    .addItem("Apply DELETIONS (opt-outs)", "applyDeletions")
    .addItem("Install auto-sync (30 min)", "installTrigger")
    .addToUi();
}

function setupTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  TABS.forEach(function (name) {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  var d = ss.getSheetByName("DASHBOARD");
  d.getRange("A1").setValue("TAPSTALL COMMAND");
  d.getRange("A2").setValue("Sync pulls your queue. Tick DO, then Send actions. The Worker is the judge: ownership, DNC and the 2-signal rule all happen there.");
  var nc = ss.getSheetByName("NEW_CONTACTS");
  if (!nc.getRange("A1").getValue()) nc.appendRow(["business", "email", "phone", "website", "source_url", "note", "segment", "country"]);
  var del = ss.getSheetByName("DELETIONS");
  if (!del.getRange("A1").getValue()) del.appendRow(["email_or_phone_or_lead_id"]);
  var rs = ss.getSheetByName("REGISTER_SELLER");
  if (!rs.getRange("A1").getValue()) { rs.appendRow(["code", "name", "commission_pct"]); rs.getRange("A3").setValue("Owner only. Fill a row, then run 'Register sellers (owner)' from the script editor."); }
  var sc = ss.getSheetByName("SEND_SCHEDULE");
  if (!sc.getRange("A1").getValue()) { sc.appendRow(["when", "what", "status"]); sc.getRange("A3").setValue("Read-only mirror: press windows are run by the Worker's cron slots (00/06/12/18 UTC). This tab is where you note what went out; nothing here sends anything."); }
  SpreadsheetApp.getUi().alert("Tabs ready. Set TAPSTALL_CODE / TAPSTALL_KEY in Script Properties, then Sync my leads.");
}

function api_(path, method, payload) {
  var c = props_();
  if (!c.code || !c.key) throw new Error("Set TAPSTALL_CODE and TAPSTALL_KEY in Project Settings → Script Properties first.");
  var opts = { method: method || "get", muteHttpExceptions: true };
  if (payload) { opts.contentType = "application/json"; opts.payload = JSON.stringify(payload); }
  var sep = path.indexOf("?") >= 0 ? "&" : "?";
  var url = c.origin + path + sep + "code=" + encodeURIComponent(c.code) + "&key=" + encodeURIComponent(c.key);
  var res = UrlFetchApp.fetch(url, opts);
  var json = {};
  try { json = JSON.parse(res.getContentText()); } catch (e) { json = { ok: false, error: res.getContentText().slice(0, 200) }; }
  json._status = res.getResponseCode();
  return json;
}

function syncLeads() {
  var json = api_("/api/leads?limit=500");
  if (!json.ok) { SpreadsheetApp.getUi().alert("Sync failed: " + (json.error || json._status)); return; }
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Leads") || SpreadsheetApp.getActiveSpreadsheet().insertSheet("Leads");
  sh.clear();
  var head = ["id", "business", "status", "score", "phone", "email", "whatsapp", "source", "segment", "country", "next_follow", "notes", "DO", "RESULT"];
  sh.appendRow(head);
  sh.getRange(1, 1, 1, head.length).setFontWeight("bold");
  (json.leads || []).forEach(function (l) {
    sh.appendRow([l.id, l.business, l.status, l.score, l.phone || "", l.email || "", l.whatsapp || "",
      l.source_url || "", l.segment || "", l.country || "",
      l.next_follow_at ? new Date(l.next_follow_at).toISOString().slice(0, 10) : "",
      (l.history || []).map(function (h) { return h.action; }).join(" → "), "", ""]);
  });
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(ACTIONS.concat([""]), true).build();
  if (json.leads && json.leads.length) sh.getRange(2, 13, json.leads.length, 1).setDataValidation(rule);
  sh.setFrozenRows(1);
  SpreadsheetApp.getActiveSpreadsheet().toast("Synced " + (json.leads || []).length + " leads for " + json.as + ".");
}

function sendActions() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Leads");
  if (!sh) { SpreadsheetApp.getUi().alert("Run Sync my leads first."); return; }
  var last = sh.getLastRow();
  var done = 0, conflicts = 0;
  for (var r = 2; r <= last; r++) {
    var act = String(sh.getRange(r, 13).getValue() || "").trim();
    if (!act) continue;
    var id = sh.getRange(r, 1).getValue();
    var res = api_("/api/leads/act", "post", { id: id, action: act });
    if (res.ok) { done++; sh.getRange(r, 14).setValue("ok → " + res.lead.status); sh.getRange(r, 3).setValue(res.lead.status); }
    else { conflicts++; sh.getRange(r, 14).setValue("REFUSED: " + (res.error || res._status)); }
    sh.getRange(r, 13).setValue("");
  }
  ss.toast("Actions sent: " + done + " ok, " + conflicts + " refused (see RESULT).");
}

function exportNewContacts() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("NEW_CONTACTS");
  var rows = sh.getRange(2, 1, Math.max(0, sh.getLastRow() - 1), 8).getValues();
  var leads = rows.filter(function (r) { return r[0]; }).map(function (r) {
    return { business: r[0], email: r[1], phone: r[2], website: r[3], source_url: r[4], note: r[5], segment: r[6] || "social_merchants", country: r[7] || "" };
  });
  if (!leads.length) { ss.toast("NEW_CONTACTS is empty."); return; }
  var c = props_();
  // Ingest is owner-gated at the Worker: the owner merges hunted rows, so this needs owner credentials.
  var res = UrlFetchApp.fetch(c.origin + "/api/leads/ingest", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { "x-tapstall-admin": c.code === "owner" ? c.key : "", "x-confirm": "yes" },
    payload: JSON.stringify({ leads: leads })
  });
  ss.toast(res.getResponseCode() === 200 ? "Exported: " + res.getContentText().slice(0, 120) : "Export refused (" + res.getResponseCode() + ") — ingest is owner-gated; send the tab to the owner instead.");
}

function applyDeletions() {
  // DELETIONS lists lead ids from the Leads tab (or emails/phones that match a lead there).
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var del = ss.getSheetByName("DELETIONS");
  var want = del.getRange(2, 1, Math.max(0, del.getLastRow() - 1), 1).getValues().map(function (r) { return String(r[0] || "").trim(); }).filter(String);
  if (!want.length) { ss.toast("DELETIONS is empty."); return; }
  var sh = ss.getSheetByName("Leads");
  var n = 0;
  for (var r = 2; r <= sh.getLastRow(); r++) {
    var id = String(sh.getRange(r, 1).getValue());
    var email = String(sh.getRange(r, 6).getValue()), phone = String(sh.getRange(r, 5).getValue());
    if (want.indexOf(id) >= 0 || want.indexOf(email) >= 0 || want.indexOf(phone) >= 0) {
      var res = api_("/api/leads/act", "post", { id: id, action: "dnc" });
      sh.getRange(r, 14).setValue(res.ok ? "DNC set" : "DNC refused: " + (res.error || ""));
      if (res.ok) n++;
    }
  }
  ss.toast("DNC applied to " + n + " lead(s). They can never be re-hunted back in.");
}

/** Owner only — run from the script editor. Registers each REGISTER_SELLER row. */
function registerSellers() {
  var c = props_();
  if (c.code !== "owner") throw new Error("REGISTER_SELLER is owner-only (needs TAPSTALL_CODE=owner).");
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("REGISTER_SELLER");
  var rows = sh.getRange(2, 1, Math.max(0, sh.getLastRow() - 1), 3).getValues();
  rows.forEach(function (r) {
    if (!r[0]) return;
    var res = UrlFetchApp.fetch(c.origin + "/ops/api/sellers", {
      method: "post", contentType: "application/json", muteHttpExceptions: true,
      headers: { "x-tapstall-admin": c.key, "x-confirm": "yes" },
      payload: JSON.stringify({ action: "register", code: r[0], name: r[1], commission_pct: r[2] || 30 })
    });
    Logger.log(r[0] + " → " + res.getContentText()); // contains the one-time seller_key — copy it out, then clear logs
  });
}

function installTrigger() {
  ScriptApp.newTrigger("syncLeads").timeBased().everyMinutes(30).create();
  SpreadsheetApp.getActiveSpreadsheet().toast("Auto-sync every 30 minutes installed.");
}
