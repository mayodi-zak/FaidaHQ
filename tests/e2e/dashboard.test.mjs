// Browser tests for the business dashboard and admin page, against a mocked
// Supabase API (no real project needed). Run: deno task test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium, devices } from "playwright";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { startServer } from "./server.mjs";

const require = createRequire(import.meta.url);

const UMD_DIR = dirname(require.resolve("@supabase/supabase-js/dist/umd/supabase.js"));

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@tamubay.example", aud: "authenticated", role: "authenticated" };
const BIZ = { id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", name: "Tamu Bay Resort & Kitchen", slug: "tamu-bay", type: "hotel_restaurant", status: "active", currency: "KES" };
const now = new Date().toISOString();

function fixtures() {
  return {
    business_members: [{ role: "owner", businesses: BIZ }],
    platform_admins: [],
    businesses: [{ ...BIZ, description: "Beach resort", email: "stay@x", phone: "+254", branding: { assistant_name: "Amani", suggestions: ["Rooms?"] }, allowed_origins: [], timezone: "Africa/Nairobi", country: "Kenya" }],
    knowledge_items: [
      { id: "k1", business_id: BIZ.id, category: "room", title: "Garden Room", content: "Queen bed", price: 14500, price_unit: "per night", is_active: true, sort_order: 0 },
      { id: "k2", business_id: BIZ.id, category: "faq", title: "Is breakfast included?", content: "Yes", price: null, is_active: true, sort_order: 0 },
    ],
    conversations: [{ id: "c1", status: "escalated", started_at: now, last_message_at: now, message_count: 3, escalation_reason: "Wedding enquiry", page_url: "https://x/", customers: { name: "Wanjiku", email: "w@x.com", phone: null } }],
    messages: [
      { id: "m1", role: "user", content: "Can we host a wedding?", created_at: now },
      { id: "m2", role: "assistant", content: "I'll ask our events team.", created_at: now },
    ],
    reservations: [{ id: "r1", business_id: BIZ.id, kind: "hotel", check_in: "2026-12-20", check_out: "2026-12-23", guests: 2, room_preference: "Ocean View", contact_name: "Wanjiku", contact_email: "w@x.com", contact_phone: null, special_requests: "", status: "pending", business_notes: "", created_at: now }],
    enquiries: [],
    customers: [{ id: "cu1", name: "Wanjiku", email: "w@x.com", phone: null, notes: "", last_seen: now, reservations: [{ count: 1 }], conversations: [{ count: 1 }] }],
    ai_settings: [{ business_id: BIZ.id, provider: "default", model: null, temperature: 0.3, max_output_tokens: 600, tone: "warm", extra_instructions: "" }],
    ai_usage: [{ created_at: now, input_tokens: 900, output_tokens: 50, success: true, latency_ms: 1200 }],
    plans: [{ code: "starter", name: "Starter", setup_fee: 15000, monthly_price: 5000, currency: "KES", monthly_message_limit: 1000 }],
  };
}
const RPC = {
  business_monthly_usage: [{ used: 850, message_limit: 1000 }],
  list_business_members: [{ user_id: USER.id, email: USER.email, role: "owner", created_at: now }],
  admin_business_overview: [{ id: BIZ.id, name: BIZ.name, slug: BIZ.slug, type: BIZ.type, status: "active", plan_code: "starter", subscription_status: "trial", setup_fee_paid: false, monthly_message_limit: null, effective_limit: 1000, owner_email: USER.email, conversations_30d: 4, ai_replies_month: 850, tokens_month: 90000, pending_reservations: 1, created_at: now }],
};

// Stand-in for the admin-ai-keys Edge Function: like the real one, it never
// returns a saved key, only a "…abcd" hint.
const AI_LABELS = { anthropic: "Anthropic (Claude)", openai: "OpenAI", gemini: "Google Gemini", openai_compatible: "OpenAI-compatible" };
function fakeAiKeys(st, body) {
  if (body.action === "save" && body.api_key) st.saved[body.provider] = { key_hint: "…" + body.api_key.slice(-4), default_model: body.default_model || null };
  if (body.action === "delete") delete st.saved[body.provider];
  if (body.action === "set_defaults") { st.default_provider = body.default_provider; st.fallback_provider = body.fallback_provider; }
  if (body.action === "test") return { ok: true, message: "Working. " + AI_LABELS[body.provider] + " answered." };
  return {
    encryption_ready: true, default_provider: st.default_provider, fallback_provider: st.fallback_provider, env_default_provider: "anthropic",
    providers: Object.keys(AI_LABELS).map((p) => ({
      provider: p, label: AI_LABELS[p], key_saved: !!st.saved[p], key_hint: st.saved[p]?.key_hint ?? null,
      default_model: st.saved[p]?.default_model ?? null, base_url: null, updated_at: st.saved[p] ? now : null,
      env_key_name: p.toUpperCase() + "_API_KEY", env_configured: p === "anthropic",
    })),
  };
}

let browser, srv;
before(async () => { srv = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); srv?.server.close(); });

