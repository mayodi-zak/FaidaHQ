// Browser tests for the chat widget. Run: deno task test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium, devices } from "playwright";
import { startServer } from "./server.mjs";

const require = createRequire(import.meta.url);

const BIZ = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
let browser, srv;

before(async () => { srv = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

async function newPage(opts = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  // The demo-mode tests must not depend on (or call) the real project in
  // js/faidahq-config.js, so serve an empty public config.
  await page.route("**/js/faidahq-config.js", (r) => r.fulfill({ contentType: "text/javascript", body: "window.FaidaHQConfig={};" }));
  return page;
}
const w = (page) => page.locator("#faidahq-widget");
async function sendMsg(page, text) {
  await w(page).locator(".fq-input").fill(text);
  await w(page).locator(".fq-input").press("Enter");
}
async function lastAssistant(page, count) {
  await page.waitForFunction((n) => document.querySelector("#faidahq-widget").shadowRoot.querySelectorAll(".fq-msg.assistant:not([aria-label])").length >= n, count, { timeout: 15000 });
  return w(page).locator(".fq-msg.assistant .fq-bubble").last().innerText();
}

// ---------------------------------------------------------------- demo mode
test("demo: opens, shows welcome, answers from the knowledge file", async () => {
  const page = await newPage();
  await page.goto(srv.url + "/demo/");
  await w(page).locator(".fq-launcher").click();
  await assert.doesNotReject(w(page).locator(".fq-panel").waitFor({ state: "visible" }));
  assert.match(await w(page).locator(".fq-msg.assistant").first().innerText(), /Amani/);
  assert.match(await w(page).locator(".fq-demo").innerText(), /Demo mode/);
  await sendMsg(page, "What rooms do you have?");
  const reply = await lastAssistant(page, 2);
  assert.match(reply, /Garden Room/);
  assert.match(reply, /KES 14,500/);
  assert.deepEqual(page.errors, []);
});

test("demo: unknown questions are not invented and offer a person", async () => {
  const page = await newPage();
  await page.goto(srv.url + "/demo/");
  await w(page).locator(".fq-launcher").click();
  await sendMsg(page, "Do you have a helicopter landing pad?");
  const reply = await lastAssistant(page, 2);
  assert.match(reply, /don't have that detail/);
  await w(page).getByText("Leave my contact details").waitFor();
});

test("demo: reservation request flow validates and never says confirmed", async () => {
  const page = await newPage();
  await page.goto(srv.url + "/demo/");
  await w(page).locator(".fq-launcher").click();
  await sendMsg(page, "I want to book a room");
  await w(page).locator(".fq-form").waitFor();
  const form = w(page).locator(".fq-form");
  await form.locator('button[type="submit"]').click();
  assert.match(await form.locator(".fq-err").innerText(), /name/);
  await form.locator('input[name="name"]').fill("Wanjiku");
  await form.locator('button[type="submit"]').click();
  assert.match(await form.locator(".fq-err").innerText(), /phone number or email/);
  await form.locator('input[name="phone"]').fill("+254 711 000000");
  await form.locator('button[type="submit"]').click();
  const reply = await lastAssistant(page, 3);
  assert.match(reply, /not confirmed yet/);
});

test("demo: conversation persists across reloads and can be reset", async () => {
  const page = await newPage();
  await page.goto(srv.url + "/demo/");
  await w(page).locator(".fq-launcher").click();
  await sendMsg(page, "What time is check-in?");
  await lastAssistant(page, 2);
  await page.reload();
  await w(page).locator(".fq-panel").waitFor({ state: "visible" });
  assert.equal(await w(page).locator(".fq-msg.user").count(), 1);
  await w(page).locator('[data-act="reset"]').click();
  assert.equal(await w(page).locator(".fq-msg.user").count(), 0);
});

test("demo: mobile layout fills the screen without horizontal scroll", async () => {
  const page = await newPage({ ...devices["iPhone 13"] });
  await page.goto(srv.url + "/demo/");
  await w(page).locator(".fq-launcher").click();
  const box = await w(page).locator(".fq-panel").boundingBox();
  const vp = page.viewportSize();
  assert.equal(Math.round(box.width), vp.width);
  assert.equal(Math.round(box.height), vp.height);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  // input font-size >= 16px prevents iOS zoom on focus
  const fs = await w(page).locator(".fq-input").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(fs >= 16);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/mobile-demo.png" });
  await w(page).locator('[data-act="close"]').click();
  assert.equal(await w(page).locator(".fq-panel").isHidden(), true);
});

// ---------------------------------------------------------------- live mode (mocked API)
function mockApi(page, handlers) {
  const calls = [];
  return page.route("https://api.test/functions/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/functions/v1", "");
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ method: req.method(), path, body });
    const h = handlers[req.method() + " " + path];
    if (!h) return route.fulfill({ status: 404, body: "{}" });
    const out = await h(body, calls);
    if (out === "network") return route.abort("internetdisconnected");
    route.fulfill({ status: out.status || 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(out.json) });
  }).then(() => calls);
}
const CONFIG = { json: { business: { id: BIZ, name: "Hotel Live", type: "hotel", phone: "+254700", email: "x@y.z" }, branding: { assistant_name: "Zuri", primary_color: "#123456", welcome_message: "Karibu to Hotel Live", suggestions: ["Rooms?"] } } };

