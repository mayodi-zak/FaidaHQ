// FaidaHQ business dashboard. Each section ("view") is a small render function.
(function () {
  "use strict";
  var FQ = window.FQ, esc = FQ.esc, $ = FQ.$, $$ = FQ.$$;
  var app = $("#app");

  var S = { session: null, businesses: [], biz: null, role: null, channel: null };

  var VIEWS = [
    ["overview", "Overview", "📊"],
    ["profile", "Business profile", "🏨"],
    ["knowledge", "Knowledge base", "📚"],
    ["conversations", "Conversations", "💬"],
    ["reservations", "Reservations", "📅"],
    ["customers", "Customers", "👥"],
    ["ai", "AI configuration", "🤖"],
    ["analytics", "Usage analytics", "📈"],
    ["settings", "Account settings", "⚙️"],
  ];

  var CATEGORIES = {
    room: "Room", facility: "Facility", menu_item: "Menu item", service: "Service", hours: "Opening hours",
    policy: "Policy", offer: "Special offer", faq: "FAQ", other: "Other",
  };
  var TYPES = { hotel: "Hotel / resort", restaurant: "Restaurant", hotel_restaurant: "Hotel with restaurant", cafe: "Café" };

  function canEdit() { return S.role === "owner" || S.role === "admin" || S.role === "platform"; }
  function bid() { return S.biz.id; }

  // ------------------------------------------------------------------ boot
  function boot() {
    if (!FQ.configured || !FQ.db) return FQ.renderSetupNotice(app);
    FQ.db.auth.getSession().then(function (r) {
      if (r.data.session) start(r.data.session);
      else FQ.renderAuth(app, "FaidaHQ dashboard", start);
    });
    FQ.db.auth.onAuthStateChange(function (event, session) {
      if (event === "SIGNED_OUT") { S.session = null; FQ.renderAuth(app, "FaidaHQ dashboard", start); }
      if (event === "PASSWORD_RECOVERY") promptNewPassword();
      if (session) S.session = session;
    });
  }

  function start(session) {
    S.session = session;
    Promise.all([
      FQ.q(FQ.db.from("business_members").select("role, businesses(id, name, slug, type, status, currency)").eq("user_id", session.user.id), "Load businesses"),
      FQ.q(FQ.db.from("platform_admins").select("user_id").eq("user_id", session.user.id), "Check admin"),
    ]).then(function (res) {
      S.businesses = res[0].filter(function (m) { return m.businesses; }).map(function (m) { return Object.assign({ role: m.role }, m.businesses); });
      S.isPlatformAdmin = res[1].length > 0;
      if (!S.businesses.length) return renderOnboarding();
      var saved = localStorage.getItem("fq:biz");
      selectBusiness(S.businesses.filter(function (b) { return b.id === saved; })[0] || S.businesses[0]);
    });
  }

  function selectBusiness(b) {
    S.biz = b;
    S.role = b.role;
    try { localStorage.setItem("fq:biz", b.id); } catch (e) { /* ignore */ }
    renderShell();
    subscribeLive();
    route();
  }

  function renderOnboarding() {
    app.innerHTML = '<div class="auth-card"><h1>Set up your business</h1><p>Create your hotel, restaurant or café profile. You can change everything later.</p>' +
      '<form id="ob"><label>Business name<input name="name" required maxlength="120"></label>' +
      '<label>Type<select name="type">' + Object.keys(TYPES).map(function (k) { return '<option value="' + k + '">' + TYPES[k] + "</option>"; }).join("") + "</select></label>" +
      '<p class="form-error" hidden></p><button class="btn wide">Create business</button></form>' +
      '<button class="link" id="signout">Sign out</button></div>';
    $("#signout").onclick = function () { FQ.db.auth.signOut(); };
    $("#ob").addEventListener("submit", function (e) {
      e.preventDefault();
      var d = FQ.formData(e.target);
      var err = $(".form-error", e.target);
      if (d.name.length < 2) { err.textContent = "Please enter the business name."; err.hidden = false; return; }
      var slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + Math.random().toString(36).slice(2, 6);
      FQ.db.rpc("create_business", { p_name: d.name, p_slug: slug, p_type: d.type }).then(function (r) {
        if (r.error) { err.textContent = r.error.message; err.hidden = false; return; }
        FQ.toast("Business created");
        start(S.session);
      });
    });
  }

  function promptNewPassword() {
    FQ.modal("Choose a new password", '<label>New password<input name="password" type="password" minlength="8" required></label>', function (f) {
      var p = FQ.formData(f).password;
      if (p.length < 8) throw new Error("Use at least 8 characters.");
      return FQ.q(FQ.db.auth.updateUser({ password: p }), "Update password").then(function () { FQ.toast("Password updated"); });
    });
  }

  // ------------------------------------------------------------------ shell
  function renderShell() {
    var picker = S.businesses.length > 1
      ? '<select id="biz-pick" aria-label="Business">' + S.businesses.map(function (b) {
        return '<option value="' + b.id + '"' + (b.id === S.biz.id ? " selected" : "") + ">" + esc(b.name) + "</option>";
      }).join("") + "</select>"
      : '<strong class="biz-name">' + esc(S.biz.name) + "</strong>";
    app.innerHTML =
      '<div class="layout"><aside class="sidebar" id="sidebar"><div class="side-brand"><img src="/img/logo-white.png" alt="FaidaHQ"></div>' +
      '<div class="side-biz">' + picker + '<span class="pill ' + (S.biz.status === "active" ? "good" : "critical") + '">' + esc(S.biz.status) + "</span></div>" +
      "<nav>" + VIEWS.map(function (v) { return '<a href="#' + v[0] + '" data-view="' + v[0] + '"><span aria-hidden="true">' + v[2] + "</span>" + v[1] + "</a>"; }).join("") +
      (S.isPlatformAdmin ? '<a href="/admin/"><span aria-hidden="true">🛡️</span>Platform admin</a>' : "") + "</nav>" +
      '<div class="side-foot"><span>' + esc(S.session.user.email) + '</span><button class="link light" id="signout">Sign out</button></div></aside>' +
      '<div class="main"><header class="topbar"><button class="icon-btn menu" id="menu" aria-label="Menu">☰</button><h1 id="view-title"></h1></header>' +
      '<section id="view" class="view" tabindex="-1"></section></div></div>';
    $("#signout").onclick = function () { FQ.db.auth.signOut(); };
    $("#menu").onclick = function () { $("#sidebar").classList.toggle("open"); };
    var pick = $("#biz-pick");
    if (pick) pick.onchange = function () { selectBusiness(S.businesses.filter(function (b) { return b.id === pick.value; })[0]); };
  }

  function route() {
    var name = (location.hash || "#overview").slice(1).split("/")[0];
    var v = VIEWS.filter(function (x) { return x[0] === name; })[0] || VIEWS[0];
    $$(".sidebar nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === v[0]); });
    $("#view-title").textContent = v[1];
    $("#sidebar").classList.remove("open");
    var box = $("#view");
    box.innerHTML = '<p class="muted">Loading…</p>';
    Promise.resolve(RENDER[v[0]](box)).catch(function (e) {
      console.error(e);
      box.innerHTML = '<div class="empty">Something went wrong loading this page. <button class="link" onclick="location.reload()">Reload</button></div>';
    });
  }
  window.addEventListener("hashchange", function () { if (S.biz) route(); });

  function subscribeLive() {
    if (S.channel) FQ.db.removeChannel(S.channel);
    S.channel = FQ.db.channel("biz-" + bid())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "reservations", filter: "business_id=eq." + bid() }, function () {
        FQ.toast("New reservation request received");
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: "business_id=eq." + bid() }, function (p) {
        var open = $("#thread[data-id='" + p.new.conversation_id + "']");
        if (open) appendMessage(open, p.new);
      })
      .subscribe();
  }

  function since(days) { return new Date(Date.now() - days * 86400000).toISOString(); }

  // ------------------------------------------------------------------ views
  var RENDER = {};

  RENDER.overview = function (box) {
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    var c = function (q) { return q.then(function (r) { return r.count || 0; }); };
    return Promise.all([
      c(FQ.db.from("conversations").select("id", { count: "exact", head: true }).eq("business_id", bid()).gte("started_at", since(30))),
      FQ.q(FQ.db.rpc("business_monthly_usage", { p_business_id: bid() })),
      c(FQ.db.from("reservations").select("id", { count: "exact", head: true }).eq("business_id", bid()).eq("status", "pending")),
      c(FQ.db.from("conversations").select("id", { count: "exact", head: true }).eq("business_id", bid()).eq("status", "escalated")),
      c(FQ.db.from("enquiries").select("id", { count: "exact", head: true }).eq("business_id", bid()).eq("status", "new")),
      c(FQ.db.from("knowledge_items").select("id", { count: "exact", head: true }).eq("business_id", bid())),
      FQ.q(FQ.db.from("conversations").select("id, status, started_at, last_message_at, message_count").eq("business_id", bid()).order("last_message_at", { ascending: false }).limit(6)),
    ]).then(function (r) {
      var usage = r[1][0] || { used: 0, message_limit: 0 };
      var tips = [];
      if (r[5] < 5) tips.push('Add your rooms, menu, hours and FAQs in the <a href="#knowledge">knowledge base</a> so the assistant can answer guests.');
      if (r[2] > 0) tips.push('<a href="#reservations">' + r[2] + " reservation request(s)</a> are waiting for your confirmation.");
      if (r[3] > 0) tips.push('<a href="#conversations">' + r[3] + " conversation(s)</a> need a person to follow up.");
      if (r[4] > 0) tips.push('<a href="#reservations/enquiries">' + r[4] + " new enquiry(ies)</a> from guests.");
      box.innerHTML =
        '<div class="kpis">' +
        kpi("Conversations (30 days)", FQ.num(r[0])) + kpi("Pending reservations", FQ.num(r[2]), r[2] ? "warning" : "") +
        kpi("Need a person", FQ.num(r[3]), r[3] ? "warning" : "") + kpi("New enquiries", FQ.num(r[4])) + "</div>" +
        '<div class="card"><h2>Assistant replies this month</h2>' + FQ.meter(usage.used, usage.message_limit) + "</div>" +
        (tips.length ? '<div class="card"><h2>To do</h2><ul class="todo">' + tips.map(function (t) { return "<li>" + t + "</li>"; }).join("") + "</ul></div>" : "") +
        '<div class="card"><h2>Latest conversations</h2>' + (r[6].length ? table(["Started", "Last message", "Messages", "Status"], r[6].map(function (c2) {
          return ['<a href="#conversations/' + c2.id + '">' + FQ.date(c2.started_at, true) + "</a>", FQ.ago(c2.last_message_at), c2.message_count, statusPill(c2.status)];
        })) : '<p class="empty">No conversations yet. Add the widget to your website (see <a href="#profile">Business profile</a>).</p>') + "</div>";
    });
  };

  function kpi(label, value, tone) { return '<div class="kpi ' + (tone || "") + '"><span>' + label + "</span><strong>" + value + "</strong></div>"; }
  function statusPill(s) {
    var tone = { open: "info", escalated: "warning", closed: "muted", pending: "warning", confirmed: "good", declined: "critical", cancelled: "muted", new: "info", in_progress: "warning", resolved: "good" }[s] || "muted";
    return '<span class="pill ' + tone + '">' + esc(String(s).replace("_", " ")) + "</span>";
  }
  function table(head, rows) {
    return '<div class="table-wrap"><table><thead><tr>' + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>";
  }

  // --- profile ---------------------------------------------------------------
  RENDER.profile = function (box) {
    return FQ.q(FQ.db.from("businesses").select("*").eq("id", bid()).single(), "Load profile").then(function (b) {
      var br = b.branding || {};
      var dis = canEdit() ? "" : " disabled";
      var embed = '<script src="' + location.origin + '/widget.js"\n        data-business-id="' + b.id + '"\n        data-api-url="' + (FQ.cfg.functionsUrl || "https://YOUR-PROJECT.supabase.co/functions/v1") + '"\n        defer></' + "script>";
      box.innerHTML =
        '<form id="pf" class="card form-grid"><h2 class="full">Details</h2>' +
        inp("Business name", "name", b.name, 'maxlength="120" required') +
        sel("Type", "type", b.type, TYPES) +
        txt("Description (what makes you special)", "description", b.description, 5000) +
        inp("Phone", "phone", b.phone) + inp("WhatsApp", "whatsapp", b.whatsapp) + inp("Email", "email", b.email, 'type="email"') + inp("Website", "website", b.website) +
        inp("Address", "address", b.address) + inp("City / town", "city", b.city) + inp("Country", "country", b.country) +
        inp("Time zone", "timezone", b.timezone) + inp("Currency (3 letters)", "currency", b.currency, 'maxlength="3"') +
        '<h2 class="full">Chat widget look</h2>' +
        inp("Assistant name", "assistant_name", br.assistant_name, 'maxlength="40"') + inp("Logo URL (optional)", "logo_url", br.logo_url) +
        inp("Main colour", "primary_color", br.primary_color || "#4f46e5", 'type="color"') + inp("Accent colour", "accent_color", br.accent_color || "#10b981", 'type="color"') +
        txt("Welcome message", "welcome_message", br.welcome_message, 400) +
        txt("Suggested questions (one per line, up to 4)", "suggestions", (br.suggestions || []).join("\n"), 400) +
        txt("Websites allowed to show the chat (one per line, e.g. https://myhotel.co.ke). Leave empty to allow any.", "allowed_origins", (b.allowed_origins || []).join("\n"), 2000) +
        (canEdit() ? '<div class="full"><button class="btn">Save profile</button></div>' : '<p class="full muted">Only owners and admins can edit the profile.</p>') + "</form>" +
        '<div class="card"><h2>Add the chat to your website</h2><p>Paste this just before <code>&lt;/body&gt;</code> on every page of your website:</p>' +
        '<pre class="code" id="embed">' + esc(embed) + '</pre><button class="btn ghost" id="copy">Copy code</button> ' +
        '<button class="btn ghost" id="preview">Preview the chat here</button></div>';
      if (dis) $$("#pf input,#pf select,#pf textarea").forEach(function (f) { f.disabled = true; });
      $("#copy").onclick = function () { navigator.clipboard.writeText(embed).then(function () { FQ.toast("Copied"); }); };
      $("#preview").onclick = function () { previewWidget(b.id); };
      $("#pf").addEventListener("submit", function (e) {
        e.preventDefault();
        var d = FQ.formData(e.target);
        if (d.name.length < 2) return FQ.toast("Business name is required", "error");
        if (!/^[A-Za-z]{3}$/.test(d.currency)) return FQ.toast("Currency must be a 3-letter code like KES", "error");
        var origins = d.allowed_origins.split(/\n+/).map(function (s) { return s.trim().replace(/\/+$/, ""); }).filter(Boolean);
        var bad = origins.filter(function (o) { return !/^https?:\/\/[^/\s]+$/.test(o); });
        if (bad.length) return FQ.toast("Allowed websites must look like https://example.com (no paths): " + bad[0], "error");
        var patch = {
          name: d.name, type: d.type, description: d.description, phone: d.phone || null, whatsapp: d.whatsapp || null,
          email: d.email || null, website: d.website || null, address: d.address || null, city: d.city || null, country: d.country,
          timezone: d.timezone, currency: d.currency.toUpperCase(), allowed_origins: origins,
          branding: Object.assign({}, br, {
            assistant_name: d.assistant_name, logo_url: d.logo_url || null, primary_color: d.primary_color, accent_color: d.accent_color,
            welcome_message: d.welcome_message, suggestions: d.suggestions.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 4),
          }),
        };
        FQ.q(FQ.db.from("businesses").update(patch).eq("id", bid()), "Save profile").then(function () {
          S.biz.name = patch.name; S.biz.type = patch.type; S.biz.currency = patch.currency;
          FQ.toast("Profile saved");
        });
      });
    });
  };

  function previewWidget(businessId) {
    if (!FQ.cfg.functionsUrl) return FQ.toast("Set functionsUrl in js/faidahq-config.js first", "error");
    if (window.FaidaHQWidget) return window.FaidaHQWidget.open();
    var s = document.createElement("script");
    s.src = "/widget.js";
    s.setAttribute("data-business-id", businessId);
    s.setAttribute("data-api-url", FQ.cfg.functionsUrl);
    s.setAttribute("data-open", "true");
    document.body.appendChild(s);
  }

  function inp(label, name, value, extra) {
    return "<label>" + label + '<input name="' + name + '" value="' + esc(value == null ? "" : value) + '" ' + (extra || "") + "></label>";
  }
  function txt(label, name, value, max) {
    return '<label class="full">' + label + '<textarea name="' + name + '" maxlength="' + max + '" rows="3">' + esc(value || "") + "</textarea></label>";
  }
  function sel(label, name, value, options) {
    return "<label>" + label + '<select name="' + name + '">' + Object.keys(options).map(function (k) {
      return '<option value="' + k + '"' + (k === value ? " selected" : "") + ">" + esc(options[k]) + "</option>";
    }).join("") + "</select></label>";
  }

  // --- knowledge -----------------------------------------------------------
  RENDER.knowledge = function (box) {
    return FQ.q(FQ.db.from("knowledge_items").select("*").eq("business_id", bid()).order("category").order("sort_order").order("title"), "Load knowledge").then(function (items) {
      var filter = sessionStorage.getItem("fq:kcat") || "";
      function draw() {
        var shown = items.filter(function (i) { return !filter || i.category === filter; });
        box.innerHTML =
          '<div class="toolbar"><select id="kcat" aria-label="Filter by type"><option value="">All types (' + items.length + ")</option>" +
          Object.keys(CATEGORIES).map(function (k) {
            var n = items.filter(function (i) { return i.category === k; }).length;
            return '<option value="' + k + '"' + (k === filter ? " selected" : "") + ">" + CATEGORIES[k] + " (" + n + ")</option>";
          }).join("") + "</select>" + (canEdit() ? '<button class="btn" id="kadd">+ Add information</button>' : "") + "</div>" +
          '<p class="muted">Everything here is what the assistant knows. If it isn\'t here, the assistant will say it doesn\'t know and offer to pass the question on.</p>' +
          (shown.length ? table(["Type", "Title", "Details", "Price", "Shown", ""], shown.map(function (i) {
            return [CATEGORIES[i.category], "<strong>" + esc(i.title) + "</strong>", '<span class="clip">' + esc(i.content) + "</span>",
              i.price != null ? esc(FQ.money(i.price, S.biz.currency)) + (i.price_unit ? " <small>" + esc(i.price_unit) + "</small>" : "") : "—",
              i.is_active ? "Yes" : '<span class="muted">Hidden</span>',
              canEdit() ? '<button class="link" data-edit="' + i.id + '">Edit</button> <button class="link danger" data-del="' + i.id + '">Delete</button>' : ""];
          })) : '<div class="empty">Nothing here yet.' + (canEdit() ? ' Click "Add information" to start.' : "") + "</div>");
        $("#kcat").onchange = function () { filter = this.value; sessionStorage.setItem("fq:kcat", filter); draw(); };
        if ($("#kadd")) $("#kadd").onclick = function () { editItem({ category: filter || "faq", is_active: true, sort_order: 0 }); };
        $$("[data-edit]", box).forEach(function (b) { b.onclick = function () { editItem(items.filter(function (i) { return i.id === b.dataset.edit; })[0]); }; });
        $$("[data-del]", box).forEach(function (b) {
          b.onclick = function () {
            if (!FQ.confirm("Delete this item? The assistant will stop using it.")) return;
            FQ.q(FQ.db.from("knowledge_items").delete().eq("id", b.dataset.del).eq("business_id", bid()), "Delete").then(function () {
              items = items.filter(function (i) { return i.id !== b.dataset.del; });
              FQ.toast("Deleted"); draw();
            });
          };
        });
      }
      function editItem(it) {
        FQ.modal(it.id ? "Edit information" : "Add information",
          '<div class="form-grid">' + sel("Type", "category", it.category, CATEGORIES) + inp("Title", "title", it.title, 'maxlength="200" required placeholder="e.g. Deluxe Room, Breakfast hours"') +
          txt("Details (what guests should know)", "content", it.content, 4000) +
          inp("Price (optional)", "price", it.price, 'type="number" min="0" step="0.01"') + inp("Price note", "price_unit", it.price_unit, 'maxlength="40" placeholder="per night, per person…"') +
          inp("Order (lower shows first)", "sort_order", it.sort_order, 'type="number"') +
          '<label class="check"><input type="checkbox" name="is_active"' + (it.is_active ? " checked" : "") + "> Use this information</label></div>",
          function (form) {
            var d = FQ.formData(form);
            if (!d.title) throw new Error("Title is required.");
            if (d.price !== "" && (isNaN(Number(d.price)) || Number(d.price) < 0)) throw new Error("Price must be a positive number.");
            var row = {
              business_id: bid(), category: d.category, title: d.title, content: d.content,
              price: d.price === "" ? null : Number(d.price), price_unit: d.price_unit || null,
              sort_order: parseInt(d.sort_order || "0", 10) || 0, is_active: d.is_active,
            };
            var q = it.id ? FQ.db.from("knowledge_items").update(row).eq("id", it.id).eq("business_id", bid()).select().single()
              : FQ.db.from("knowledge_items").insert(row).select().single();
            return FQ.q(q, "Save").then(function (saved) {
              items = items.filter(function (i) { return i.id !== saved.id; }).concat([saved]);
              items.sort(function (a, b) { return a.category.localeCompare(b.category) || a.sort_order - b.sort_order || a.title.localeCompare(b.title); });
              FQ.toast("Saved"); draw();
            });
          });
      }
      draw();
    });
  };

  // --- conversations ---------------------------------------------------------
  RENDER.conversations = function (box) {
    var openId = (location.hash.split("/")[1] || "");
    var status = sessionStorage.getItem("fq:cstatus") || "";
    var q = FQ.db.from("conversations").select("id, status, started_at, last_message_at, message_count, escalation_reason, page_url, customers(name, email, phone)")
      .eq("business_id", bid()).order("last_message_at", { ascending: false }).limit(100);
    if (status) q = q.eq("status", status);
    return FQ.q(q, "Load conversations").then(function (list) {
      box.innerHTML = '<div class="toolbar"><select id="cstatus" aria-label="Filter"><option value="">All conversations</option>' +
        ["open", "escalated", "closed"].map(function (s) { return '<option value="' + s + '"' + (s === status ? " selected" : "") + ">" + (s === "escalated" ? "Needs a person" : s[0].toUpperCase() + s.slice(1)) + "</option>"; }).join("") +
        '</select></div><div class="split"><div class="list" id="clist">' +
        (list.length ? list.map(function (c) {
          var who = c.customers ? esc(c.customers.name || c.customers.email || c.customers.phone) : "Website visitor";
          return '<a class="list-item' + (c.id === openId ? " active" : "") + '" href="#conversations/' + c.id + '"><div><strong>' + who + "</strong>" + statusPill(c.status) +
            '</div><small>' + FQ.ago(c.last_message_at) + " · " + c.message_count + " messages</small>" +
            (c.escalation_reason ? '<small class="warn">⚠ ' + esc(c.escalation_reason) + "</small>" : "") + "</a>";
        }).join("") : '<div class="empty">No conversations.</div>') +
        '</div><div class="detail" id="cdetail"><div class="empty">Choose a conversation to read it.</div></div></div>';
      $("#cstatus").onchange = function () { sessionStorage.setItem("fq:cstatus", this.value); route(); };
      var current = list.filter(function (c) { return c.id === openId; })[0];
      if (openId) showConversation(current || { id: openId });
    });
  };

  function showConversation(c) {
    var d = $("#cdetail");
    FQ.q(FQ.db.from("messages").select("id, role, content, created_at").eq("conversation_id", c.id).eq("business_id", bid()).order("created_at").limit(500), "Load messages").then(function (msgs) {
      d.innerHTML = '<div class="thread-head"><div>' + statusPill(c.status || "open") + (c.page_url ? ' <small class="muted">from ' + esc(c.page_url) + "</small>" : "") + "</div>" +
        '<div class="btn-row">' + ["open", "escalated", "closed"].filter(function (s) { return s !== c.status; }).map(function (s) {
          return '<button class="btn ghost small" data-status="' + s + '">' + (s === "closed" ? "Close" : s === "open" ? "Reopen" : "Flag for a person") + "</button>";
        }).join("") + "</div></div>" +
        (c.customers ? '<p class="muted">' + esc([c.customers.name, c.customers.email, c.customers.phone].filter(Boolean).join(" · ")) + "</p>" : "") +
        '<div class="thread" id="thread" data-id="' + c.id + '"></div>' +
        '<form id="reply" class="reply"><textarea name="content" rows="2" maxlength="4000" placeholder="Reply as staff (the guest sees it next time they open the chat)…"></textarea><button class="btn">Send</button></form>';
      var t = $("#thread");
      msgs.forEach(function (m) { appendMessage(t, m); });
      $$("[data-status]", d).forEach(function (b) {
        b.onclick = function () {
          FQ.q(FQ.db.from("conversations").update({ status: b.dataset.status }).eq("id", c.id).eq("business_id", bid()), "Update").then(function () { FQ.toast("Updated"); route(); });
        };
      });
      $("#reply").addEventListener("submit", function (e) {
        e.preventDefault();
        var content = e.target.content.value.trim();
        if (!content) return;
        FQ.q(FQ.db.from("messages").insert({ conversation_id: c.id, business_id: bid(), role: "staff", content: content }).select("id, role, content, created_at").single(), "Send").then(function (saved) {
          e.target.content.value = "";
          appendMessage(t, saved);
          FQ.db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", c.id).eq("business_id", bid()).then(function () {});
        });
      });
    });
  }

  function appendMessage(t, m) {
    if (m.id && $("[data-mid='" + m.id + "']", t)) return;
    var who = { user: "Guest", assistant: "Assistant", staff: "Staff", system: "System" }[m.role];
    var div = document.createElement("div");
    div.className = "tmsg " + m.role;
    if (m.id) div.setAttribute("data-mid", m.id);
    div.innerHTML = "<small>" + who + " · " + FQ.date(m.created_at, true) + "</small><div>" + esc(m.content).replace(/\n/g, "<br>") + "</div>";
    t.appendChild(div);
    t.scrollTop = t.scrollHeight;
  }

  // --- reservations + enquiries ---------------------------------------------
  RENDER.reservations = function (box) {
    var tab = location.hash.split("/")[1] === "enquiries" ? "enquiries" : "reservations";
    var status = sessionStorage.getItem("fq:rstatus") || "pending";
    var tabs = '<div class="tabs"><a href="#reservations" class="' + (tab === "reservations" ? "active" : "") + '">Reservation requests</a><a href="#reservations/enquiries" class="' + (tab === "enquiries" ? "active" : "") + '">General enquiries</a></div>';
    if (tab === "enquiries") {
      return FQ.q(FQ.db.from("enquiries").select("*").eq("business_id", bid()).order("created_at", { ascending: false }).limit(200), "Load enquiries").then(function (rows) {
        box.innerHTML = tabs + (rows.length ? table(["Received", "From", "Message", "Status", ""], rows.map(function (e) {
          return [FQ.date(e.created_at, true), contact(e), '<span class="pre">' + esc(e.message) + "</span>", statusPill(e.status),
            '<select data-enq="' + e.id + '" aria-label="Status">' + ["new", "in_progress", "resolved"].map(function (s) { return "<option" + (s === e.status ? " selected" : "") + ' value="' + s + '">' + s.replace("_", " ") + "</option>"; }).join("") + "</select>"];
        })) : '<div class="empty">No enquiries yet.</div>');
        $$("[data-enq]", box).forEach(function (s) {
          s.onchange = function () { FQ.q(FQ.db.from("enquiries").update({ status: s.value }).eq("id", s.dataset.enq).eq("business_id", bid()), "Update").then(function () { FQ.toast("Updated"); route(); }); };
        });
      });
    }
    var q = FQ.db.from("reservations").select("*").eq("business_id", bid()).order("created_at", { ascending: false }).limit(200);
    if (status) q = q.eq("status", status);
    return FQ.q(q, "Load reservations").then(function (rows) {
      box.innerHTML = tabs + '<div class="toolbar"><select id="rstatus" aria-label="Filter"><option value="">All</option>' +
        ["pending", "confirmed", "declined", "cancelled"].map(function (s) { return '<option value="' + s + '"' + (s === status ? " selected" : "") + ">" + s[0].toUpperCase() + s.slice(1) + "</option>"; }).join("") + "</select></div>" +
        '<p class="muted">Guests only see a booking as confirmed after you confirm it here and contact them.</p>' +
        (rows.length ? table(["Received", "Type", "When", "Guests", "Guest", "Requests", "Status", ""], rows.map(function (r) {
          var when = r.kind === "hotel" ? FQ.date(r.check_in) + " → " + FQ.date(r.check_out) + (r.room_preference ? "<br><small>" + esc(r.room_preference) + "</small>" : "")
            : FQ.date(r.reservation_date) + " at " + esc(String(r.reservation_time).slice(0, 5));
          return [FQ.date(r.created_at, true), r.kind === "hotel" ? "Room" : "Table", when, r.guests, contact(r),
            '<span class="pre">' + esc(r.special_requests || "—") + "</span>" + (r.business_notes ? '<br><small class="muted">Note: ' + esc(r.business_notes) + "</small>" : ""),
            statusPill(r.status),
            r.status === "pending" ? '<button class="btn small" data-res="' + r.id + '" data-to="confirmed">Confirm</button> <button class="btn ghost small" data-res="' + r.id + '" data-to="declined">Decline</button>'
              : '<button class="link" data-res="' + r.id + '" data-to="pending">Reset</button>'];
        })) : '<div class="empty">No ' + (status || "") + " reservation requests.</div>");
      $("#rstatus").onchange = function () { sessionStorage.setItem("fq:rstatus", this.value); route(); };
      $$("[data-res]", box).forEach(function (b) {
        b.onclick = function () {
          var to = b.dataset.to;
          FQ.modal(to === "confirmed" ? "Confirm reservation" : to === "declined" ? "Decline reservation" : "Move back to pending",
            "<p>" + (to === "confirmed" ? "Only confirm once you have checked availability. Remember to tell the guest (call, WhatsApp or email)." : "Add a note for your team if helpful.") + "</p>" +
            '<label>Internal note<textarea name="business_notes" maxlength="2000" rows="3"></textarea></label>',
            function (f) {
              var note = FQ.formData(f).business_notes;
              var patch = { status: to };
              if (note) patch.business_notes = note;
              return FQ.q(FQ.db.from("reservations").update(patch).eq("id", b.dataset.res).eq("business_id", bid()), "Update").then(function () { FQ.toast("Reservation " + to); route(); });
            }, to === "confirmed" ? "Confirm" : "Save");
        };
      });
    });
  };

  function contact(r) {
    return "<strong>" + esc(r.contact_name) + "</strong>" + (r.contact_phone ? '<br><a href="tel:' + esc(r.contact_phone) + '">' + esc(r.contact_phone) + "</a>" : "") +
      (r.contact_email ? '<br><a href="mailto:' + esc(r.contact_email) + '">' + esc(r.contact_email) + "</a>" : "");
  }

  // --- customers -------------------------------------------------------------
  RENDER.customers = function (box) {
    return FQ.q(FQ.db.from("customers").select("*, reservations(count), conversations(count)").eq("business_id", bid()).order("last_seen", { ascending: false }).limit(500), "Load customers").then(function (rows) {
      function draw(term) {
        var t = (term || "").toLowerCase();
        var shown = rows.filter(function (c) { return !t || [c.name, c.email, c.phone].join(" ").toLowerCase().indexOf(t) >= 0; });
        $("#ctable").innerHTML = shown.length ? table(["Name", "Contact", "Reservations", "Chats", "Last seen", "Notes", ""], shown.map(function (c) {
          return ["<strong>" + esc(c.name || "—") + "</strong>", contact({ contact_name: "", contact_email: c.email, contact_phone: c.phone }).replace(/^<strong><\/strong><br>/, ""),
            (c.reservations[0] || {}).count || 0, (c.conversations[0] || {}).count || 0, FQ.date(c.last_seen), '<span class="clip">' + esc(c.notes) + "</span>",
            '<button class="link" data-note="' + c.id + '">Notes</button>'];
        })) : '<div class="empty">No customers yet. Guests appear here when they send a reservation request or enquiry.</div>';
        $$("[data-note]", box).forEach(function (b) {
          b.onclick = function () {
            var c = rows.filter(function (x) { return x.id === b.dataset.note; })[0];
            FQ.modal("Notes: " + (c.name || c.email || ""), '<label>Private notes (not shown to the assistant)<textarea name="notes" rows="5" maxlength="2000">' + esc(c.notes) + "</textarea></label>", function (f) {
              var notes = FQ.formData(f).notes;
              return FQ.q(FQ.db.from("customers").update({ notes: notes }).eq("id", c.id).eq("business_id", bid()), "Save").then(function () { c.notes = notes; FQ.toast("Saved"); draw($("#csearch").value); });
            });
          };
        });
      }
      box.innerHTML = '<div class="toolbar"><input id="csearch" type="search" placeholder="Search name, email or phone" aria-label="Search customers"><span class="muted">' + rows.length + " customers</span></div><div id=\"ctable\"></div>";
      $("#csearch").oninput = function () { draw(this.value); };
      draw("");
    });
  };

  // --- AI configuration -----------------------------------------------------
  RENDER.ai = function (box) {
    return FQ.q(FQ.db.from("ai_settings").select("*").eq("business_id", bid()).maybeSingle(), "Load AI settings").then(function (s) {
      s = s || { provider: "default", model: "", temperature: 0.3, max_output_tokens: 600, tone: "warm and professional", extra_instructions: "" };
      box.innerHTML = '<form id="aif" class="card form-grid"><p class="full muted">The assistant always follows FaidaHQ\'s safety rules: it only uses your knowledge base, never invents prices or availability, and never confirms bookings. API keys are kept on the server by FaidaHQ and are never shown here.</p>' +
        sel("AI provider", "provider", s.provider, { "default": "FaidaHQ default (recommended)", anthropic: "Anthropic Claude", openai: "OpenAI", openai_compatible: "OpenAI-compatible service" }) +
        inp("Model (leave empty for the default)", "model", s.model, 'maxlength="100" placeholder="e.g. claude-haiku-5-5"') +
        inp("Creativity (0 = precise, 1 = creative; not used by Claude)", "temperature", s.temperature, 'type="number" min="0" max="1" step="0.05"') +
        inp("Maximum reply length (tokens)", "max_output_tokens", s.max_output_tokens, 'type="number" min="50" max="2000"') +
        inp("Tone of voice", "tone", s.tone, 'maxlength="200"') +
        txt("Extra instructions (e.g. greet in Swahili, mention our Friday buffet)", "extra_instructions", s.extra_instructions, 2000) +
        (canEdit() ? '<div class="full"><button class="btn">Save AI settings</button> <button type="button" class="btn ghost" id="try">Test the assistant</button></div>' : "") + "</form>";
      if (!canEdit()) $$("#aif input,#aif select,#aif textarea").forEach(function (f) { f.disabled = true; });
      if ($("#try")) $("#try").onclick = function () { previewWidget(bid()); };
      $("#aif").addEventListener("submit", function (e) {
        e.preventDefault();
        var d = FQ.formData(e.target);
        var t = Number(d.temperature), m = parseInt(d.max_output_tokens, 10);
        if (!(t >= 0 && t <= 1)) return FQ.toast("Creativity must be between 0 and 1", "error");
        if (!(m >= 50 && m <= 2000)) return FQ.toast("Reply length must be between 50 and 2000", "error");
        var row = { business_id: bid(), provider: d.provider, model: d.model || null, temperature: t, max_output_tokens: m, tone: d.tone, extra_instructions: d.extra_instructions };
        FQ.q(FQ.db.from("ai_settings").upsert(row), "Save AI settings").then(function () { FQ.toast("AI settings saved"); });
      });
    });
  };

  // --- analytics -------------------------------------------------------------
  RENDER.analytics = function (box) {
    return Promise.all([
      FQ.q(FQ.db.from("ai_usage").select("created_at, input_tokens, output_tokens, success, latency_ms").eq("business_id", bid()).gte("created_at", since(30)).order("created_at").limit(10000)),
      FQ.q(FQ.db.from("conversations").select("started_at, status, escalation_reason").eq("business_id", bid()).gte("started_at", since(30)).limit(10000)),
      FQ.q(FQ.db.rpc("business_monthly_usage", { p_business_id: bid() })),
      FQ.q(FQ.db.from("reservations").select("status").eq("business_id", bid()).gte("created_at", since(30)).limit(10000)),
    ]).then(function (r) {
      var usage = r[0], convos = r[1], month = r[2][0] || { used: 0, message_limit: 0 }, res = r[3];
      var days = [];
      for (var i = 29; i >= 0; i--) {
        var d = new Date(Date.now() - i * 86400000);
        days.push({ day: d.toISOString().slice(0, 10), value: 0 });
      }
      var idx = {}; days.forEach(function (d, i2) { idx[d.day] = i2; });
      usage.forEach(function (u) { var k = u.created_at.slice(0, 10); if (u.success && idx[k] != null) days[idx[k]].value++; });
      var ok = usage.filter(function (u) { return u.success; });
      var tokens = usage.reduce(function (a, u) { return a + u.input_tokens + u.output_tokens; }, 0);
      var avgLatency = ok.length ? Math.round(ok.reduce(function (a, u) { return a + (u.latency_ms || 0); }, 0) / ok.length / 100) / 10 : 0;
      var esc2 = convos.filter(function (c) { return c.status === "escalated" || c.escalation_reason; });
      var reasons = {};
      esc2.forEach(function (c) { var k = c.escalation_reason || "Flagged"; reasons[k] = (reasons[k] || 0) + 1; });
      var failed = usage.length - ok.length;
      box.innerHTML = '<div class="kpis">' + kpi("Conversations (30 days)", FQ.num(convos.length)) + kpi("Assistant replies (30 days)", FQ.num(ok.length)) +
        kpi("Handed to a person", convos.length ? Math.round((esc2.length / convos.length) * 100) + "%" : "0%") + kpi("Avg. reply time", avgLatency + " s") + "</div>" +
        '<div class="card"><h2>This month\'s plan usage</h2>' + FQ.meter(month.used, month.message_limit) + "</div>" +
        '<div class="card"><h2>Assistant replies per day</h2>' + FQ.barChart(days, "Assistant replies per day, last 30 days") +
        '<details><summary>Show as table</summary>' + table(["Day", "Replies"], days.filter(function (d) { return d.value; }).map(function (d) { return [FQ.date(d.day), d.value]; })) + "</details></div>" +
        '<div class="grid2"><div class="card"><h2>Reservation requests (30 days)</h2>' + table(["Status", "Count"], ["pending", "confirmed", "declined", "cancelled"].map(function (s) {
          return [statusPill(s), res.filter(function (x) { return x.status === s; }).length];
        })) + '</div><div class="card"><h2>Why chats were handed over</h2>' +
        (Object.keys(reasons).length ? table(["Reason", "Count"], Object.keys(reasons).sort(function (a, b) { return reasons[b] - reasons[a]; }).slice(0, 8).map(function (k) { return [esc(k), reasons[k]]; })) : '<p class="empty">None in the last 30 days.</p>') +
        '</div></div><p class="muted">AI tokens used (30 days): ' + FQ.num(tokens) + (failed ? " · Failed AI calls: " + failed : "") + "</p>";
    });
  };

  // --- settings --------------------------------------------------------------
  RENDER.settings = function (box) {
    return FQ.q(FQ.db.rpc("list_business_members", { p_business_id: bid() }), "Load team").then(function (team) {
      box.innerHTML = '<div class="card"><h2>Your account</h2><p>Signed in as <strong>' + esc(S.session.user.email) + "</strong> (" + esc(S.role) + ')</p>' +
        '<button class="btn ghost" id="pw">Change password</button> <button class="btn ghost" id="so">Sign out</button></div>' +
        '<div class="card"><h2>Team</h2>' + table(["Email", "Role", "Added"], team.map(function (m) { return [esc(m.email), esc(m.role), FQ.date(m.created_at)]; })) +
        (S.role === "owner" ? '<form id="addm" class="inline-form"><input name="email" type="email" placeholder="colleague@email.com" required aria-label="Email">' +
          '<select name="role" aria-label="Role"><option value="staff">Staff (reads, replies, confirms bookings)</option><option value="admin">Admin (also edits knowledge & profile)</option></select>' +
          '<button class="btn">Add to team</button></form><p class="muted">Your colleague must create a FaidaHQ account first.</p>' : "") + "</div>" +
        '<div class="card"><h2>Subscription</h2><p>Plan and billing are managed by FaidaHQ. <a href="/contact/">Contact us</a> to change your plan.</p></div>';
      $("#pw").onclick = promptNewPassword;
      $("#so").onclick = function () { FQ.db.auth.signOut(); };
      if ($("#addm")) $("#addm").addEventListener("submit", function (e) {
        e.preventDefault();
        var d = FQ.formData(e.target);
        FQ.q(FQ.db.rpc("add_business_member", { p_business_id: bid(), p_email: d.email, p_role: d.role }), "Add member").then(function () { FQ.toast("Added"); route(); });
      });
    });
  };

  boot();
})();
