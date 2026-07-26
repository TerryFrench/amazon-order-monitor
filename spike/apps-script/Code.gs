/**
 * AOM Spike — minimal Apps Script email relay (experiment D).
 *
 * Deploy (one time, ~3 minutes):
 *  1. Go to https://script.new (logged into the Google account that should
 *     receive the emails).
 *  2. Replace the default code with this file. Save. Rename the project
 *     (top-left, "Untitled project") to e.g. "AOM Spike Relay".
 *  3. Project Settings (gear icon) -> Script Properties -> Add property:
 *       SHARED_SECRET = <any random string; you'll paste the same one
 *                        into the spike popup>
 *  4. Deploy -> New deployment -> type "Web app":
 *       Execute as: Me
 *       Who has access: Anyone
 *  5. Authorize when prompted (it only asks for "send email as you").
 *  6. Copy the Web app URL (ends in /exec) into the spike popup.
 */

function doPost(e) {
  var out;
  try {
    var data = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
    if (!secret || !data || data.secret !== secret) {
      out = { ok: false, error: "unauthorized" };
    } else {
      var subject = String(data.subject || "(no subject)").slice(0, 200).replace(/[\r\n]/g, " ");
      var body = String(data.body || "").slice(0, 20000);
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
      out = { ok: true, remaining: MailApp.getRemainingDailyQuota() };
    }
  } catch (err) {
    out = { ok: false, error: "bad_request" };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}
