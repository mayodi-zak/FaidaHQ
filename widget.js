/*!
 * FaidaHQ Hospitality Assistant — embeddable chat widget
 * ------------------------------------------------------
 * Add ONE line to any website:
 *
 *   <script src="https://faidahq.com/widget.js"
 *           data-business-id="YOUR_BUSINESS_ID"
 *           data-api-url="https://YOUR-PROJECT.supabase.co/functions/v1"
 *           defer></script>
 *
 * Optional attributes:
 *   data-demo="true"        Run fully offline with sample data (no backend, no AI).
 *   data-demo-src="url"     JSON knowledge file used by demo mode.
 *   data-position="left"    Show the button bottom-left instead of bottom-right.
 *   data-open="true"        Open the chat window on page load.
 *
 * Vanilla JavaScript, no dependencies. Styles live in a Shadow DOM so the host
 * website's CSS cannot break the widget (and the widget cannot break the site).
 * No secrets are used or stored here.
 */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector("script[data-business-id]");
  if (!script || window.__faidahqWidgetLoaded) return;
  window.__faidahqWidgetLoaded = true;

  var globalCfg = window.FaidaHQConfig || {};
  var OPTS = {
    businessId: (script.getAttribute("data-business-id") || "").trim(),
    apiUrl: (script.getAttribute("data-api-url") || globalCfg.functionsUrl || "").replace(/\/+$/, ""),
    demo: script.getAttribute("data-demo") === "true",
    demoSrc: script.getAttribute("data-demo-src") || new URL("demo/demo-business.json", script.src || location.href).href,
    position: script.getAttribute("data-position") === "left" ? "left" : "right",
    openOnLoad: script.getAttribute("data-open") === "true",
  };
  if (!OPTS.apiUrl) OPTS.demo = true;

  var STORE_KEY = "faidahq:" + (OPTS.businessId || "demo");

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { return {}; }
  }
  function save(patch) {
    try {
      var cur = load();
      for (var k in patch) cur[k] = patch[k];
      localStorage.setItem(STORE_KEY, JSON.stringify(cur));
    } catch (e) { /* private mode: keep working without persistence */ }
  }
  function randomId() {
    var a = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return "v_" + Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /** Plain text -> safe HTML with paragraphs, "-" bullet lists, links and phone links. */
  function format(text) {
    var lines = esc(text).split(/\n/);
    var html = "", inList = false;
    lines.forEach(function (line) {
      var m = line.match(/^\s*[-•*]\s+(.*)$/);
      if (m) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + m[1] + "</li>";
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        if (line.trim()) html += "<p>" + line + "</p>";
      }
    });
    if (inList) html += "</ul>";
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return html;
  }
  function todayISO(offsetDays) {
    var d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function validHex(c, fallback) { return /^#[0-9a-f]{3,8}$/i.test(c || "") ? c : fallback; }

  // Optional: a host page (our admin preview) may define window.FaidaHQAuth(), returning a
  // promise of a sign-in token. It is sent only so private test assistants can verify an admin.
  function authToken() {
    try {
      return typeof window.FaidaHQAuth === "function" ? Promise.resolve(window.FaidaHQAuth()).catch(function () { return null; }) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  }

  function request(method, path, body) {
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 45000);
    return authToken().then(function (token) {
      var headers = body ? { "content-type": "application/json" } : {};
      if (token) headers.authorization = "Bearer " + token;
      return fetch(OPTS.apiUrl + path, {
        method: method,
        headers: headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller ? controller.signal : undefined,
      });
    }).then(function (res) {
      clearTimeout(timer);
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || "Request failed (" + res.status + ")");
          err.status = res.status;
          err.code = data.error;
          throw err;
        }
        return data;
      });
    }, function (e) {
      clearTimeout(timer);
      var err = new Error(e && e.name === "AbortError"
        ? "The assistant took too long to reply. Please try again."
        : "You seem to be offline. Check your connection and try again.");
      err.network = true;
      throw err;
    });
  }

  // ---------------------------------------------------------------------------
  // Demo engine: answers from the sample knowledge file. No AI, no backend.
  // ---------------------------------------------------------------------------
  var Demo = (function () {
    var data = null;
    var STOP = "a an the is are do does you your i me my we our for of to in on at and or with what whats how can could would about any have has there please tell much is it this that be".split(" ");
    var INTENTS = [
      { re: /\b(book|reserve|reservation|availability|available|table for|room for)\b/i, action: "reservation" },
      { re: /\b(human|person|staff|manager|agent|call me|complain|complaint|refund)\b/i, action: "escalate" },
      { re: /\b(room|rooms|suite|villa|stay|accommodation|night|sleep)\b/i, category: "room" },
      { re: /\b(menu|food|eat|dish|dinner|lunch|breakfast|vegan|vegetarian|drink|cocktail|dessert)\b/i, category: "menu_item" },
      { re: /\b(open|opening|hours|time|close|closing|check.?in|check.?out)\b/i, category: "hours" },
      { re: /\b(offer|deal|discount|promo|special)\b/i, category: "offer" },
      { re: /\b(cancel|cancellation|policy|deposit|pets?|children|kids|payment|pay|m-?pesa)\b/i, category: "policy" },
      { re: /\b(pool|spa|wifi|wi-fi|parking|gym|facilit)/i, category: "facility" },
      { re: /\b(transfer|airport|massage|trip|tour|laundry|snorkel)/i, category: "service" },
    ];
    function words(s) {
      return (s.toLowerCase().match(/[a-z0-9-]+/g) || []).filter(function (w) { return w.length > 2 && STOP.indexOf(w) < 0; });
    }
    function price(it) {
      if (it.price == null) return "";
      return " (" + data.currency + " " + Number(it.price).toLocaleString("en-US") + (it.price_unit ? " " + it.price_unit : "") + ")";
    }
    function line(it) { return "- **" + it.title + "**" + price(it) + (it.content ? ": " + it.content : ""); }

    function answer(q) {
      var k = data.knowledge;
      var intent = null, category = null;
      INTENTS.forEach(function (i) {
        if (!i.re.test(q)) return;
        if (i.action && !intent) intent = i.action;
        if (i.category && !category) category = i.category;
      });
      if (/^\s*(hi|hello|hey|jambo|habari|good (morning|afternoon|evening))\b/i.test(q) && q.length < 25) {
        return { text: "Jambo! Karibu to " + data.name + ". I can help with rooms, our menu, opening hours, facilities and reservations. What would you like to know?" };
      }
      if (intent === "escalate") {
        return {
          text: "I'll pass this to our team so a person can help you. You can also reach us on " + data.phone + " or " + data.email + ".",
          escalate: true,
        };
      }
      // Score items by keyword overlap.
      var qw = words(q);
      var scored = k.map(function (it) {
        var tw = words(it.title), cw = words(it.content || "");
        var s = 0;
        qw.forEach(function (w) {
          var stem = w.replace(/s$/, "");
          if (tw.some(function (t) { return t.indexOf(stem) === 0; })) s += 3;
          else if (cw.some(function (t) { return t.indexOf(stem) === 0; })) s += 1;
        });
        if (category && it.category === category) s += 2;
        return { it: it, s: s };
      }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; });

      if (intent === "reservation") {
        var rooms = k.filter(function (it) { return it.category === "room"; });
        var wantsTable = /\b(table|dinner|lunch|restaurant|eat)\b/i.test(q);
        return {
          text: wantsTable
            ? "I'd be happy to request a table for you. Please fill in the short form below and the restaurant team will confirm availability."
            : "Happy to help with a stay! Our rooms:\n" + rooms.map(line).join("\n") + "\nFill in the form below and our reservations team will confirm availability with you.",
          reservation: wantsTable ? "restaurant" : "hotel",
        };
      }
      if (!scored.length || scored[0].s < 2) {
        return {
          text: "I'm sorry, I don't have that detail in my information. I can pass your question to our team, or you can contact us on " + data.phone + ".",
          escalate: true,
        };
      }
      var top = scored[0].s;
      var best = scored.filter(function (x) { return x.s >= Math.max(2, top - 1); }).slice(0, category === "menu_item" || category === "room" ? 6 : 3);
      if (best.length === 1 && best[0].it.category === "faq") return { text: best[0].it.content };
      return { text: "Here's what I can tell you:\n" + best.map(function (x) { return line(x.it); }).join("\n") };
    }

    return {
      init: function () {
        return fetch(OPTS.demoSrc).then(function (r) {
          if (!r.ok) throw new Error("demo data missing");
          return r.json();
        }).then(function (d) { data = d; return d; });
      },
      config: function () {
        return {
          business: { id: data.id, name: data.name, type: data.type, phone: data.phone, email: data.email },
          branding: data.branding,
        };
      },
      chat: function (msg) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            var a = answer(msg);
            resolve({ reply: a.text, show_reservation_form: !!a.reservation, form_kind: a.reservation, escalated: !!a.escalate });
          }, 500 + Math.random() * 500);
        });
      },
    };
  })();

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}",
    ".fq-launcher{position:fixed;bottom:20px;" + OPTS.position + ":20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:var(--fq-primary);color:#fff;box-shadow:0 8px 24px rgba(15,23,42,.28);display:flex;align-items:center;justify-content:center;transition:transform .2s ease}",
    ".fq-launcher:hover{transform:scale(1.06)}",
    ".fq-launcher:focus-visible,.fq-btn:focus-visible,.fq-chip:focus-visible,.fq-icon:focus-visible{outline:3px solid var(--fq-accent);outline-offset:2px}",
    ".fq-launcher svg{width:28px;height:28px}",
    ".fq-badge{position:absolute;top:-2px;right:-2px;width:16px;height:16px;border-radius:50%;background:var(--fq-accent);border:2px solid #fff}",
    ".fq-teaser{position:fixed;bottom:92px;" + OPTS.position + ":20px;z-index:2147483000;max-width:260px;background:#fff;color:#0f172a;border-radius:14px;padding:12px 14px;font-size:14px;line-height:1.4;box-shadow:0 8px 24px rgba(15,23,42,.18);cursor:pointer;animation:fq-in .3s ease}",
    ".fq-panel{position:fixed;bottom:92px;" + OPTS.position + ":20px;z-index:2147483001;width:380px;max-width:calc(100vw - 24px);height:600px;max-height:calc(100vh - 112px);background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(15,23,42,.3);display:flex;flex-direction:column;overflow:hidden;animation:fq-in .22s ease}",
    ".fq-panel[hidden],.fq-teaser[hidden],[hidden]{display:none!important}",
    "@keyframes fq-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}",
    ".fq-head{background:var(--fq-primary);color:#fff;padding:14px 14px 14px 16px;display:flex;align-items:center;gap:10px}",
    ".fq-avatar{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex:none;overflow:hidden}",
    ".fq-avatar img{width:100%;height:100%;object-fit:cover}",
    ".fq-title{flex:1;min-width:0}.fq-title b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fq-title small{font-size:12px;opacity:.85}",
    ".fq-icon{background:transparent;border:0;color:#fff;cursor:pointer;width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center}",
    ".fq-icon:hover{background:rgba(255,255,255,.15)}.fq-icon svg{width:20px;height:20px}",
    ".fq-demo{background:#fef3c7;color:#92400e;font-size:12px;padding:6px 12px;text-align:center}",
    ".fq-body{flex:1;overflow-y:auto;padding:16px;background:#f8fafc;scroll-behavior:smooth}",
    ".fq-msg{display:flex;margin:0 0 10px}.fq-msg.user{justify-content:flex-end}",
    ".fq-bubble{max-width:85%;padding:10px 13px;border-radius:16px;font-size:14px;line-height:1.45;color:#0f172a;background:#fff;border:1px solid #e2e8f0;word-wrap:break-word;overflow-wrap:anywhere}",
    ".fq-bubble p{margin:0 0 6px}.fq-bubble p:last-child{margin:0}.fq-bubble ul{margin:4px 0;padding-left:18px}.fq-bubble li{margin:2px 0}.fq-bubble a{color:var(--fq-primary)}",
    ".fq-msg.user .fq-bubble{background:var(--fq-primary);color:#fff;border-color:transparent;border-bottom-right-radius:4px}",
    ".fq-msg.assistant .fq-bubble,.fq-msg.staff .fq-bubble{border-bottom-left-radius:4px}",
    ".fq-msg.staff .fq-bubble{border-color:var(--fq-accent)}",
    ".fq-staff{display:block;font-size:11px;font-weight:600;color:#64748b;margin-bottom:3px}",
    ".fq-msg.error .fq-bubble{background:#fef2f2;border-color:#fecaca;color:#991b1b}",
    ".fq-retry{margin-top:6px;background:none;border:0;color:#991b1b;text-decoration:underline;cursor:pointer;font-size:13px;padding:0}",
    ".fq-typing{display:inline-flex;gap:4px;padding:12px 14px}",
    ".fq-typing span{width:7px;height:7px;border-radius:50%;background:#94a3b8;animation:fq-dot 1.2s infinite}",
    ".fq-typing span:nth-child(2){animation-delay:.15s}.fq-typing span:nth-child(3){animation-delay:.3s}",
    "@keyframes fq-dot{0%,60%,100%{opacity:.3;transform:none}30%{opacity:1;transform:translateY(-3px)}}",
    ".fq-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}",
    ".fq-chip{border:1px solid var(--fq-primary);color:var(--fq-primary);background:#fff;border-radius:999px;padding:6px 11px;font-size:13px;cursor:pointer}",
    ".fq-chip:hover{background:var(--fq-primary);color:#fff}",
    ".fq-actions{display:flex;gap:6px;padding:8px 12px 0;background:#fff;border-top:1px solid #e2e8f0;flex-wrap:wrap}",
    ".fq-actions .fq-chip{font-size:12px;padding:5px 10px}",
    ".fq-foot{display:flex;gap:8px;padding:10px 12px 12px;background:#fff;align-items:flex-end}",
    ".fq-input{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:12px;padding:10px 12px;font-size:16px;line-height:1.35;max-height:110px;min-height:42px;color:#0f172a;background:#fff}",
    ".fq-input:focus{outline:none;border-color:var(--fq-primary);box-shadow:0 0 0 3px rgba(0,0,0,.06)}",
    ".fq-btn{border:0;border-radius:12px;background:var(--fq-primary);color:#fff;cursor:pointer;font-weight:600;font-size:14px;padding:0 14px;height:42px;display:inline-flex;align-items:center;justify-content:center;gap:6px}",
    ".fq-btn[disabled]{opacity:.55;cursor:not-allowed}.fq-btn svg{width:18px;height:18px}",
    ".fq-btn.secondary{background:#e2e8f0;color:#0f172a}",
    ".fq-powered{text-align:center;font-size:11px;color:#94a3b8;padding:0 0 8px;background:#fff}.fq-powered a{color:#64748b;text-decoration:none}",
    ".fq-form{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:12px;margin:0 0 10px;font-size:13px;color:#0f172a}",
    ".fq-form h4{margin:0 0 4px;font-size:14px}.fq-form .fq-note{color:#64748b;margin:0 0 8px;font-size:12px}",
    ".fq-tabs{display:flex;gap:6px;margin:0 0 8px}.fq-tabs .fq-chip[aria-pressed=true]{background:var(--fq-primary);color:#fff}",
    ".fq-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.fq-grid .full{grid-column:1/-1}",
    ".fq-form label{display:block;font-weight:600;font-size:12px;color:#334155}",
    ".fq-form input,.fq-form select,.fq-form textarea{width:100%;margin-top:3px;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:16px;color:#0f172a;background:#fff}",
    ".fq-form textarea{resize:vertical;min-height:56px}",
    ".fq-form .fq-err{color:#b91c1c;font-size:12px;margin:6px 0 0}",
    ".fq-form .fq-row{display:flex;gap:8px;margin-top:10px}",
    "@media (max-width:480px){.fq-panel{inset:0;width:100%;max-width:none;height:100%;max-height:none;border-radius:0;bottom:0}.fq-launcher{bottom:16px;" + OPTS.position + ":16px}.fq-panel:not([hidden])~.fq-launcher{display:none}.fq-grid{grid-template-columns:1fr}}",
    "@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}",
  ].join("\n");

  var ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  };

  var host = document.createElement("div");
  host.id = "faidahq-widget";
  host.setAttribute("data-faidahq", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var state = {
    cfg: null,
    visitorId: null,
    conversationId: null,
    messages: [],
    sending: false,
    open: false,
    ready: false,
  };
  var el = {};

  function h(tag, attrs, html) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") n.className = attrs[k];
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    if (html != null) n.innerHTML = html;
    return n;
  }

  function build() {
    var style = h("style", {}, CSS);
    root.appendChild(style);
    var b = state.cfg.branding, biz = state.cfg.business;
    host.style.setProperty("--fq-primary", validHex(b.primary_color, "#4f46e5"));
    host.style.setProperty("--fq-accent", validHex(b.accent_color, "#10b981"));
    var name = b.assistant_name || "Assistant";

    el.panel = h("section", { class: "fq-panel", role: "dialog", "aria-label": "Chat with " + biz.name, hidden: "" });
    var avatar = b.logo_url ? '<img src="' + esc(b.logo_url) + '" alt="">' : esc(name.charAt(0).toUpperCase());
    el.panel.innerHTML =
      '<header class="fq-head"><div class="fq-avatar">' + avatar + '</div>' +
      '<div class="fq-title"><b>' + esc(name) + '</b><small>' + esc(biz.name) + ' · usually replies instantly</small></div>' +
      '<button class="fq-icon" data-act="reset" aria-label="Start a new conversation" title="New conversation">' + ICONS.reset + '</button>' +
      '<button class="fq-icon" data-act="close" aria-label="Close chat">' + ICONS.close + '</button></header>' +
      (OPTS.demo ? '<div class="fq-demo">Demo mode: answers come from sample data, not a live AI.</div>' : "") +
      '<div class="fq-body" role="log" aria-live="polite" aria-relevant="additions"></div>' +
      '<div class="fq-actions"></div>' +
      '<form class="fq-foot" novalidate><textarea class="fq-input" rows="1" maxlength="1000" placeholder="Type your message…" aria-label="Your message"></textarea>' +
      '<button class="fq-btn" type="submit" aria-label="Send message">' + ICONS.send + '</button></form>' +
      '<div class="fq-powered">Powered by <a href="https://faidahq.com/hospitality/" target="_blank" rel="noopener">FaidaHQ</a></div>';
    root.appendChild(el.panel);

    el.launcher = h("button", { class: "fq-launcher", "aria-label": "Open chat with " + name, "aria-expanded": "false" }, ICONS.chat + '<span class="fq-badge" hidden></span>');
    el.teaser = h("div", { class: "fq-teaser", hidden: "", role: "button", tabindex: "0" });
    root.appendChild(el.teaser);
    root.appendChild(el.launcher);

    el.body = el.panel.querySelector(".fq-body");
    el.input = el.panel.querySelector(".fq-input");
    el.form = el.panel.querySelector(".fq-foot");
    el.send = el.form.querySelector("button");
    el.actions = el.panel.querySelector(".fq-actions");

    el.launcher.addEventListener("click", function () { toggle(!state.open); });
    el.teaser.addEventListener("click", function () { toggle(true); });
    el.teaser.addEventListener("keydown", function (e) { if (e.key === "Enter") toggle(true); });
    el.panel.querySelector('[data-act="close"]').addEventListener("click", function () { toggle(false); });
    el.panel.querySelector('[data-act="reset"]').addEventListener("click", resetConversation);
    el.panel.addEventListener("keydown", function (e) { if (e.key === "Escape") toggle(false); });
    el.form.addEventListener("submit", function (e) { e.preventDefault(); send(el.input.value); });
    el.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(el.input.value); }
    });
    el.input.addEventListener("input", autoGrow);

    var bookLabel = biz.type === "restaurant" || biz.type === "cafe" ? "Book a table" : "Make a reservation";
    el.actions.appendChild(h("button", { class: "fq-chip", type: "button", onclick: function () { showReservationForm(); } }, esc(bookLabel)));
    el.actions.appendChild(h("button", { class: "fq-chip", type: "button", onclick: function () { showEnquiryForm(); } }, "Talk to a person"));
  }

  function autoGrow() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 110) + "px";
  }

  function toggle(open) {
    state.open = open;
    el.panel.hidden = !open;
    el.teaser.hidden = true;
    el.launcher.setAttribute("aria-expanded", String(open));
    el.launcher.innerHTML = (open ? ICONS.close : ICONS.chat) + '<span class="fq-badge" hidden></span>';
    el.launcher.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    save({ open: open, teaserSeen: true });
    if (open) {
      scrollDown();
      setTimeout(function () { el.input.focus(); }, 50);
    }
  }

  function scrollDown() { el.body.scrollTop = el.body.scrollHeight; }

  function addBubble(role, content, opts) {
    opts = opts || {};
    var row = h("div", { class: "fq-msg " + role });
    var label = role === "staff" ? '<span class="fq-staff">' + esc(state.cfg.business.name) + " team</span>" : "";
    var bubble = h("div", { class: "fq-bubble" }, label + format(content));
    row.appendChild(bubble);
    el.body.appendChild(row);
    scrollDown();
    return { row: row, bubble: bubble };
  }

  function renderWelcome() {
    var b = state.cfg.branding;
    addBubble("assistant", b.welcome_message || "Hello! How can I help you today?");
    var sugg = (b.suggestions || []).filter(function (s) { return typeof s === "string"; });
    if (sugg.length) {
      var chips = h("div", { class: "fq-chips" });
      sugg.forEach(function (s) {
        chips.appendChild(h("button", { class: "fq-chip", type: "button", onclick: function () { chips.remove(); send(s); } }, esc(s)));
      });
      el.body.appendChild(chips);
    }
  }

  function renderAll() {
    el.body.innerHTML = "";
    renderWelcome();
    state.messages.forEach(function (m) { addBubble(m.role, m.content); });
  }

  function persistMessages() {
    save({ conversationId: state.conversationId, messages: state.messages.slice(-50) });
  }

  function showTyping() {
    var row = h("div", { class: "fq-msg assistant", "aria-label": "Assistant is typing" }, '<div class="fq-bubble fq-typing"><span></span><span></span><span></span></div>');
    el.body.appendChild(row);
    scrollDown();
    return row;
  }

  function setSending(on) {
    state.sending = on;
    el.send.disabled = on;
    el.input.setAttribute("aria-busy", String(on));
  }

  function send(text) {
    text = String(text || "").trim();
    if (!text || state.sending) return;
    if (text.length > 1000) text = text.slice(0, 1000);
    el.input.value = "";
    autoGrow();
    var chips = el.body.querySelector(".fq-chips");
    if (chips) chips.remove();

    state.messages.push({ role: "user", content: text });
    addBubble("user", text);
    persistMessages();
    deliver(text);
  }

  function deliver(text) {
    setSending(true);
    var typing = showTyping();
    var p = OPTS.demo
      ? Demo.chat(text)
      : request("POST", "/chat", {
        business_id: OPTS.businessId,
        visitor_id: state.visitorId,
        conversation_id: state.conversationId,
        message: text,
        page_url: location.href.slice(0, 500),
      });
    p.then(function (res) {
      typing.remove();
      if (res.conversation_id) state.conversationId = res.conversation_id;
      state.messages.push({ role: "assistant", content: res.reply });
      addBubble("assistant", res.reply);
      persistMessages();
      if (res.show_reservation_form) showReservationForm(res.form_kind);
      if (res.escalated && !res.limited) offerHandoff();
    }).catch(function (err) {
      typing.remove();
      var row = addBubble("error", err.message || "Something went wrong. Please try again.");
      if (err.status !== 400) {
        var retry = h("button", { class: "fq-retry", type: "button" }, "Try again");
        retry.addEventListener("click", function () { row.row.remove(); deliver(text); });
        row.bubble.appendChild(retry);
      }
    }).then(function () {
      setSending(false);
      el.input.focus();
    });
  }

  function offerHandoff() {
    if (el.body.querySelector(".fq-form")) return;
    var chips = h("div", { class: "fq-chips" });
    chips.appendChild(h("button", { class: "fq-chip", type: "button", onclick: function () { chips.remove(); showEnquiryForm(); } }, "Leave my contact details"));
    el.body.appendChild(chips);
    scrollDown();
  }

  // --- forms -----------------------------------------------------------------
  function field(label, html, cls) { return '<label class="' + (cls || "") + '">' + label + html + "</label>"; }

  function contactFields() {
    return field("Your name *", '<input name="name" autocomplete="name" maxlength="120" required>', "full") +
      field("Phone", '<input name="phone" type="tel" autocomplete="tel" maxlength="40" placeholder="+254…">') +
      field("Email", '<input name="email" type="email" autocomplete="email" maxlength="200">');
  }

  function openForm(html, onSubmit) {
    var old = el.body.querySelector(".fq-form");
    if (old) old.remove();
    var form = h("form", { class: "fq-form", novalidate: "" }, html +
      '<p class="fq-err" role="alert" hidden></p><div class="fq-row"><button class="fq-btn" type="submit">Send request</button>' +
      '<button class="fq-btn secondary" type="button" data-cancel>Cancel</button></div>');
    form.querySelector("[data-cancel]").addEventListener("click", function () { form.remove(); el.input.focus(); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var errEl = form.querySelector(".fq-err");
      var data = {};
      Array.prototype.forEach.call(form.elements, function (f) { if (f.name) data[f.name] = f.value.trim(); });
      var problem = !data.name ? "Please enter your name."
        : !data.email && !data.phone ? "Please give a phone number or email so the team can reach you."
        : data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email) ? "That email address doesn't look right." : null;
      if (!problem) problem = onSubmit.validate ? onSubmit.validate(data) : null;
      if (problem) { errEl.textContent = problem; errEl.hidden = false; return; }
      errEl.hidden = true;
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Sending…";
      onSubmit.submit(data).then(function (res) {
        form.remove();
        state.messages.push({ role: "assistant", content: res.reply });
        addBubble("assistant", res.reply);
        persistMessages();
      }).catch(function (err) {
        errEl.textContent = err.message || "Could not send. Please try again.";
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = "Send request";
      });
    });
    el.body.appendChild(form);
    scrollDown();
    var first = form.querySelector("input,select,textarea");
    if (first) setTimeout(function () { first.focus(); }, 30);
    return form;
  }

  function submitEnquiry(payload) {
    payload.business_id = OPTS.businessId;
    payload.visitor_id = state.visitorId;
    payload.conversation_id = state.conversationId;
    if (OPTS.demo) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          var saved = load().demoRequests || [];
          saved.push(Object.assign({ at: new Date().toISOString(), status: payload.type === "general" ? "new" : "pending" }, payload));
          save({ demoRequests: saved.slice(-20) });
          resolve({
            reply: payload.type === "general"
              ? "Thank you, " + payload.name + ". Your message has been sent to the team, and they will get back to you soon. (Demo: nothing was really sent.)"
              : "Thank you, " + payload.name + "! Your reservation request has been sent. It is not confirmed yet: the team will check availability and contact you to confirm. (Demo: nothing was really sent.)",
          });
        }, 600);
      });
    }
    return request("POST", "/enquiry", payload);
  }

  function showReservationForm(kind) {
    var type = state.cfg.business.type;
    if (!kind) kind = type === "restaurant" || type === "cafe" ? "restaurant" : "hotel";
    var both = type === "hotel_restaurant";
    var tabs = both
      ? '<div class="fq-tabs"><button type="button" class="fq-chip" data-kind="hotel" aria-pressed="' + (kind === "hotel") + '">Room</button>' +
        '<button type="button" class="fq-chip" data-kind="restaurant" aria-pressed="' + (kind === "restaurant") + '">Table</button></div>'
      : "";
    var hotel = '<div class="fq-grid" data-for="hotel">' +
      field("Check-in *", '<input name="check_in" type="date" min="' + todayISO(0) + '" value="' + todayISO(1) + '">') +
      field("Check-out *", '<input name="check_out" type="date" min="' + todayISO(1) + '" value="' + todayISO(3) + '">') +
      field("Guests *", '<input name="guests" type="number" min="1" max="50" value="2">') +
      field("Room preference", '<input name="room_preference" maxlength="200" placeholder="e.g. Ocean View">') + "</div>";
    var restaurant = '<div class="fq-grid" data-for="restaurant">' +
      field("Date *", '<input name="reservation_date" type="date" min="' + todayISO(0) + '" value="' + todayISO(0) + '">') +
      field("Time *", '<input name="reservation_time" type="time" value="19:30">') +
      field("Guests *", '<input name="guests" type="number" min="1" max="50" value="2">', "full") + "</div>";
    var html = "<h4>Reservation request</h4><p class=\"fq-note\">This is a request, not a confirmed booking. The team will confirm availability with you.</p>" +
      tabs + (kind === "hotel" ? hotel : restaurant) +
      '<div class="fq-grid" style="margin-top:8px">' + contactFields() +
      field("Special requests", '<textarea name="special_requests" maxlength="2000" placeholder="Dietary needs, occasion, arrival time…"></textarea>', "full") + "</div>";

    var form = openForm(html, {
      validate: function (d) {
        var g = Number(d.guests);
        if (!Number.isInteger(g) || g < 1 || g > 50) return "Number of guests must be between 1 and 50.";
        if (kind === "hotel") {
          if (!d.check_in || !d.check_out) return "Please choose your dates.";
          if (d.check_in < todayISO(0)) return "Check-in can't be in the past.";
          if (d.check_out <= d.check_in) return "Check-out must be after check-in.";
        } else {
          if (!d.reservation_date || !d.reservation_time) return "Please choose a date and time.";
          if (d.reservation_date < todayISO(0)) return "The date can't be in the past.";
        }
        return null;
      },
      submit: function (d) {
        d.type = kind;
        d.guests = Number(d.guests);
        return submitEnquiry(d);
      },
    });
    Array.prototype.forEach.call(form.querySelectorAll("[data-kind]"), function (btn) {
      btn.addEventListener("click", function () { showReservationForm(btn.getAttribute("data-kind")); });
    });
  }

  function showEnquiryForm() {
    openForm("<h4>Talk to a person</h4><p class=\"fq-note\">Leave your details and a team member will get back to you.</p>" +
      '<div class="fq-grid">' + contactFields() +
      field("Message *", '<textarea name="message" maxlength="4000" required placeholder="How can we help?"></textarea>', "full") + "</div>", {
      validate: function (d) { return d.message ? null : "Please write a short message."; },
      submit: function (d) { d.type = "general"; return submitEnquiry(d); },
    });
  }

  function resetConversation() {
    state.conversationId = null;
    state.messages = [];
    save({ conversationId: null, messages: [] });
    renderAll();
    el.input.focus();
  }

  // --- startup ---------------------------------------------------------------
  function restoreFromServer() {
    if (OPTS.demo || !state.conversationId) return;
    request("POST", "/widget", {
      action: "history",
      business_id: OPTS.businessId,
      visitor_id: state.visitorId,
      conversation_id: state.conversationId,
    }).then(function (res) {
      if (!res.conversation_id) {
        state.conversationId = null;
        state.messages = [];
      } else {
        state.messages = res.messages.map(function (m) { return { role: m.role, content: m.content }; });
      }
      persistMessages();
      renderAll();
    }).catch(function () { /* keep the locally cached copy */ });
  }

  function showLoadError(message) {
    // Minimal launcher that explains the problem instead of failing silently.
    root.appendChild(h("style", {}, CSS));
    host.style.setProperty("--fq-primary", "#64748b");
    var btn = h("button", { class: "fq-launcher", "aria-label": "Chat unavailable", title: message }, ICONS.chat);
    btn.addEventListener("click", function () { alertBox.hidden = !alertBox.hidden; });
    var alertBox = h("div", { class: "fq-teaser", hidden: "", role: "status" }, esc(message));
    root.appendChild(alertBox);
    root.appendChild(btn);
  }

  function start() {
    document.body.appendChild(host);
    var saved = load();
    state.visitorId = saved.visitorId || randomId();
    state.conversationId = saved.conversationId || null;
    state.messages = Array.isArray(saved.messages) ? saved.messages : [];
    save({ visitorId: state.visitorId });

    var cfgPromise = OPTS.demo
      ? Demo.init().then(function () { return Demo.config(); })
      : (OPTS.businessId
        ? request("GET", "/widget?business_id=" + encodeURIComponent(OPTS.businessId))
        : Promise.reject(new Error("Missing data-business-id on the widget script tag.")));

    cfgPromise.then(function (cfg) {
      state.cfg = cfg;
      build();
      state.ready = true;
      renderAll();
      restoreFromServer();
      if (OPTS.openOnLoad || saved.open) toggle(true);
      else if (!saved.teaserSeen) {
        setTimeout(function () {
          if (state.open) return;
          el.teaser.textContent = "👋 " + (cfg.branding.assistant_name || "We") + " here! Questions about " + cfg.business.name + "?";
          el.teaser.hidden = false;
        }, 4000);
      }
      window.FaidaHQWidget = {
        open: function () { toggle(true); },
        close: function () { toggle(false); },
        send: function (t) { toggle(true); send(t); },
        book: function (k) { toggle(true); showReservationForm(k); },
      };
      document.dispatchEvent(new CustomEvent("faidahq:ready"));
    }).catch(function (err) {
      if (window.console) console.warn("[FaidaHQ widget]", err.message);
      showLoadError(err.status === 403 || err.status === 404
        ? "Chat is not available on this website right now."
        : "Chat could not load. Please refresh the page or try again later.");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
