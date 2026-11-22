// Demo resort website: renders content from the same knowledge file the
// assistant uses, and loads the FaidaHQ chat widget.
(function () {
  "use strict";
  var cfg = window.FaidaHQConfig || {};

  // 1. Load the chat widget in offline demo mode. This page is public, so it never calls
  // the live AI (nobody can spend AI credits here). Admins test the real assistant from /admin/.
  var s = document.createElement("script");
  s.src = "/widget.js";
  s.setAttribute("data-demo", "true");
  s.setAttribute("data-demo-src", "/demo/demo-business.json");
  document.body.appendChild(s);

  function whenWidget(fn) {
    if (window.FaidaHQWidget) fn(window.FaidaHQWidget);
    else document.addEventListener("faidahq:ready", function () { fn(window.FaidaHQWidget); }, { once: true });
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-book],[data-ask]");
    if (!t) return;
    if (t.hasAttribute("data-book")) whenWidget(function (w) { w.book(t.getAttribute("data-book") || undefined); });
    else whenWidget(function (w) { w.send(t.getAttribute("data-ask")); });
  });

  // Mobile menu
  var menuBtn = document.querySelector(".menu-btn");
  var links = document.getElementById("nav-links");
  menuBtn.addEventListener("click", function () {
    var open = links.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  links.addEventListener("click", function (e) { if (e.target.tagName === "A") links.classList.remove("open"); });

  // 2. Render page content from the knowledge file.
  function esc(t) {
    var d = document.createElement("div");
    d.textContent = t == null ? "" : String(t);
    return d.innerHTML;
  }
  function money(b, it) {
    if (it.price == null) return "";
    return '<span class="price">' + b.currency + " " + Number(it.price).toLocaleString("en-US") +
      (it.price_unit ? ' <small>' + esc(it.price_unit) + "</small>" : "") + "</span>";
  }
  var ICON = { room: "🛏️", facility: "🏝️", service: "🚤", offer: "🎉", faq: "❓", policy: "📋" };

  fetch("/demo/demo-business.json").then(function (r) { return r.json(); }).then(function (b) {
    document.querySelectorAll("[data-render]").forEach(function (box) {
      var cats = box.getAttribute("data-render").split(",");
      var items = b.knowledge.filter(function (k) { return cats.indexOf(k.category) >= 0; });
      if (box.classList.contains("menu")) {
        var courses = {};
        items.forEach(function (it) { var c = (it.metadata && it.metadata.course) || "other"; (courses[c] = courses[c] || []).push(it); });
        box.innerHTML = Object.keys(courses).map(function (c) {
          return '<div class="course"><h3>' + esc(c) + "</h3>" + courses[c].map(function (it) {
            return '<div class="dish"><div><strong>' + esc(it.title) + "</strong><p>" + esc(it.content) + "</p></div>" + money(b, it) + "</div>";
          }).join("") + "</div>";
        }).join("");
      } else if (box.classList.contains("faq")) {
        box.innerHTML = items.map(function (it) {
          return "<details><summary>" + esc(it.title) + "</summary><p>" + esc(it.content) + "</p></details>";
        }).join("");
      } else {
        box.innerHTML = items.map(function (it) {
          var ask = it.category === "room" ? "Tell me about the " + it.title : "Tell me about " + it.title;
          return '<article class="card"><div class="card-icon" aria-hidden="true">' + (ICON[it.category] || "✨") + "</div>" +
            "<h3>" + esc(it.title) + "</h3><p>" + esc(it.content) + "</p>" + money(b, it) +
            '<button class="link" data-ask="' + esc(ask) + '">Ask about this →</button></article>';
        }).join("");
      }
    });
    var hours = b.knowledge.filter(function (k) { return k.category === "hours" && k.title === "Pwani Restaurant"; })[0];
    document.querySelectorAll("[data-render-hours]").forEach(function (el) { el.textContent = hours ? hours.content : ""; });
    document.querySelector('[data-field="address"]').textContent = [b.address, b.city, b.country].join(", ");
    var tel = document.querySelector('[data-field="phone-link"]');
    tel.textContent = b.phone; tel.href = "tel:" + b.phone.replace(/\s/g, "");
    var mail = document.querySelector('[data-field="email-link"]');
    mail.textContent = b.email; mail.href = "mailto:" + b.email;
  }).catch(function () {
    document.querySelectorAll(".loading").forEach(function (el) { el.textContent = "Content could not load. Please refresh."; });
  });
})();
