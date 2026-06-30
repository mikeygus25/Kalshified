/**
 * Prints step-by-step instructions for connecting Google Sheets via Apps Script.
 * Run: node setup-sheets.js
 */

const SCRIPT = `
const HEADERS = [
  'Timestamp','Date','Time','Action','Ticker','Title','Side','Contracts',
  'Price (cents)','Price ($)','Total ($)','Avg Entry ($)','PnL ($)',
  'Cumulative PnL ($)','Trigger','Order ID'
];

function doPost(e) {
  try {
    const data  = JSON.parse(e.postData.contents);
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    let sheet   = ss.getSheetByName('Trades') || ss.insertSheet('Trades');

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length)
           .setFontWeight('bold')
           .setBackground('#f3f4f6');
      sheet.setFrozenRows(1);
    }

    sheet.appendRow(data.row);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
`;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║          Google Sheets Setup — 5 steps, ~3 minutes          ║
╚══════════════════════════════════════════════════════════════╝

1. Open Google Sheets and create a new spreadsheet:
   → https://sheets.new

   Name it "Kalshi Trade Log" (click the title at the top).

2. Open the script editor:
   → Extensions → Apps Script

3. Delete everything in the editor, then paste this entire script:
───────────────────────────────────────────────────────────────
${SCRIPT.trim()}
───────────────────────────────────────────────────────────────

4. Deploy it:
   a. Click  Deploy → New deployment
   b. Click the gear icon next to "Type" → select  Web app
   c. Set  Execute as: Me
   d. Set  Who has access: Anyone
   e. Click  Deploy  →  Authorize access  → choose your Google account → Allow
   f. Copy the Web app URL  (looks like https://script.google.com/macros/s/ABC.../exec)

5. Add the URL to your .env file:
   GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/ABC.../exec

Then restart the bot — the next trade will appear in the sheet automatically.
`);
