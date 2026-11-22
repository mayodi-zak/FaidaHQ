// FaidaHQ super-admin dashboard. Access is enforced by the database:
// admin_business_overview() and the admin RLS policies only work for users in
// public.platform_admins. This page just presents those tools.
(function () {
  "use strict";
  var FQ = window.FQ, esc = FQ.esc, $ = FQ.$, $$ = FQ.$$;
  var app = $("#app");
  var plans = [];

  function boot() {
    if (!FQ.configured || !FQ.db) return FQ.renderSetupNotice(app);
    FQ.db.auth.getSession().then(function (r) {
      if (r.data.session) check(r.data.session);
      else FQ.renderAuth(app, "FaidaHQ platform admin", check);
    });
  }

  function check(session) {
    FQ.db.from("platform_admins").select("user_id").eq("user_id", session.user.id).then(function (r) {
      if (r.error || !r.data.length) {
        app.innerHTML = '<div class="auth-card"><h1>Not allowed</h1><p>This account is not a FaidaHQ platform admin.</p><p><a href="/dashboard/">Go to your business dashboard</a></p><button class="link" id="so">Sign out</button></div>';
        $("#so").onclick = function () { FQ.db.auth.signOut().then(function () { location.reload(); }); };
        return;
      }
      render(session);
    });
  }

  function render(session) {
    app.innerHTML = '<div class="layout"><aside class="sidebar"><div class="side-brand"><img src="/img/logo-white.png" alt="FaidaHQ"></div>' +
      '<div class="side-biz"><strong class="biz-name">Platform admin</strong></div><nav>' +
      '<a href="#businesses" data-nav="businesses">🏢 Businesses</a><a href="#messages" data-nav="messages">✉️ Website messages</a><a href="#ai" data-nav="ai">🤖 AI providers</a><a href="/dashboard/">📊 Business dashboard</a></nav>' +
      '<div class="side-foot"><span>' + esc(session.user.email) + '</span><button class="link light" id="so">Sign out</button></div></aside>' +
      '<div class="main"><header class="topbar"><h1 id="title">Businesses</h1></header><section class="view" id="view"><p class="muted">Loading…</p></section></div></div>';
    $("#so").onclick = function () { FQ.db.auth.signOut().then(function () { location.reload(); }); };
    window.onhashchange = route;
    route();
  }

  function route() {
    var page = location.hash === "#ai" ? "ai" : location.hash === "#messages" ? "messages" : "businesses";
    $$("[data-nav]").forEach(function (a) { a.classList.toggle("active", a.dataset.nav === page); });
    $("#title").textContent = page === "ai" ? "AI providers" : page === "messages" ? "Website messages" : "Businesses";
    $("#view").innerHTML = '<p class="muted">Loading…</p>';
    if (page === "ai") loadAi(); else if (page === "messages") loadMessages(); else load();
  }

  // Messages sent from the contact page on faidahq.com.
  function loadMessages() {
    FQ.q(FQ.db.from("contact_messages").select("*").order("created_at", { ascending: false }).limit(200), "Load messages").then(function (rows) {
      var view = $("#view");
      view.innerHTML = '<div class="card">' + (rows.length ? rows.map(function (m) {
        return '<div class="suggestion"><strong>' + esc(m.subject) + '</strong> <span class="pill ' + (m.status === "new" ? "warning" : "good") + '">' + esc(m.status) + "</span>" +
          '<p class="muted">' + esc(m.name) + ' · <a href="mailto:' + esc(m.email) + '?subject=' + encodeURIComponent("Re: " + m.subject) + '">' + esc(m.email) + "</a> · " + FQ.date(m.created_at, true) +
          (m.notified ? "" : " · alert email not sent") + "</p>" +
          '<p style="white-space:pre-wrap">' + esc(m.message) + "</p>" +
          '<button class="btn ghost" data-toggle="' + m.id + '" data-to="' + (m.status === "new" ? "handled" : "new") + '">' + (m.status === "new" ? "Mark handled" : "Reopen") + "</button></div>";
      }).join("") : '<p class="empty">No messages yet.</p>') + "</div>";
      $$("[data-toggle]", view).forEach(function (b) {
        b.onclick = function () {
          FQ.q(FQ.db.from("contact_messages").update({ status: b.dataset.to }).eq("id", b.dataset.toggle), "Update").then(loadMessages);
        };
      });
    });
  }

  function load() {
    Promise.all([
      FQ.q(FQ.db.rpc("admin_business_overview"), "Load businesses"),
      FQ.q(FQ.db.from("plans").select("*").order("monthly_price"), "Load plans"),
    ]).then(function (r) {
      var rows = r[0]; plans = r[1];
      var active = rows.filter(function (b) { return b.status === "active"; }).length;
      var mrr = rows.filter(function (b) { return b.subscription_status === "active"; }).reduce(function (a, b) {
        var p = plans.filter(function (x) { return x.code === b.plan_code; })[0]; return a + (p ? Number(p.monthly_price) : 0);
      }, 0);
      var replies = rows.reduce(function (a, b) { return a + Number(b.ai_replies_month); }, 0);
      var tokens = rows.reduce(function (a, b) { return a + Number(b.tokens_month); }, 0);
      var view = $("#view");
      view.innerHTML = '<div class="kpis">' +
        k("Businesses", rows.length + " (" + active + " active)") + k("Monthly recurring (paid subs)", "KES " + FQ.num(mrr)) +
        k("AI replies this month", FQ.num(replies)) + k("AI tokens this month", FQ.num(tokens)) + "</div>" +
        '<div class="toolbar"><input id="find" type="search" placeholder="Search businesses" aria-label="Search"><button class="btn" id="new">+ New business</button></div>' +
        '<div id="tbl"></div>' +
        '<div class="card" style="margin-top:18px"><h2>Plans</h2>' + table(["Code", "Name", "Setup fee", "Monthly", "Replies / month"], plans.map(function (p) {
          return [esc(p.code), esc(p.name), FQ.money(p.setup_fee, p.currency), FQ.money(p.monthly_price, p.currency), FQ.num(p.monthly_message_limit)];
        })) + '<p class="muted">Payments are not processed yet. Record setup fees and subscription status manually per business.</p></div>';
      function draw(t) {
        t = (t || "").toLowerCase();
        var shown = rows.filter(function (b) { return !t || (b.name + " " + b.slug + " " + (b.owner_email || "")).toLowerCase().indexOf(t) >= 0; });
        $("#tbl").innerHTML = table(["Business", "Owner", "Status", "Plan", "Usage this month", "Chats (30d)", "Pending bookings", ""], shown.map(function (b) {
          var pct = b.effective_limit ? Math.round(b.ai_replies_month / b.effective_limit * 100) : 0;
          return ["<strong>" + esc(b.name) + "</strong><br><small class=\"muted\">" + esc(b.type.replace("_", " & ")) + " · " + esc(b.slug) + "</small>",
            esc(b.owner_email || "—"),
            '<span class="pill ' + (b.status === "active" ? "good" : b.status === "suspended" ? "critical" : "warning") + '">' + esc(b.status) + "</span>",
            esc(b.plan_code) + "<br><small>" + esc(b.subscription_status) + (b.setup_fee_paid ? " · setup paid" : " · setup unpaid") + "</small>",
            FQ.num(b.ai_replies_month) + " / " + FQ.num(b.effective_limit) + ' <small class="' + (pct >= 80 ? "warn" : "muted") + '">(' + pct + "%)</small>",
            FQ.num(b.conversations_30d), FQ.num(b.pending_reservations),
            '<button class="link" data-manage="' + b.id + '">Manage</button><br>' +
              (b.status === "active"
                ? '<a class="link" href="/preview/?b=' + b.id + '" target="_blank" rel="noopener">Test chat</a><br><button class="link" data-copylink="' + b.id + '">Copy client link</button>'
                : '<small class="muted">Activate to test</small>')];
        }));
        $$("[data-copylink]").forEach(function (btn) {
          btn.onclick = function () { navigator.clipboard.writeText(location.origin + "/preview/?b=" + btn.dataset.copylink).then(function () { FQ.toast("Client link copied"); }); };
        });
        $$("[data-manage]").forEach(function (btn) {
          btn.onclick = function () { manage(rows.filter(function (b) { return b.id === btn.dataset.manage; })[0]); };
        });
      }
      $("#find").oninput = function () { draw(this.value); };
      $("#new").onclick = createBusiness;
      draw("");
    });
  }

  function k(label, v) { return '<div class="kpi"><span>' + label + "</span><strong style=\"font-size:20px\">" + v + "</strong></div>"; }
  function table(head, rows) {
    return '<div class="table-wrap"><table><thead><tr>' + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>";
  }
  function options(list, value) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("");
  }

  function manage(b) {
    FQ.modal("Manage " + b.name,
      '<div class="form-grid">' +
      '<label>Status<select name="status">' + options([["active", "Active"], ["suspended", "Suspended (widget stops answering)"], ["pending", "Pending"]], b.status) + "</select></label>" +
      '<label>Plan<select name="plan_code">' + options(plans.map(function (p) { return [p.code, p.name + " (" + FQ.num(p.monthly_message_limit) + " replies)"]; }), b.plan_code) + "</select></label>" +
      '<label>Subscription<select name="subscription_status">' + options([["trial", "Trial"], ["active", "Active (paid)"], ["past_due", "Past due"], ["cancelled", "Cancelled"]], b.subscription_status) + "</select></label>" +
      '<label>Monthly reply limit override<input name="monthly_message_limit" type="number" min="0" placeholder="Use plan limit" value="' + (b.monthly_message_limit == null ? "" : b.monthly_message_limit) + '"></label>' +
      '<label class="check full"><input type="checkbox" name="setup_fee_paid"' + (b.setup_fee_paid ? " checked" : "") + "> Setup fee paid</label>" +
      '<label class="full">Add an owner by email (they must have signed up)<input name="owner_email" type="email" placeholder="owner@hotel.co.ke"></label></div>',
      function (form) {
        var d = FQ.formData(form);
        var limit = d.monthly_message_limit === "" ? null : parseInt(d.monthly_message_limit, 10);
        if (limit !== null && !(limit >= 0)) throw new Error("Limit must be 0 or more.");
        var patch = { status: d.status, plan_code: d.plan_code, subscription_status: d.subscription_status, setup_fee_paid: d.setup_fee_paid, monthly_message_limit: limit };
        return FQ.q(FQ.db.from("businesses").update(patch).eq("id", b.id), "Save").then(function () {
          if (d.owner_email) return FQ.q(FQ.db.rpc("add_business_member", { p_business_id: b.id, p_email: d.owner_email, p_role: "owner" }), "Add owner");
        }).then(function () { FQ.toast("Saved"); load(); });
      });
  }

  function createBusiness() {
    FQ.modal("New business",
      '<div class="form-grid"><label class="full">Business name<input name="name" required maxlength="120"></label>' +
      '<label>Type<select name="type">' + options([["hotel", "Hotel / resort"], ["restaurant", "Restaurant"], ["hotel_restaurant", "Hotel with restaurant"], ["cafe", "Café"]], "hotel") + "</select></label>" +
      '<label>Plan<select name="plan_code">' + options(plans.map(function (p) { return [p.code, p.name]; }), "starter") + "</select></label>" +
      '<label class="full">Owner email (optional, must have signed up)<input name="owner_email" type="email"></label></div>',
      function (form) {
        var d = FQ.formData(form);
        if (d.name.length < 2) throw new Error("Name is required.");
        var slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + Math.random().toString(36).slice(2, 6);
        return FQ.q(FQ.db.from("businesses").insert({ name: d.name, slug: slug, type: d.type, plan_code: d.plan_code, status: "active" }).select("id").single(), "Create").then(function (row) {
          return FQ.q(FQ.db.from("ai_settings").insert({ business_id: row.id }), "AI settings").then(function () {
            if (d.owner_email) return FQ.q(FQ.db.rpc("add_business_member", { p_business_id: row.id, p_email: d.owner_email, p_role: "owner" }), "Add owner");
          });
        }).then(function () { FQ.toast("Business created"); load(); });
      }, "Create");
  }

  // ---------------------------------------------------------------------------
  // AI providers. Keys are sent once to the admin-ai-keys Edge Function, which
  // checks this user is a platform admin, encrypts the key and stores it. The
  // browser can never read a saved key back: it only gets "…abcd" hints.

  function keys(body) {
    return FQ.db.functions.invoke("admin-ai-keys", { body: body }).then(function (r) {
      if (!r.error) return r.data;
      var ctx = r.error.context;
      var read = ctx && typeof ctx.json === "function" ? ctx.json().catch(function () { return {}; }) : Promise.resolve({});
      return read.then(function (j) { throw new Error((j && j.message) || r.error.message || "Request failed"); });
    });
  }

  var MODEL_HINTS = {
    anthropic: "e.g. claude-opus-5-5 or claude-haiku-5-5 (empty = claude-opus-5-5)",
    openai: "e.g. gpt-5-mini (required)",
    gemini: "e.g. gemini-2.5-flash (required)",
    openai_compatible: "the model name your service uses (required)",
  };

  function loadAi() {
    keys({ action: "list" }).then(drawAi).catch(function (e) {
      $("#view").innerHTML = '<div class="card"><h2>Could not load AI providers</h2><p>' + esc(e.message) + "</p>" +
        '<p class="muted">Make sure the <code>admin-ai-keys</code> function is deployed (see docs/SETUP.md).</p></div>';
    });
  }

  function statusPill(p) {
    if (p.key_saved) return '<span class="pill good" style="text-transform:none">Key saved ' + esc(p.key_hint || "") + "</span>";
    if (p.env_configured) return '<span class="pill info" style="text-transform:none">Using server secret</span>';
    return '<span class="pill" style="text-transform:none">Not set</span>';
  }

  function drawAi(data) {
    var provs = data.providers;
    var choices = provs.map(function (p) { return [p.provider, p.label]; });
    var envDefault = data.env_default_provider ? " (AI_PROVIDER secret: " + data.env_default_provider + ")" : " (Anthropic)";
    $("#view").innerHTML =
      (data.encryption_ready ? "" :
        '<div class="card" style="border-color:var(--warning)"><h2>⚠️ Encryption key missing</h2><p>Before you can save keys, set the secret <code>FAIDAHQ_ENCRYPTION_KEY</code> once:</p>' +
        '<pre>supabase secrets set FAIDAHQ_ENCRYPTION_KEY="$(openssl rand -base64 32)"</pre><p class="muted">Keep a private copy. If it changes, saved keys must be entered again.</p></div>') +
      '<div class="card"><h2>Which AI answers guests</h2><form id="defaults" class="form-grid">' +
      '<label>Main provider<select name="default_provider">' + options([["", "Server setting" + envDefault]].concat(choices), data.default_provider || "") + "</select></label>" +
      '<label>Fallback provider (used if the main one fails)<select name="fallback_provider">' + options([["", "None"]].concat(choices), data.fallback_provider || "") + "</select></label>" +
      '<div class="full"><button class="btn" type="submit">Save choice</button></div></form>' +
      '<p class="muted">A business can still choose its own provider and model in its dashboard (AI configuration).</p></div>' +
      '<div class="card"><h2>API keys</h2><p class="muted">Keys are encrypted on the server and can never be shown again, only replaced or deleted.</p>' +
      table(["Provider", "Status", "Default model", ""], provs.map(function (p) {
        return ["<strong>" + esc(p.label) + "</strong>" + (p.base_url ? '<br><small class="muted">' + esc(p.base_url) + "</small>" : ""),
          statusPill(p) + (p.updated_at ? '<br><small class="muted">Updated ' + esc(FQ.date(p.updated_at, true)) + "</small>" : ""),
          esc(p.default_model || "—"),
          '<button class="btn small" data-key="' + p.provider + '">' + (p.key_saved ? "Replace / edit" : "Add key") + "</button> " +
          (p.key_saved || p.env_configured ? '<button class="btn small ghost" data-test="' + p.provider + '">Test</button> ' : "") +
          (p.key_saved ? '<button class="link" data-del="' + p.provider + '">Delete</button>' : "")];
      })) + "</div>";

    $("#defaults").onsubmit = function (e) {
      e.preventDefault();
      var d = FQ.formData(this);
      if (d.default_provider && d.default_provider === d.fallback_provider) return FQ.toast("Pick a different fallback provider.", "error");
      keys({ action: "set_defaults", default_provider: d.default_provider || null, fallback_provider: d.fallback_provider || null })
        .then(function (r) { FQ.toast("Saved"); drawAi(r); }).catch(function (e2) { FQ.toast(e2.message, "error"); });
    };
    $$("[data-key]").forEach(function (b) {
      b.onclick = function () { editKey(provs.filter(function (p) { return p.provider === b.dataset.key; })[0]); };
    });
    $$("[data-test]").forEach(function (b) {
      b.onclick = function () {
        b.disabled = true; b.textContent = "Testing…";
        keys({ action: "test", provider: b.dataset.test }).then(function (r) {
          FQ.toast(r.message, r.ok ? "ok" : "error");
        }).catch(function (e) { FQ.toast(e.message, "error"); }).then(function () { b.disabled = false; b.textContent = "Test"; });
      };
    });
    $$("[data-del]").forEach(function (b) {
      b.onclick = function () {
        if (!FQ.confirm("Delete the saved key for this provider? The server secret (if any) will be used instead.")) return;
        keys({ action: "delete", provider: b.dataset.del }).then(function (r) { FQ.toast("Key deleted"); drawAi(r); })
          .catch(function (e) { FQ.toast(e.message, "error"); });
      };
    });
  }

  function editKey(p) {
    var needsUrl = p.provider === "openai_compatible";
    FQ.modal((p.key_saved ? "Edit " : "Add ") + p.label,
      '<div class="form-grid">' +
      '<label class="full">API key<input name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="' +
        (p.key_saved ? "Leave empty to keep the saved key (" + esc(p.key_hint || "") + ")" : "Paste the key") + '"></label>' +
      '<label class="full">Default model<input name="default_model" maxlength="100" value="' + esc(p.default_model || "") + '" placeholder="' + esc(MODEL_HINTS[p.provider]) + '"></label>' +
      (needsUrl || p.base_url ? '<label class="full">Base URL' + (needsUrl ? "" : " (optional)") + '<input name="base_url" type="url" value="' + esc(p.base_url || "") + '" placeholder="https://openrouter.ai/api/v1"></label>' : "") +
      '</div><p class="muted">The key is sent once over HTTPS, encrypted on the server, and never shown again.</p>',
      function (form) {
        var d = FQ.formData(form);
        if (!p.key_saved && !d.api_key) throw new Error("Paste the API key.");
        return keys({ action: "save", provider: p.provider, api_key: d.api_key || undefined, default_model: d.default_model, base_url: d.base_url })
          .then(function (r) { FQ.toast("Saved"); drawAi(r); });
      }, "Save");
  }

  boot();
})();
