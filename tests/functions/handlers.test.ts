// Edge Function logic tests. Run: deno test tests/functions
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.8";
import { chat, conversationHistory, submitEnquiry, widgetConfig, type Deps } from "../../supabase/functions/_shared/handlers.ts";
import type { AiRequest, AiResult, ProviderConfig } from "../../supabase/functions/_shared/ai.ts";
import { HttpError } from "../../supabase/functions/_shared/http.ts";
import { ValidationError } from "../../supabase/functions/_shared/validate.ts";
import { fakeRepo, makeBusiness } from "./fake_repo.ts";

const VISITOR = "visitor_abcdefghijklmnop";
const env = (n: string) => ({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key" } as Record<string, string>)[n];

function setup(replyText = "Our Garden Room is KES 14,500 per night.") {
  const a = makeBusiness({ name: "Hotel Alpha" });
  const b = makeBusiness({ name: "Cafe Beta", type: "cafe" });
  const { repo, s } = fakeRepo({
    businesses: [a, b],
    knowledge: [
      { business_id: a.id, category: "room", title: "Garden Room", content: "Queen bed", price: 14500, price_unit: "per night" },
      { business_id: b.id, category: "menu_item", title: "Secret Beta Latte", content: "Only at Beta", price: 400 },
    ],
  });
  const calls: AiRequest[] = [];
  const ai = async (cfg: ProviderConfig, req: AiRequest): Promise<AiResult> => {
    calls.push(req);
    return { text: replyText, provider: cfg.provider, model: cfg.model, inputTokens: 100, outputTokens: 20, refused: false };
  };
  const deps: Deps = { repo, env, ai, now: () => new Date("2026-11-22T09:00:00Z") };
  return { a, b, s, deps, calls };
}

Deno.test("chat: answers, stores both messages and logs usage", async () => {
  const { a, s, deps } = setup();
  const res = await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "How much is a room?" }, null, "1.1.1.1");
  assertEquals(res.reply, "Our Garden Room is KES 14,500 per night.");
  assert(res.conversation_id);
  assertEquals(s.messages.map((m) => m.role), ["user", "assistant"]);
  assertEquals(s.usage.length, 1);
  assertEquals(s.conversations[0].message_count, 2);
});

Deno.test("chat: prompt only contains the requested business's knowledge (isolation)", async () => {
  const { a, deps, calls } = setup();
  await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "Do you have lattes?" }, null, "1.1.1.1");
  assertStringIncludes(calls[0].system, "Hotel Alpha");
  assertStringIncludes(calls[0].system, "Garden Room");
  assert(!calls[0].system.includes("Secret Beta Latte"), "business B data leaked into business A prompt");
  assert(!calls[0].system.includes("Cafe Beta"));
});

Deno.test("chat: a conversation id from another business is not reused", async () => {
  const { a, b, s, deps } = setup();
  const first = await chat(deps, { business_id: b.id, visitor_id: VISITOR, message: "hi" }, null, "1.1.1.1");
  const second = await chat(deps, { business_id: a.id, visitor_id: VISITOR, conversation_id: first.conversation_id, message: "hi" }, null, "1.1.1.1");
  assert(second.conversation_id !== first.conversation_id);
  assertEquals(s.conversations.find((c) => c.id === second.conversation_id)?.business_id, a.id);
});

Deno.test("chat: another visitor cannot continue someone else's conversation", async () => {
  const { a, deps } = setup();
  const first = await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "my booking ref is 123" }, null, "1.1.1.1");
  const other = await chat(deps, { business_id: a.id, visitor_id: "intruder_zzzzzzzzzzzzzzzz", conversation_id: first.conversation_id, message: "what did I say?" }, null, "2.2.2.2");
  assert(other.conversation_id !== first.conversation_id);
  const hist = await conversationHistory(deps, { business_id: a.id, visitor_id: "intruder_zzzzzzzzzzzzzzzz", conversation_id: first.conversation_id }, null);
  assertEquals(hist.messages.length, 0);
});

Deno.test("chat: sends earlier turns to the AI as context", async () => {
  const { a, deps, calls } = setup();
  const r1 = await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "Hi" }, null, "1.1.1.1");
  await chat(deps, { business_id: a.id, visitor_id: VISITOR, conversation_id: r1.conversation_id, message: "And for 3 nights?" }, null, "1.1.1.1");
  assertEquals(calls[1].messages.map((m) => m.role), ["user", "assistant", "user"]);
  assertEquals(calls[1].messages[2].content, "And for 3 nights?");
});

