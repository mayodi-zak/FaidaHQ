// Shared helpers for the FaidaHQ business dashboard and the super-admin page.
// Plain JavaScript; Supabase JS is loaded from a CDN as a global (`supabase`).
// Only the PUBLIC anon key is used here. Row Level Security on the database
// decides what each signed-in user may read or change.
(function () {
  "use strict";
  var cfg = window.FaidaHQConfig || {};

  var FQ = (window.FQ = {});
  FQ.cfg = cfg;
  FQ.configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  FQ.db = FQ.configured && window.supabase
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true } })
    : null;

  FQ.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  FQ.$ = function (sel, root) { return (root || document).querySelector(sel); };
  FQ.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  FQ.date = function (iso, withTime) {
    if (!iso) return "—";
    var d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
    var opts = { day: "numeric", month: "short", year: "numeric" };
    if (withTime) { opts.hour = "2-digit"; opts.minute = "2-digit"; }
    return d.toLocaleString("en-GB", opts);
  };
  FQ.ago = function (iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return Math.floor(s / 86400) + " d ago";
  };
  FQ.money = function (n, cur) {
    if (n == null || n === "") return "";
    return (cur || "KES") + " " + Number(n).toLocaleString("en-US");
  };
  FQ.num = function (n) { return Number(n || 0).toLocaleString("en-US"); };

  FQ.toast = function (msg, kind) {
    var box = FQ.$("#toasts");
    if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("role", "status"); document.body.appendChild(box); }
    var t = document.createElement("div");
    t.className = "toast " + (kind || "ok");
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === "error" ? 6000 : 3000);
  };

  /** Run a Supabase query; show a toast and throw on error. */
  FQ.q = function (promise, what) {
    return Promise.resolve(promise).then(function (res) {
      if (res.error) {
        var msg = res.error.message || "Request failed";
        FQ.toast((what ? what + ": " : "") + msg, "error");
        throw res.error;
      }
      return res.data;
    });
  };

  /** Simple modal. Returns {el, close}. `onSubmit(form)` may return a promise. */
  FQ.modal = function (title, bodyHtml, onSubmit, submitLabel) {
    var wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-label="' + FQ.esc(title) + '">' +
      '<form novalidate><header><h3>' + FQ.esc(title) + '</h3><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>' +
      '<div class="modal-body">' + bodyHtml + '</div><p class="form-error" hidden></p>' +
      '<footer><button type="button" class="btn ghost" data-close>Cancel</button>' +
      (onSubmit ? '<button type="submit" class="btn">' + FQ.esc(submitLabel || "Save") + "</button>" : "") + "</footer></form></div>";
    document.body.appendChild(wrap);
    var form = wrap.querySelector("form");
    function close() { wrap.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    FQ.$$("[data-close]", wrap).forEach(function (b) { b.addEventListener("click", close); });
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!onSubmit) return close();
      var err = form.querySelector(".form-error");
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      Promise.resolve().then(function () { return onSubmit(form); }).then(function (keep) {
        if (keep !== true) close();
      }).catch(function (e2) {
        err.textContent = (e2 && e2.message) || "Could not save";
        err.hidden = false;
      }).then(function () { btn.disabled = false; });
    });
    var first = form.querySelector("input,select,textarea");
    if (first) setTimeout(function () { first.focus(); }, 30);
    return { el: wrap, close: close };
  };

  FQ.formData = function (form) {
    var out = {};
    FQ.$$("input,select,textarea", form).forEach(function (f) {
      if (!f.name) return;
      out[f.name] = f.type === "checkbox" ? f.checked : f.value.trim();
    });
    return out;
  };

  FQ.confirm = function (message) { return window.confirm(message); };

  /** Shows the "not configured yet" screen used before Supabase keys are added. */
  FQ.renderSetupNotice = function (root) {
    root.innerHTML = '<div class="auth-card"><h1>Almost there</h1>' +
      "<p>This dashboard needs a Supabase project. Add your project URL and public <em>anon</em> key to " +
      "<code>js/faidahq-config.js</code>, then reload.</p>" +
      '<p>Step-by-step instructions are in <code>docs/SETUP.md</code> in the repository.</p>' +
      '<p class="muted">Want to see the assistant first? <a href="/demo/">Open the demo resort</a>.</p></div>';
  };

  /** Sign-in / sign-up / reset screen. Calls onSignedIn(session) when done. */
  FQ.renderAuth = function (root, title, onSignedIn) {
    root.innerHTML = '<div class="auth-card"><h1>' + FQ.esc(title) + "</h1>" +
      '<form id="auth-form" novalidate>' +
      '<label>Email<input name="email" type="email" autocomplete="email" required></label>' +
      '<label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label>' +
      '<p class="form-error" hidden></p>' +
      '<button class="btn wide" type="submit" data-mode="in">Sign in</button>' +
      '<button class="btn ghost wide" type="button" data-mode="up">Create an account</button>' +
      '<button class="link" type="button" data-mode="reset">Forgot password?</button></form></div>';
    var form = FQ.$("#auth-form", root);
    var err = FQ.$(".form-error", form);
    function fail(m) { err.textContent = m; err.hidden = false; }
    function run(mode) {
      var d = FQ.formData(form);
      err.hidden = true;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return fail("Enter a valid email address.");
      if (mode === "reset") {
        return FQ.db.auth.resetPasswordForEmail(d.email, { redirectTo: location.origin + location.pathname }).then(function (r) {
          if (r.error) fail(r.error.message); else FQ.toast("Check your email for a reset link.");
        });
      }
      if (!d.password || d.password.length < 8) return fail("Password must be at least 8 characters.");
      var p = mode === "up"
        ? FQ.db.auth.signUp({ email: d.email, password: d.password, options: { emailRedirectTo: location.origin + location.pathname } })
        : FQ.db.auth.signInWithPassword({ email: d.email, password: d.password });
      return p.then(function (r) {
        if (r.error) return fail(r.error.message);
        if (!r.data.session) return FQ.toast("Account created. Check your email to confirm it, then sign in.");
        onSignedIn(r.data.session);
      });
    }
    form.addEventListener("submit", function (e) { e.preventDefault(); run("in"); });
    FQ.$$("button[type=button][data-mode]", form).forEach(function (b) {
      b.addEventListener("click", function () { run(b.getAttribute("data-mode")); });
    });
  };

  /** Single-series daily bar chart (SVG). rows: [{day:'YYYY-MM-DD', value:n}] */
  FQ.barChart = function (rows, label) {
    var W = 640, H = 180, pad = { l: 34, r: 8, t: 10, b: 24 };
    var max = Math.max(1, Math.max.apply(null, rows.map(function (r) { return r.value; })));
    var nice = Math.pow(10, Math.floor(Math.log10(max)));
    max = Math.ceil(max / nice) * nice;
    var bw = (W - pad.l - pad.r) / rows.length;
    var y = function (v) { return pad.t + (H - pad.t - pad.b) * (1 - v / max); };
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" class="chart" role="img" aria-label="' + FQ.esc(label) + '">';
    [0, max / 2, max].forEach(function (g) {
      svg += '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(g) + '" y2="' + y(g) + '" class="grid"/>' +
        '<text x="' + (pad.l - 6) + '" y="' + (y(g) + 4) + '" class="axis" text-anchor="end">' + FQ.num(g) + "</text>";
    });
    rows.forEach(function (r, i) {
      var x = pad.l + i * bw + 1, w = Math.max(2, bw - 2), top = y(r.value), h = H - pad.b - top;
      var tip = FQ.date(r.day) + ": " + FQ.num(r.value);
      svg += '<g class="bar-hit"><title>' + FQ.esc(tip) + "</title>" +
        '<rect x="' + (pad.l + i * bw) + '" y="' + pad.t + '" width="' + bw + '" height="' + (H - pad.t - pad.b) + '" fill="transparent"/>';
      if (r.value > 0) {
        var rr = Math.min(4, w / 2, h);
        svg += '<path class="bar" d="M' + x + "," + (H - pad.b) + "V" + (top + rr) + "Q" + x + "," + top + " " + (x + rr) + "," + top +
          "H" + (x + w - rr) + "Q" + (x + w) + "," + top + " " + (x + w) + "," + (top + rr) + "V" + (H - pad.b) + 'Z"/>';
      }
      svg += "</g>";
      if (i % 7 === 0 || i === rows.length - 1) {
        svg += '<text x="' + (x + w / 2) + '" y="' + (H - 6) + '" class="axis" text-anchor="middle">' + FQ.esc(FQ.date(r.day).slice(0, 6)) + "</text>";
      }
    });
    return svg + '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + (H - pad.b) + '" y2="' + (H - pad.b) + '" class="baseline"/></svg>';
  };

  /** Usage meter with status colour + text label (never colour alone). */
  FQ.meter = function (used, limit) {
    var pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    var status = pct >= 100 ? ["critical", "Limit reached"] : pct >= 80 ? ["warning", "Nearly used up"] : ["good", "Within plan"];
    return '<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="' + limit + '" aria-valuenow="' + used + '">' +
      '<div class="meter-track"><div class="meter-fill ' + status[0] + '" style="width:' + pct + '%"></div></div>' +
      '<div class="meter-label"><span>' + FQ.num(used) + " of " + FQ.num(limit) + " replies (" + pct + "%)</span>" +
      '<span class="pill ' + status[0] + '">' + status[1] + "</span></div></div>";
  };
})();