async function openDashboard(path, { admin = false, signedIn = true, ctxOpts = {} } = {}) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const data = fixtures();
  if (admin) data.platform_admins = [{ user_id: USER.id }];
  const writes = [];
  const aiState = { saved: {}, default_provider: null, fallback_provider: null };
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));

  await page.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/*", (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    route.fulfill({ contentType: "text/javascript", body: readFileSync(join(UMD_DIR, file)) });
  });
  await page.route("**/js/faidahq-config.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: 'window.FaidaHQConfig={supabaseUrl:"https://sb.test",supabaseAnonKey:"anon",functionsUrl:"https://sb.test/functions/v1",demoBusinessId:"' + BIZ.id + '"};',
  }));
  await page.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ body: "" }));
  await page.route("https://sb.test/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", ...headers }, body: JSON.stringify(body) });
    if (url.pathname.startsWith("/auth/v1/user")) return json(USER);
    if (url.pathname.startsWith("/auth/v1/logout")) return route.fulfill({ status: 204 });
    if (url.pathname.startsWith("/auth/v1/token")) return json({ access_token: "t", refresh_token: "r", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: USER });
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/);
    if (rpc) {
      if (req.method() === "POST") writes.push({ rpc: rpc[1], body: JSON.parse(req.postData() || "{}") });
      return json(RPC[rpc[1]] ?? null);
    }
    const t = url.pathname.match(/^\/rest\/v1\/(\w+)/);
    if (t) {
      const table = t[1];
      const rows = data[table] || [];
      if (req.method() === "HEAD") return route.fulfill({ status: 200, headers: { "content-range": `0-0/${rows.length}`, "access-control-allow-origin": "*", "access-control-expose-headers": "content-range" } });
      if (req.method() === "GET") {
        const single = (req.headers()["accept"] || "").includes("vnd.pgrst.object");
        return json(single ? rows[0] ?? null : rows);
      }
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      writes.push({ table, method: req.method(), body, query: url.search });
      const out = Array.isArray(body) ? body[0] : body || {};
      const row = { id: "new-" + writes.length, created_at: now, ...out };
      const single = (req.headers()["accept"] || "").includes("vnd.pgrst.object");
      return json(single ? row : [row], req.method() === "POST" ? 201 : 200);
    }
    if (url.pathname === "/functions/v1/admin-ai-keys") {
      const body = JSON.parse(req.postData() || "{}");
      writes.push({ fn: "admin-ai-keys", body });
      return json(fakeAiKeys(aiState, body));
    }
    return json({}, 404);
  });

  if (signedIn) {
    await page.addInitScript((user) => {
      localStorage.setItem("sb-sb-auth-token", JSON.stringify({
        access_token: "t", refresh_token: "r", token_type: "bearer", expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, user,
      }));
    }, USER);
  }
  await page.goto(srv.url + path);
  return { page, writes };
}