Deno.test("chat: escalation and reservation tags are stripped and acted on", async () => {
  const { a, s, deps } = setup("I'll ask the manager about that. [[ESCALATE: asked about wedding packages]] [[RESERVATION]]");
  const res = await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "Wedding for 200?" }, null, "1.1.1.1");
  assertEquals(res.reply, "I'll ask the manager about that.");
  assert(res.escalated);
  assert(res.show_reservation_form);
  assertEquals(s.conversations[0].status, "escalated");
  assertEquals((s.conversations[0] as unknown as { escalation_reason: string }).escalation_reason, "asked about wedding packages");
});

Deno.test("chat: rejects suspended or unknown businesses", async () => {
  const { b, s, deps } = setup();
  s.businesses.find((x) => x.id === b.id)!.status = "suspended";
  const e1 = await assertRejects(() => chat(deps, { business_id: b.id, visitor_id: VISITOR, message: "hi" }, null, "1"), HttpError);
  assertEquals(e1.status, 403);
  const e2 = await assertRejects(() => chat(deps, { business_id: crypto.randomUUID(), visitor_id: VISITOR, message: "hi" }, null, "1"), HttpError);
  assertEquals(e2.status, 404);
});

Deno.test("chat: enforces allowed website origins", async () => {
  const { a, s, deps } = setup();
  s.businesses.find((x) => x.id === a.id)!.allowed_origins = ["https://hotel-alpha.co.ke"];
  await assertRejects(() => chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "hi" }, "https://evil.example", "1"), HttpError);
  const ok = await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "hi" }, "https://hotel-alpha.co.ke/", "1");
  assert(ok.reply);
});

Deno.test("chat: validates input", async () => {
  const { a, deps } = setup();
  await assertRejects(() => chat(deps, { business_id: "not-a-uuid", visitor_id: VISITOR, message: "hi" }, null, "1"), ValidationError);
  await assertRejects(() => chat(deps, { business_id: a.id, visitor_id: "short", message: "hi" }, null, "1"), ValidationError);
  await assertRejects(() => chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "   " }, null, "1"), ValidationError);
  await assertRejects(() => chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "x".repeat(1001) }, null, "1"), ValidationError);
});

Deno.test("chat: rate limits a flooding visitor", async () => {
  const { a, deps } = setup();
  let blocked: HttpError | null = null;
  for (let i = 0; i < 20 && !blocked; i++) {
    try {
      await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "spam " + i }, null, "9.9.9.9");
    } catch (e) {
      blocked = e as HttpError;
    }
  }
  assert(blocked, "expected the visitor to be rate limited");
  assertEquals(blocked!.status, 429);
});

Deno.test("chat: monthly plan limit gives a polite reply without calling the AI", async () => {
  const { a, s, deps, calls } = setup();
  s.limit = 0 + 1;
  s.usage.push({ business_id: a.id, success: true });
  const res = await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "hi" }, null, "1");
  assertEquals(calls.length, 0);
  assert((res as { limited?: boolean }).limited);
  assertStringIncludes(res.reply, "+254700000000");
});

Deno.test("chat: AI failure is logged and surfaced as an error", async () => {
  const { a, s, deps } = setup();
  deps.ai = () => Promise.reject(new Error("boom"));
  await assertRejects(() => chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "hi" }, null, "1"));
  assertEquals(s.usage[0].success, false);
  assertEquals(s.messages.length, 1, "guest message is still saved for staff to follow up");
});

Deno.test("enquiry: hotel reservation is saved as pending and never claimed confirmed", async () => {
  const { a, s, deps } = setup();
  const r = await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "book" }, null, "1");
  const res = await submitEnquiry(deps, {
    business_id: a.id, visitor_id: VISITOR, conversation_id: r.conversation_id, type: "hotel",
    name: "Wanjiku", email: "wanjiku@example.com", check_in: "2026-12-20", check_out: "2026-12-23", guests: 2, room_preference: "Ocean View",
  }, null, "1");
  assertEquals(res.status, "pending");
  assertStringIncludes(res.reply, "not confirmed yet");
  assertEquals(s.reservations[0].status, "pending");
  assertEquals(s.reservations[0].business_id, a.id);
  assertEquals(s.customers.length, 1);
  assertEquals(s.conversations[0].customer_id, s.customers[0].id);
});

