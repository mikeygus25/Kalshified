/**
 * Google Sheets sync via Apps Script web hook.
 * No OAuth, no service accounts — just a URL in .env.
 *
 * Setup: see instructions printed by `node setup-sheets.js`
 *
 * Google's /exec endpoint returns a 302 redirect to googleusercontent.com.
 * We must re-POST to that URL — following the redirect as a GET won't fire doPost.
 */
const axios = require("axios");

function isConfigured() {
  return !!process.env.GOOGLE_APPS_SCRIPT_URL;
}

async function appendRow(values) {
  if (!isConfigured()) return;
  // POST to /exec — doPost runs immediately; Google returns 302 to deliver the response.
  // axios follows the redirect as GET, which is correct.
  await axios.post(process.env.GOOGLE_APPS_SCRIPT_URL, { row: values }, {
    headers: { "Content-Type": "application/json" },
    maxRedirects: 5,
  });
}

module.exports = { appendRow, isConfigured };
