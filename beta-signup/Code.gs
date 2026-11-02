/**
 * FaidaHQ closed-testing sign-up.
 *
 * Bound to a Google Sheet (the sign-up log) and deployed as a web app that
 * executes as the Workspace admin and is reachable by "Anyone". The
 * faidahq.com/beta page posts an email here; we add it to the Google Group
 * that is attached to the app's Play closed-testing track.
 *
 * Requires the "Admin Directory API" advanced service (Services -> + ->
 * Admin SDK API). See SETUP.md.
 *
 * To add another app: add one entry to APPS and create its Google Group.
 */

var APPS = {
  biasharathrive: {
    name: 'BiasharaThrive',
    icon: '/img/biasharathrive-icon.png',
    group: 'REPLACE-biasharathrive-testers@faidahq.com',
    optInUrl: 'https://play.google.com/apps/testing/REPLACE.PACKAGE.NAME',
    playUrl: 'https://play.google.com/store/apps/details?id=REPLACE.PACKAGE.NAME'
  }
};

var LOG_SHEET = 'Signups';
// Must start alphanumeric so a logged value can never be read as a sheet formula (=, +, -, @).
var EMAIL_RE = /^[A-Za-z0-9][^\s@]*@[^\s@]+\.[^\s@]{2,}$/;
var MAX_PER_MINUTE = 20; // global cap, blunts bots flooding the group

/** Page loads this to learn the app's display name and icon. */
function doGet(e) {
  var app = APPS[String((e && e.parameter && e.parameter.app) || '').toLowerCase()];
  if (!app) return json_({ ok: false, error: 'unknown_app' });
  return json_({ ok: true, name: app.name, icon: app.icon });
}

/** Body is text/plain JSON {app, email, website} so the browser sends no preflight. */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }

  // Honeypot: real users never fill the hidden "website" field.
  if (body.website) return json_({ ok: true, optInUrl: '', playUrl: '' });

  var key = String(body.app || '').toLowerCase();
  var app = APPS[key];
  if (!app) return json_({ ok: false, error: 'unknown_app' });

  var email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json_({ ok: false, error: 'invalid_email' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (!allow_()) return json_({ ok: false, error: 'busy' });

    var status = 'added';
    try {
      AdminDirectory.Members.insert({ email: email, role: 'MEMBER' }, app.group);
    } catch (err) {
      if (/already exists|duplicate/i.test(String(err))) {
        status = 'already_member';
      } else {
        log_(key, email, 'error: ' + err);
        return json_({ ok: false, error: 'server_error' });
      }
    }
    log_(key, email, status);
    return json_({ ok: true, status: status, optInUrl: app.optInUrl, playUrl: app.playUrl });
  } finally {
    lock.releaseLock();
  }
}

function allow_() {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('rate') || 0);
  if (n >= MAX_PER_MINUTE) return false;
  cache.put('rate', String(n + 1), 60);
  return true;
}

function log_(app, email, status) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(['Time', 'App', 'Email', 'Status']);
  sheet.appendRow([new Date(), app, email, status]);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