test("live: talks to the API, keeps the conversation id, applies branding, resists host CSS", async () => {
  const page = await newPage();
  let n = 0;
  const calls = await mockApi(page, {
    "GET /widget": () => CONFIG,
    "POST /chat": (b) => ({ json: { conversation_id: "11111111-1111-4111-8111-111111111111", reply: "Reply " + (++n) + " to " + b.message, show_reservation_form: false, escalated: false } }),
  });
  await page.goto(srv.url + "/tests/e2e/fixtures/live.html");
  await w(page).locator(".fq-launcher").click({ force: true });
  assert.match(await w(page).locator(".fq-msg.assistant").first().innerText(), /Karibu to Hotel Live/);
  const bg = await w(page).locator(".fq-launcher").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(bg, "rgb(18, 52, 86)");
  const fs = await w(page).locator(".fq-bubble").first().evaluate((el) => getComputedStyle(el).fontSize);
  assert.equal(fs, "14px", "host page CSS must not leak into the widget");
  await w(page).locator(".fq-chip", { hasText: "Rooms?" }).click();
  assert.equal(await lastAssistant(page, 2), "Reply 1 to Rooms?");
  await sendMsg(page, "second");
  await lastAssistant(page, 3);
  const chats = calls.filter((c) => c.path === "/chat");
  assert.equal(chats[0].body.conversation_id, null);
  assert.equal(chats[1].body.conversation_id, "11111111-1111-4111-8111-111111111111");
  assert.match(chats[0].body.visitor_id, /^v_[0-9a-f]{36}$/);
  assert.equal(chats[0].body.business_id, BIZ);
});

test("live: AI reservation tag opens the form and the enquiry is posted", async () => {
  const page = await newPage();
  const calls = await mockApi(page, {
    "GET /widget": () => CONFIG,
    "POST /chat": () => ({ json: { conversation_id: "11111111-1111-4111-8111-111111111111", reply: "Sure, here is the form.", show_reservation_form: true } }),
    "POST /enquiry": (b) => ({ status: 201, json: { id: "r1", status: "pending", reply: "Thanks " + b.name + ", request sent. Not confirmed yet." } }),
  });
  await page.goto(srv.url + "/tests/e2e/fixtures/live.html");
  await w(page).locator(".fq-launcher").click({ force: true });
  await sendMsg(page, "book please");
  const form = w(page).locator(".fq-form");
  await form.waitFor();
  await form.locator('input[name="name"]').fill("Otieno");
  await form.locator('input[name="email"]').fill("otieno@example.com");
  await form.locator('button[type="submit"]').click({ force: true });
  assert.match(await lastAssistant(page, 3), /Not confirmed yet/);
  const enq = calls.find((c) => c.path === "/enquiry").body;
  assert.equal(enq.type, "hotel");
  assert.equal(enq.guests, 2);
  assert.equal(enq.conversation_id, "11111111-1111-4111-8111-111111111111");
});

test("live: errors are shown with a retry, rate limits explained", async () => {
  const page = await newPage();
  let fail = true;
  await mockApi(page, {
    "GET /widget": () => CONFIG,
    "POST /chat": () => fail ? "network" : { json: { conversation_id: "11111111-1111-4111-8111-111111111111", reply: "Back online" } },
  });
  await page.goto(srv.url + "/tests/e2e/fixtures/live.html");
  await w(page).locator(".fq-launcher").click({ force: true });
  await sendMsg(page, "hello");
  await w(page).locator(".fq-msg.error").waitFor();
  assert.match(await w(page).locator(".fq-msg.error").innerText(), /offline/);
  fail = false;
  await w(page).locator(".fq-retry").click({ force: true });
  assert.equal(await lastAssistant(page, 2), "Back online");
  assert.equal(await w(page).locator(".fq-msg.error").count(), 0);
});

