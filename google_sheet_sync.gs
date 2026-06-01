/**
 * G&T Chickens — live record-keeping sync.
 *
 * Pulls the lot + genealogy data from the receiving app and rewrites two tabs in
 * THIS Google Sheet ("Lots" and "Process Events"). Runs on a time trigger so the
 * spreadsheet is a constantly-updating mirror of the database.
 *
 * SETUP (one time, ~2 minutes):
 *   1. Open (or create) the Google Sheet you want the records in.
 *   2. Extensions → Apps Script. Delete any sample code, paste THIS whole file.
 *   3. Press Save. Run the function "syncNow" once — Google will ask you to
 *      authorise (it only touches this sheet + fetches the public export URL).
 *   4. Run "installTrigger" once. That schedules syncNow every minute.
 *   5. Done. The Lots and Process Events tabs now refresh automatically.
 *
 * To change how often it runs, edit MINUTES below and re-run installTrigger.
 */

var BASE = 'https://gt-receiving-pwa.vercel.app';
var MINUTES = 1; // refresh interval (1, 5, 10, 15, or 30 allowed by Google)

function syncNow() {
  writeTab_('Lots', BASE + '/api/export?dataset=lots&format=json');
  writeTab_('Process Events', BASE + '/api/export?dataset=events&format=json');
  // Stamp the last refresh time on a small status cell.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lots = ss.getSheetByName('Lots');
  if (lots) {
    lots.getRange(1, 1).setNote('Last synced: ' + new Date());
  }
}

function writeTab_(tabName, url) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);

  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    sheet.getRange(1, 1).setValue('Sync error ' + resp.getResponseCode() + ' at ' + new Date());
    return;
  }
  var data = JSON.parse(resp.getContentText());
  var header = data.header || [];
  var rowsObj = data.rows || [];

  // Build a 2D array: header row + one row per record (in header order).
  // The JSON `rows` are objects keyed by snake_case; map them to the header order
  // by position using the same field list the API emits.
  var keys = fieldKeysFor_(tabName);
  var out = [header];
  for (var i = 0; i < rowsObj.length; i++) {
    var r = rowsObj[i];
    var line = [];
    for (var k = 0; k < keys.length; k++) line.push(r[keys[k]] != null ? r[keys[k]] : '');
    out.push(line);
  }

  sheet.clearContents();
  if (out.length && out[0].length) {
    sheet.getRange(1, 1, out.length, out[0].length).setValues(out);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, out[0].length).setFontWeight('bold');
  }
}

// Field order must match the API's JSON object keys for each dataset.
function fieldKeysFor_(tabName) {
  if (tabName === 'Process Events') {
    return ['event_id', 'event_type', 'process_date', 'operator', 'made_from',
            'output_lot', 'output_product', 'output_weight_kg', 'output_qty',
            'output_unit', 'output_use_by', 'output_status', 'notes'];
  }
  return ['lot_code', 'product', 'origin', 'status', 'supplier', 'supplier_batch',
          'kill_date', 'production_date', 'use_by', 'quantity', 'unit', 'weight_kg',
          'container', 'notes', 'has_photo', 'logged_at'];
}

function installTrigger() {
  // Remove existing syncNow triggers so we don't stack duplicates.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncNow') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(MINUTES).create();
  syncNow();
}