test("dashboard: shows sign-in when signed out, and setup notice without config", async () => {
  const { page } = await openDashboard("/dashboard/", { signedIn: false });
  await page.getByRole("heading", { name: "FaidaHQ dashboard" }).waitFor();
  await page.getByRole("button", { name: "Sign in" }).click();
  assert.match(await page.locator(".form-error").innerText(), /valid email/);

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ body: "" }));
  await p2.goto(srv.url + "/dashboard/");
  await p2.getByRole("heading", { name: "Almost there" }).waitFor();
});

test("dashboard: every section renders without errors", async () => {
  const { page } = await openDashboard("/dashboard/#overview");
  await page.locator(".kpis").waitFor();
  assert.match(await page.locator(".meter-label").innerText(), /850 of 1,000/);
  assert.match(await page.locator(".pill.warning").first().innerText(), /Nearly used up|escalated/i);
  const expectations = {
    profile: "Add the chat to your website", knowledge: "Garden Room", conversations: "Wanjiku", reservations: "Ocean View",
    customers: "w@x.com", ai: "Save AI settings", analytics: "Assistant replies per day", settings: "Team",
  };
  for (const [view, text] of Object.entries(expectations)) {
    await page.evaluate((v) => { location.hash = v; }, view);
    await page.locator("#view").getByText(text).first().waitFor({ timeout: 5000 });
  }
  assert.deepEqual(page.errors, []);
});

test("dashboard: add knowledge item sends the right row", async () => {
  const { page, writes } = await openDashboard("/dashboard/#knowledge");
  await page.getByRole("button", { name: "+ Add information" }).click();
  const modal = page.locator(".modal");
  await modal.locator('select[name="category"]').selectOption("menu_item");
  await modal.getByRole("button", { name: "Save" }).click();
  assert.match(await modal.locator(".form-error").innerText(), /Title is required/);
  await modal.locator('input[name="title"]').fill("Prawn pilau");
  await modal.locator('textarea[name="content"]').fill("Lamu style");
  await modal.locator('input[name="price"]').fill("2900");
  await modal.getByRole("button", { name: "Save" }).click();
  await page.locator("#view").getByText("Prawn pilau").waitFor();
  const w = writes.find((x) => x.table === "knowledge_items" && x.method === "POST");
  assert.equal(w.body.business_id, BIZ.id);
  assert.equal(w.body.category, "menu_item");
  assert.equal(w.body.price, 2900);
});

test("dashboard: confirm a reservation and reply to a conversation", async () => {
  const { page, writes } = await openDashboard("/dashboard/#reservations");
  await page.getByRole("button", { name: "Confirm" }).first().click();
  await page.locator(".modal textarea").fill("Ocean view 12 held");
  await page.locator(".modal").getByRole("button", { name: "Confirm" }).click();
  await page.waitForFunction(() => document.querySelector(".toast"));
  const upd = writes.find((x) => x.table === "reservations" && x.method === "PATCH");
  assert.equal(upd.body.status, "confirmed");
  assert.match(upd.query, /business_id=eq\./);

  await page.evaluate(() => { location.hash = "conversations/c1"; });
  await page.locator("#thread").getByText("Can we host a wedding?").waitFor();
  await page.locator("#reply textarea").fill("Yes! Our events manager will call you today.");
  await page.locator("#reply").getByRole("button", { name: "Send" }).click();
  await page.locator("#thread").getByText("events manager will call").waitFor();
  const msg = writes.find((x) => x.table === "messages" && x.method === "POST");
  assert.equal(msg.body.role, "staff");
  assert.equal(msg.body.conversation_id, "c1");
});