Deno.test("enquiry: restaurant booking validation", async () => {
  const { a, deps } = setup();
  const base = { business_id: a.id, visitor_id: VISITOR, type: "restaurant", name: "Otieno", phone: "+254 711 222333", guests: 4 };
  await assertRejects(() => submitEnquiry(deps, { ...base, reservation_date: "2026-11-01", reservation_time: "19:00" }, null, "1"), ValidationError, "past");
  await assertRejects(() => submitEnquiry(deps, { ...base, reservation_date: "2026-11-25", reservation_time: "25:00" }, null, "1"), ValidationError);
  await assertRejects(() => submitEnquiry(deps, { ...base, phone: "", reservation_date: "2026-11-25", reservation_time: "19:00" }, null, "1"), ValidationError, "email address or phone");
  const ok = await submitEnquiry(deps, { ...base, reservation_date: "2026-11-25", reservation_time: "19:30" }, null, "1");
  assertEquals(ok.type, "restaurant");
});

Deno.test("enquiry: hotel dates must make sense", async () => {
  const { a, deps } = setup();
  const base = { business_id: a.id, visitor_id: VISITOR, type: "hotel", name: "A", email: "a@b.co", guests: 2 };
  await assertRejects(() => submitEnquiry(deps, { ...base, check_in: "2026-12-05", check_out: "2026-12-05" }, null, "1"), ValidationError, "after check-in");
  await assertRejects(() => submitEnquiry(deps, { ...base, check_in: "2026-12-05", check_out: "2027-03-05" }, null, "1"), ValidationError, "60 nights");
  await assertRejects(() => submitEnquiry(deps, { ...base, email: "not-an-email", check_in: "2026-12-05", check_out: "2026-12-07" }, null, "1"), ValidationError, "email");
});

Deno.test("enquiry: general enquiry", async () => {
  const { a, s, deps } = setup();
  const res = await submitEnquiry(deps, { business_id: a.id, visitor_id: VISITOR, type: "general", name: "Ali", email: "ali@example.com", message: "Do you host conferences?" }, null, "1");
  assertEquals(res.status, "new");
  assertEquals(s.enquiries.length, 1);
});

Deno.test("widget config: returns branding and hides internal fields", async () => {
  const { a, deps } = setup();
  const cfg = await widgetConfig(deps, { business_id: a.id }, null);
  assertEquals(cfg.branding.assistant_name, "Zuri");
  assertEquals(cfg.business.name, "Hotel Alpha");
  assert(!("allowed_origins" in cfg.business));
  assert(!("status" in cfg.business));
});

Deno.test("private assistant: only a signed-in admin/member may chat, enquire or load it", async () => {
  const { a, s, deps, calls } = setup();
  a.public_chat = false;
  const body = { business_id: a.id, visitor_id: VISITOR, message: "hi" };
  // Anonymous visitor (anyone on the internet): refused, and no AI call is made.
  await assertRejects(() => chat(deps, body, null, "1"), HttpError, "private");
  await assertRejects(() => widgetConfig(deps, { business_id: a.id }, null), HttpError, "private");
  await assertRejects(() => submitEnquiry(deps, { business_id: a.id, visitor_id: VISITOR, type: "general", name: "x", email: "x@y.co", message: "m" }, null, "1"), HttpError, "private");
  // Signed in, but not an admin/member of this business: refused.
  await assertRejects(() => chat({ ...deps, userId: "stranger", canTest: async () => false }, body, null, "1"), HttpError, "access");
  assertEquals(calls.length, 0);
  assertEquals(s.usage.length, 0);
  // Signed-in admin/member: allowed.
  const res = await chat({ ...deps, userId: "admin", canTest: async (u) => u === "admin" }, body, null, "1");
  assert(res.reply.length > 0);
  assertEquals(calls.length, 1);
});

Deno.test("public assistants stay open to anonymous guests", async () => {
  const { a, deps } = setup();
  assertEquals(a.public_chat, undefined);
  const res = await chat(deps, { business_id: a.id, visitor_id: VISITOR, message: "hi" }, null, "1");
  assert(res.reply.length > 0);
});
