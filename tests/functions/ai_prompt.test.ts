// Tests for the AI provider layer and prompt building. No network is used.
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.8";
import { AiConfigError, AiProviderError, generateReply, resolveProviderConfig } from "../../supabase/functions/_shared/ai.ts";
import { buildSystemPrompt, formatKnowledge, parseAssistantReply } from "../../supabase/functions/_shared/prompt.ts";

const envOf = (o: Record<string, string>) => (n: string) => o[n];

Deno.test("provider config: platform default, business override and missing secrets", () => {
  const a = resolveProviderConfig({ provider: "default" }, envOf({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }));
  assertEquals(a.provider, "anthropic");
  assertEquals(a.model, "claude-opus-5-5");
  assertEquals(a.baseUrl, "https://api.anthropic.com");

  const b = resolveProviderConfig({ provider: "default" }, envOf({ AI_PROVIDER: "anthropic", AI_MODEL: "claude-haiku-5-5", ANTHROPIC_API_KEY: "k" }));
  assertEquals(b.model, "claude-haiku-5-5");

  const c = resolveProviderConfig({ provider: "openai_compatible", model: "llama-x" },
    envOf({ OPENAI_COMPATIBLE_API_KEY: "k", OPENAI_COMPATIBLE_BASE_URL: "https://llm.example/v1/" }));
  assertEquals(c.baseUrl, "https://llm.example/v1");
  assertEquals(c.model, "llama-x");

  assertThrows(() => resolveProviderConfig({}, envOf({ AI_PROVIDER: "anthropic" })), AiConfigError, "ANTHROPIC_API_KEY");
  assertThrows(() => resolveProviderConfig({ provider: "openai" }, envOf({ OPENAI_API_KEY: "k" })), AiConfigError, "AI_MODEL");
  assertThrows(() => resolveProviderConfig({ provider: "mystery" }, envOf({})), AiConfigError);
});

Deno.test("anthropic adapter: request shape and response parsing", async () => {
  let seen: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({
      model: "claude-opus-5-5", stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Karibu! " }, { type: "text", text: "Rooms from KES 14,500." }],
      usage: { input_tokens: 900, output_tokens: 40 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const cfg = resolveProviderConfig({}, envOf({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "secret" }));
  const res = await generateReply(cfg, { system: "SYS", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 500, temperature: 0.3 }, fakeFetch);
  assertEquals(res.text, "Karibu! Rooms from KES 14,500.");
  assertEquals(res.inputTokens, 900);
  assertEquals(seen!.url, "https://api.anthropic.com/v1/messages");
  assertEquals(seen!.headers.get("x-api-key"), "secret");
  assertEquals(seen!.headers.get("anthropic-version"), "2026-10-21");
  assertEquals(seen!.body.system, "SYS");
  assert(!("temperature" in seen!.body), "temperature is not sent to Claude");
});

Deno.test("openai-style adapter: request shape and response parsing", async () => {
  let body: Record<string, unknown> = {};
  let auth = "";
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    auth = new Headers(init.headers).get("authorization") || "";
    return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  }) as unknown as typeof fetch;
  const cfg = resolveProviderConfig({ provider: "openai", model: "m" }, envOf({ OPENAI_API_KEY: "sk" }));
  const res = await generateReply(cfg, { system: "SYS", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 100, temperature: 0.2 }, fakeFetch);
  assertEquals(res.text, "Hello");
  assertEquals(auth, "Bearer sk");
  assertEquals((body.messages as Array<{ role: string }>)[0].role, "system");
});

Deno.test("provider errors do not leak details", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key sk-123" } }), { status: 401 })) as unknown as typeof fetch;
  const cfg = resolveProviderConfig({}, envOf({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "bad" }));
  const err = await assertRejects(() => generateReply(cfg, { system: "", messages: [{ role: "user", content: "x" }], maxOutputTokens: 10, temperature: 0 }, fakeFetch), AiProviderError);
  assert(!err.message.includes("sk-123"));
});

Deno.test("prompt: includes rules, contact, prices and groups knowledge", () => {
  const prompt = buildSystemPrompt(
    { id: "x", name: "Tamu Bay", type: "hotel_restaurant", description: "Beach resort", timezone: "Africa/Nairobi", currency: "KES", phone: "+254 700", branding: { assistant_name: "Amani" } },
    [
      { category: "room", title: "Garden Room", content: "Queen bed", price: 14500, price_unit: "per night" },
      { category: "menu_item", title: "Pilau", content: "Spiced rice", price: "2900", metadata: { course: "main" } },
    ],
    { tone: "warm", extra_instructions: "Say Karibu" },
    "2026-11-22",
  );
  assertStringIncludes(prompt, "You are Amani");
  assertStringIncludes(prompt, "Never invent or estimate prices");
  assertStringIncludes(prompt, "Never say a reservation is confirmed");
  assertStringIncludes(prompt, "Garden Room — KES 14,500 per night: Queen bed");
  assertStringIncludes(prompt, "Pilau [main] — KES 2,900");
  assertStringIncludes(prompt, "Say Karibu");
  assertStringIncludes(prompt, "Phone: +254 700");
  assertStringIncludes(prompt, "2026-11-22");
});

Deno.test("prompt: empty knowledge base is stated", () => {
  assertEquals(formatKnowledge([], "KES"), "(The business has not added any details yet.)");
});

Deno.test("reply parsing: tags", () => {
  assertEquals(parseAssistantReply("Sure. [[RESERVATION]]"), { text: "Sure.", showReservationForm: true, escalate: false, escalationReason: null });
  const e = parseAssistantReply("[[ESCALATE: refund]]");
  assert(e.escalate);
  assertEquals(e.escalationReason, "refund");
  assertStringIncludes(e.text, "team");
  assertEquals(parseAssistantReply("[[escalate]] ok").escalate, true);
});