test("live: 429 message from the server is shown to the guest", async () => {
  const page = await newPage();
  await mockApi(page, {
    "GET /widget": () => CONFIG,
    "POST /chat": () => ({ status: 429, json: { error: "rate_limited", message: "You're sending messages very quickly." } }),
  });
  await page.goto(srv.url + "/tests/e2e/fixtures/live.html");
  await w(page).locator(".fq-launcher").click({ force: true });
  await sendMsg(page, "hi");
  await w(page).locator(".fq-msg.error").waitFor();
  assert.match(await w(page).locator(".fq-msg.error").innerText(), /very quickly/);
});

test("live: suspended business shows an unavailable notice instead of breaking the page", async () => {
  const page = await newPage();
  await mockApi(page, { "GET /widget": () => ({ status: 403, json: { error: "unavailable" } }) });
  await page.goto(srv.url + "/tests/e2e/fixtures/live.html");
  await w(page).locator(".fq-launcher").click({ force: true });
  assert.match(await w(page).locator(".fq-teaser").innerText(), /not available/);
  assert.deepEqual(page.errors, []);
});

test("live: history is restored from the server on reload", async () => {
  const page = await newPage();
  await mockApi(page, {
    "GET /widget": () => CONFIG,
    "POST /chat": () => ({ json: { conversation_id: "11111111-1111-4111-8111-111111111111", reply: "first reply" } }),
    "POST /widget": (b) => ({ json: { conversation_id: b.conversation_id, status: "open", messages: [
      { role: "user", content: "hello" }, { role: "assistant", content: "first reply" }, { role: "staff", content: "Hi, Mary from reception here" }] } }),
  });
  await page.goto(srv.url + "/tests/e2e/fixtures/live.html");
  await w(page).locator(".fq-launcher").click({ force: true });
  await sendMsg(page, "hello");
  await lastAssistant(page, 2);
  await page.reload();
  await w(page).locator(".fq-msg.staff").waitFor();
  assert.match(await w(page).locator(".fq-msg.staff").innerText(), /Mary from reception/);
});

test("live: replies are rendered as text, not HTML (XSS safe)", async () => {
  const page = await newPage();
  await mockApi(page, {
    "GET /widget": () => CONFIG,
    "POST /chat": () => ({ json: { conversation_id: "11111111-1111-4111-8111-111111111111", reply: '<img src=x onerror="window.__xss=1">Hello' } }),
  });
  await page.goto(srv.url + "/tests/e2e/fixtures/live.html");
  await w(page).locator(".fq-launcher").click({ force: true });
  await sendMsg(page, "<b>hi</b>");
  await lastAssistant(page, 2);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await w(page).locator(".fq-msg img").count(), 0);
  assert.match(await w(page).locator(".fq-msg.user").innerText(), /<b>hi<\/b>/);
});

test("preview page: opens the chat for the business in the link, can start over", async () => {
  const page = await newPage();
  // Give this page a live (mocked) API instead of the empty config used by the demo tests.
  await page.route("**/js/faidahq-config.js", (r) => r.fulfill({ contentType: "text/javascript", body: 'window.FaidaHQConfig={functionsUrl:"https://api.test/functions/v1"};' }));
  const calls = await mockApi(page, {
    "GET /widget": () => CONFIG,
    "POST /chat": () => ({ json: { conversation_id: "11111111-1111-4111-8111-111111111111", reply: "Check-in is from 2pm." } }),
  });
  await page.goto(srv.url + "/preview/?b=" + BIZ);
  await page.getByRole("heading", { name: "Try the Hotel Live assistant" }).waitFor();
  await w(page).locator(".fq-input").waitFor(); // chat opens by itself
  await page.getByRole("button", { name: "Check-in times" }).click();
  assert.match(await lastAssistant(page, 2), /Check-in is from 2pm/);
  assert.equal(calls.find((c) => c.path === "/chat").body.business_id, BIZ);

  const bad = await newPage();
  await bad.goto(srv.url + "/preview/?b=not-an-id");
  await bad.getByText("missing or invalid").waitFor();
});
