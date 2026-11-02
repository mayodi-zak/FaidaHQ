// Closed-testing sign-up. Talks to the Apps Script web app in /beta-signup/Code.gs.
// Share links like https://faidahq.com/beta/?app=biasharathrive
(function () {
  // Paste the Apps Script web-app URL here after deploying (see beta-signup/SETUP.md).
  var SCRIPT_URL = 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE';

  var app = (new URLSearchParams(location.search).get('app') || '').toLowerCase();
  var $ = function (id) { return document.getElementById(id); };
  var states = ['loading', 'unknown', 'form', 'done'];

  function show(name) {
    states.forEach(function (s) {
      $('state-' + s).classList.toggle('d-none', s !== name);
    });
  }

  function showError(msg) {
    var el = $('form-error');
    el.textContent = msg;
    el.classList.remove('d-none');
  }

  var ERRORS = {
    invalid_email: 'That email doesn\'t look right. Check it and try again.',
    busy: 'Lots of people are joining right now. Please try again in a minute.',
    unknown_app: 'This beta link isn\'t valid.',
    server_error: 'Something went wrong on our side. Please try again shortly.'
  };

  if (!app || SCRIPT_URL.indexOf('PASTE_') === 0) { show('unknown'); return; }

  fetch(SCRIPT_URL + '?app=' + encodeURIComponent(app))
    .then(function (r) { return r.json(); })
    .then(function (info) {
      if (!info.ok) { show('unknown'); return; }
      $('app-name').textContent = info.name;
      $('app-icon').src = info.icon;
      $('app-icon').alt = info.name;
      document.title = 'Join the ' + info.name + ' beta - FaidaHQ';
      show('form');
    })
    .catch(function () { show('unknown'); });

  $('beta-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('form-error').classList.add('d-none');
    var email = $('email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { showError(ERRORS.invalid_email); return; }

    var btn = $('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Adding you...';

    // text/plain keeps this a "simple" request, so the browser sends no CORS preflight.
    fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ app: app, email: email, website: $('website').value })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) { showError(ERRORS[res.error] || ERRORS.server_error); return; }
        $('optin-link').href = res.optInUrl;
        $('play-link').href = res.playUrl;
        show('done');
      })
      .catch(function () { showError('Couldn\'t reach the server. Check your connection and try again.'); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Join the beta';
      });
  });
})();
