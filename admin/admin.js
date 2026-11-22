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
      '<div class="side-biz"><strong class="biz-name">Platform admin</strong></div><nav><a class="active" href="#">🏢 Businesses</a><a href="/dashboard/">📊 Business dashboard</a></nav>' +
      '<div class="side-foot"><span>' + esc(session.user.email) + '</span><button class="link light" id="so">Sign out</button></div></aside>' +
      '<div class="main"><header class="topbar"><h1>Businesses</h1></header><section class="view" id="view"><p class="muted">Loading…</p></section></div></div>';
    $("#so").onclick = function () { FQ.db.auth.signOut().then(function () { location.reload(); }); };
    load();
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
            '<button class="link" data-manage="' + b.id + '">Manage</button>'];
        }));
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

  boot();
})();
