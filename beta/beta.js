// Closed-testing guide. Share links like https://faidahq.com/beta/?app=biasharathrive
//
// To add an app: create a Google Group (anyone can join), attach it to the app's
// Play closed-testing track, and add an entry below. No backend is involved.
(function () {
  var APPS = {
    biasharathrive: {
      name: 'BiasharaThrive',
      icon: '/img/biasharathrive-icon.png',
      groupUrl: 'https://groups.google.com/g/biasharathrive-testers',
      optInUrl: 'https://play.google.com/apps/testing/com.biashara.thrive',
      playUrl: 'https://play.google.com/store/apps/details?id=com.biashara.thrive'
    }
  };

  var key = (new URLSearchParams(location.search).get('app') || '').toLowerCase();
  var app = Object.prototype.hasOwnProperty.call(APPS, key) ? APPS[key] : null;
  var $ = function (id) { return document.getElementById(id); };

  if (!app) { $('state-unknown').classList.remove('d-none'); return; }

  $('app-name').textContent = app.name;
  $('app-icon').src = app.icon;
  $('app-icon').alt = app.name;
  $('group-link').href = app.groupUrl;
  $('optin-link').href = app.optInUrl;
  $('play-link').href = app.playUrl;
  document.title = 'Join the ' + app.name + ' beta - FaidaHQ';
  $('state-steps').classList.remove('d-none');
})();