test("dashboard: profile rejects bad allowed websites", async () => {
  const { page, writes } = await openDashboard("/dashboard/#profile");
  await page.locator('textarea[name="allowed_origins"]').fill("myhotel.co.ke/path");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.locator(".toast.error").waitFor();
  assert.equal(writes.filter((x) => x.table === "businesses").length, 0);
  await page.locator('textarea[name="allowed_origins"]').fill("https://myhotel.co.ke/");
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.waitForFunction(() => document.querySelector(".toast:not(.error)"));
  const w = writes.find((x) => x.table === "businesses");
  assert.deepEqual(w.body.allowed_origins, ["https://myhotel.co.ke"]);
});

test("dashboard: usable on a phone", async () => {
  const { page } = await openDashboard("/dashboard/#overview", { ctxOpts: { ...devices["Pixel 7"] } });
  await page.locator(".kpis").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.locator("#menu").click();
  await page.locator(".sidebar nav a", { hasText: "Reservations" }).click();
  await page.locator("#view").getByText("Ocean View").waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/mobile-dashboard.png" });
});

test("admin: non-admins are refused; admins see platform overview", async () => {
  const { page } = await openDashboard("/admin/");
  await page.getByRole("heading", { name: "Not allowed" }).waitFor();

  const { page: p2, writes } = await openDashboard("/admin/", { admin: true });
  await p2.locator("#tbl").getByText(BIZ.name).waitFor();
  assert.match(await p2.locator(".kpis").innerText(), /850/);
  await p2.getByRole("button", { name: "Manage" }).click();
  await p2.locator('.modal select[name="status"]').selectOption("suspended");
  await p2.locator(".modal").getByRole("button", { name: "Save" }).click();
  await p2.waitForFunction(() => document.querySelector(".toast"));
  const w = writes.find((x) => x.table === "businesses" && x.method === "PATCH");
  assert.equal(w.body.status, "suspended");
  await p2.screenshot({ path: "test-results/admin.png", fullPage: true });
  assert.deepEqual(p2.errors, []);
});

test("admin: AI providers page saves keys without ever showing them again", async () => {
  const { page, writes } = await openDashboard("/admin/#ai", { admin: true });
  await page.getByRole("heading", { name: "API keys" }).waitFor();
  assert.match(await page.locator("tr", { hasText: "Anthropic" }).innerText(), /Using server secret/);

  await page.locator("tr", { hasText: "Google Gemini" }).getByRole("button", { name: "Add key" }).click();
  const keyInput = page.locator('.modal input[name="api_key"]');
  assert.equal(await keyInput.getAttribute("type"), "password");
  await keyInput.fill("fake-gemini-test-only-key-9876");
  await page.locator('.modal input[name="default_model"]').fill("gemini-2.5-flash");
  await page.locator(".modal").getByRole("button", { name: "Save" }).click();
  await page.locator("tr", { hasText: "Google Gemini" }).getByText("Key saved …9876").waitFor();
  assert.ok(!(await page.content()).includes("fake-gemini-test-only-key-9876"), "saved key must not appear on the page");
  assert.equal(writes.find((w) => w.fn && w.body.action === "save").body.provider, "gemini");

  await page.locator('#defaults select[name="default_provider"]').selectOption("openai");
  await page.locator('#defaults select[name="fallback_provider"]').selectOption("gemini");
  await page.getByRole("button", { name: "Save choice" }).click();
  // Wait for the request itself: an earlier "Key saved" toast may still be on screen.
  for (let i = 0; i < 50 && !writes.some((w) => w.fn && w.body.action === "set_defaults"); i++) await page.waitForTimeout(100);
  const d = writes.find((w) => w.fn && w.body.action === "set_defaults").body;
  assert.deepEqual([d.default_provider, d.fallback_provider], ["openai", "gemini"]);

  await page.locator("tr", { hasText: "Google Gemini" }).getByRole("button", { name: "Test" }).click();
  await page.locator(".toast", { hasText: "Working" }).waitFor();
  await page.screenshot({ path: "test-results/admin-ai.png", fullPage: true });
  assert.deepEqual(page.errors, []);
});
