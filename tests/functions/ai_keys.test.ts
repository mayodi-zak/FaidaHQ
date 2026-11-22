// Tests for encrypted AI keys: crypto, provider choice with saved keys,
// fallback provider, and the admin-only key function. No network is used.
import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.8";
import { decryptSecret, encryptSecret, importMasterKey, keyHint } from "../../supabase/functions/_shared/crypto.ts";
import {
  AiProviderError, type AiRequest, type AiResult, type PlatformAi, type ProviderConfig, resolveFallbackConfig,
  resolveProviderConfig,
} from "../../supabase/functions/_shared/ai.ts";
import { decryptPlatformAi, type CredentialRow, type PlatformSettingsRow } from "../../supabase/functions/_shared/platform_ai.ts";
import { type AdminAiStore, adminAiKeys } from "../../supabase/functions/_shared/admin_ai.ts";
import { chat, type Deps } from "../../supabase/functions/_shared/handlers.ts";
import { HttpError } from "../../supabase/functions/_shared/http.ts";
import { ValidationError } from "../../supabase/functions/_shared/validate.ts";
import { fakeRepo, makeBusiness } from "./fake_repo.ts";

// Throwaway test-only master keys (random, not used anywhere real).
function randomSecret(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}
const MASTER = randomSecret();
const envOf = (o: Record<string, string>) => (n: string) => o[n];

// ---------------------------------------------------------------- crypto

Deno.test("crypto: round trip, random IV, and tamper/wrong-provider/wrong-key all fail", async () => {
  const key = await importMasterKey(MASTER);
  const a = await encryptSecret("fake-test-123456789", key, "openai");
  const b = await encryptSecret("fake-test-123456789", key, "openai");
  assert(a.startsWith("v1:"));
  assertNotEquals(a, b, "same key must encrypt differently each time");
  assert(!a.includes("fake-test"), "ciphertext must not contain the key");
  assertEquals(await decryptSecret(a, key, "openai"), "fake-test-123456789");

  await assertRejects(() => decryptSecret(a, key, "gemini")); // copied onto another provider's row
  const [v, iv, ct] = a.split(":");
  const flipped = ct.slice(0, 5) + (ct[5] === "A" ? "B" : "A") + ct.slice(6);
  await assertRejects(() => decryptSecret(`${v}:${iv}:${flipped}`, key, "openai"));
  await assertRejects(async () => decryptSecret(a, await importMasterKey(randomSecret()), "openai"));
});

Deno.test("crypto: master key must be set, base64 and 32 bytes", async () => {
  await assertRejects(() => importMasterKey(undefined), Error, "not set");
  await assertRejects(() => importMasterKey("not base64 !!"), Error, "base64");
  await assertRejects(() => importMasterKey(btoa("too short")), Error, "32 bytes");
});

Deno.test("crypto: key hint shows only the last 4 characters", () => {
  assertEquals(keyHint("fake-abcdefghijklmnop1234"), "…1234");
  assertEquals(keyHint("short"), "…");
});

// ---------------------------------------------------------------- provider choice

const saved = (o: Partial<PlatformAi> = {}): PlatformAi => ({
  credentials: {
    openai: { apiKey: "db-openai", defaultModel: "gpt-5-mini" },
    gemini: { apiKey: "db-gemini", defaultModel: "gemini-2.5-flash" },
  },
  ...o,
});

Deno.test("provider choice: saved key beats function secret; admin default beats AI_PROVIDER", () => {
  const env = envOf({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "env-anthropic", OPENAI_API_KEY: "env-openai" });
  const cfg = resolveProviderConfig({ provider: "default" }, env, saved({ defaultProvider: "openai" }));
  assertEquals(cfg.provider, "openai");
  assertEquals(cfg.apiKey, "db-openai");
  assertEquals(cfg.model, "gpt-5-mini");
  assertEquals(cfg.baseUrl, "https://api.openai.com/v1");

  // No admin default: AI_PROVIDER secret still decides.
  assertEquals(resolveProviderConfig({}, env, saved()).provider, "anthropic");
});

Deno.test("provider choice: business override of provider and model; Gemini endpoint", () => {
  const cfg = resolveProviderConfig({ provider: "gemini", model: "gemini-2.5-pro" }, envOf({}), saved({ defaultProvider: "openai" }));
  assertEquals(cfg.provider, "gemini");
  assertEquals(cfg.model, "gemini-2.5-pro");
  assertEquals(cfg.apiKey, "db-gemini");
  assertEquals(cfg.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
});

Deno.test("provider choice: no saved key falls back to the function secret", () => {
  const cfg = resolveProviderConfig({ provider: "gemini", model: "gemini-2.5-flash" }, envOf({ GEMINI_API_KEY: "env-gemini" }));
  assertEquals(cfg.apiKey, "env-gemini");
});

Deno.test("fallback config: only when set, different and usable", () => {
  const env = envOf({});
  assertEquals(resolveFallbackConfig("openai", env, saved())?.provider, undefined);
  assertEquals(resolveFallbackConfig("openai", env, saved({ fallbackProvider: "openai" })), null);
  assertEquals(resolveFallbackConfig("openai", env, saved({ fallbackProvider: "gemini" }))?.apiKey, "db-gemini");
  assertEquals(resolveFallbackConfig("openai", env, saved({ fallbackProvider: "anthropic" })), null); // no key anywhere
});

// ---------------------------------------------------------------- decrypting saved rows

async function rowFor(provider: string, apiKey: string, secret = MASTER): Promise<CredentialRow> {
  return {
    provider, encrypted_key: await encryptSecret(apiKey, await importMasterKey(secret), provider),
    key_hint: keyHint(apiKey), default_model: null, base_url: null, updated_at: null,
  };
}

Deno.test("decryptPlatformAi: decrypts good rows, skips bad ones, survives a missing master key", async () => {
  const settings: PlatformSettingsRow = { default_provider: "openai", fallback_provider: "gemini" };
  const rows = [await rowFor("openai", "fake-openai-1234567"), await rowFor("gemini", "fake-gemini-gemini-1234", randomSecret())];
  const logs: string[] = [];
  const p = await decryptPlatformAi(settings, rows, MASTER, (m) => logs.push(m));
  assertEquals(p.credentials.openai?.apiKey, "fake-openai-1234567");
  assertEquals(p.credentials.gemini, undefined);
  assertEquals(p.defaultProvider, "openai");
  assertEquals(logs.length, 1);
  assert(!logs[0].includes("fake-gemini"), "log must not contain the key");

  const none = await decryptPlatformAi(settings, rows, undefined, () => {});
  assertEquals(none.credentials, {});
  assertEquals(none.fallbackProvider, "gemini");
});

// ---------------------------------------------------------------- chat with fallback

Deno.test("chat: uses the fallback provider when the main provider fails", async () => {
  const biz = makeBusiness();
  const { repo, s } = fakeRepo({ businesses: [biz] });
  const tried: string[] = [];
  const ai = async (cfg: ProviderConfig, _req: AiRequest): Promise<AiResult> => {
    tried.push(`${cfg.provider}:${cfg.apiKey}`);
    if (cfg.provider === "openai") throw new AiProviderError("AI provider returned HTTP 500");
    return { text: "Karibu!", provider: cfg.provider, model: cfg.model, inputTokens: 1, outputTokens: 1, refused: false };
  };
  const deps: Deps = {
    repo, env: envOf({}), ai,
    platformAi: async () => saved({ defaultProvider: "openai", fallbackProvider: "gemini" }),
  };
  const res = await chat(deps, { business_id: biz.id, visitor_id: "visitor_abcdefghijklmnop", message: "hi" }, null, "1.1.1.1");
  assertEquals(res.reply, "Karibu!");
  assertEquals(tried, ["openai:db-openai", "gemini:db-gemini"]);
  assertEquals(s.usage.map((u) => [u.provider, u.success]), [["openai", false], ["gemini", true]]);
});

// ---------------------------------------------------------------- admin key function

function memoryStore(admins: string[]) {
  const st = {
    settings: { default_provider: null, fallback_provider: null } as PlatformSettingsRow,
    rows: [] as (CredentialRow & { updated_by?: string })[],
  };
  const store: AdminAiStore = {
    isPlatformAdmin: async (u) => admins.includes(u),
    getSettings: async () => ({ ...st.settings }),
    listCredentials: async () => st.rows.map((r) => ({ ...r })),
    upsertCredential: async (row) => {
      st.rows = st.rows.filter((r) => r.provider !== row.provider);
      st.rows.push({ ...row, updated_at: "2026-11-22T10:00:00Z" });
    },
    updateCredentialMeta: async (p, patch) => {
      const r = st.rows.find((x) => x.provider === p);
      if (!r) return false;
      Object.assign(r, patch);
      return true;
    },
    deleteCredential: async (p) => { st.rows = st.rows.filter((r) => r.provider !== p); },
    saveSettings: async (patch) => { st.settings = { default_provider: patch.default_provider, fallback_provider: patch.fallback_provider }; },
  };
  return { store, st };
}

const ADMIN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const REAL_LOOKING_KEY = "fake-openai-key-for-tests-wxyz";

Deno.test("admin keys: only signed-in platform admins get in", async () => {
  const { store, st } = memoryStore([ADMIN]);
  const env = envOf({ FAIDAHQ_ENCRYPTION_KEY: MASTER });
  const e1 = await assertRejects(() => adminAiKeys({ store, env, userId: null }, { action: "list" }), HttpError);
  assertEquals(e1.status, 401);
  const e2 = await assertRejects(() => adminAiKeys({ store, env, userId: OTHER }, { action: "save", provider: "openai", api_key: REAL_LOOKING_KEY }), HttpError);
  assertEquals(e2.status, 403);
  assertEquals(st.rows.length, 0);
});

Deno.test("admin keys: saving encrypts the key and never returns it", async () => {
  const { store, st } = memoryStore([ADMIN]);
  const env = envOf({ FAIDAHQ_ENCRYPTION_KEY: MASTER, GEMINI_API_KEY: "env-g" });
  const deps = { store, env, userId: ADMIN };
  const res = await adminAiKeys(deps, { action: "save", provider: "openai", api_key: REAL_LOOKING_KEY, default_model: "gpt-5-mini" });

  assert(!JSON.stringify(res).includes(REAL_LOOKING_KEY), "key leaked in response");
  assert(!JSON.stringify(res).includes(st.rows[0].encrypted_key), "ciphertext leaked in response");
  assert(!st.rows[0].encrypted_key.includes(REAL_LOOKING_KEY), "key stored in plain text");
  assertEquals(await decryptSecret(st.rows[0].encrypted_key, await importMasterKey(MASTER), "openai"), REAL_LOOKING_KEY);

  const openai = (res as { providers: { provider: string; key_saved: boolean; key_hint: string | null }[] }).providers.find((p) => p.provider === "openai")!;
  assertEquals([openai.key_saved, openai.key_hint], [true, "…wxyz"]);
  const gemini = (res as { providers: { provider: string; env_configured: boolean }[] }).providers.find((p) => p.provider === "gemini")!;
  assertEquals(gemini.env_configured, true);

  // Editing the model without a new key keeps the saved key.
  const before = st.rows[0].encrypted_key;
  await adminAiKeys(deps, { action: "save", provider: "openai", default_model: "gpt-5" });
  assertEquals([st.rows[0].encrypted_key, st.rows[0].default_model], [before, "gpt-5"]);

  await adminAiKeys(deps, { action: "delete", provider: "openai" });
  assertEquals(st.rows.length, 0);
});

Deno.test("admin keys: input checks and missing master key", async () => {
  const { store } = memoryStore([ADMIN]);
  const deps = { store, env: envOf({ FAIDAHQ_ENCRYPTION_KEY: MASTER }), userId: ADMIN };
  await assertRejects(() => adminAiKeys(deps, { action: "save", provider: "mystery", api_key: REAL_LOOKING_KEY }), ValidationError);
  await assertRejects(() => adminAiKeys(deps, { action: "save", provider: "openai", api_key: "has spaces in it" }), ValidationError);
  await assertRejects(() => adminAiKeys(deps, { action: "save", provider: "openai" }), ValidationError, "Enter an API key");
  await assertRejects(() => adminAiKeys(deps, { action: "save", provider: "openai_compatible", api_key: REAL_LOOKING_KEY }), ValidationError, "base URL");
  await assertRejects(() => adminAiKeys(deps, { action: "save", provider: "openai_compatible", api_key: REAL_LOOKING_KEY, base_url: "http://insecure.example" }), ValidationError, "https");
  await assertRejects(() => adminAiKeys(deps, { action: "set_defaults", default_provider: "gemini", fallback_provider: "gemini" }), ValidationError);
  await assertRejects(() => adminAiKeys(deps, { action: "explode" }), ValidationError);

  const noKey = { store, env: envOf({}), userId: ADMIN };
  const err = await assertRejects(() => adminAiKeys(noKey, { action: "save", provider: "openai", api_key: REAL_LOOKING_KEY }), HttpError);
  assertEquals(err.status, 503);
  assertEquals((await adminAiKeys(noKey, { action: "list" }) as { encryption_ready: boolean }).encryption_ready, false);
});

Deno.test("admin keys: set defaults and test a provider with the saved key", async () => {
  const { store, st } = memoryStore([ADMIN]);
  const env = envOf({ FAIDAHQ_ENCRYPTION_KEY: MASTER });
  let used: ProviderConfig | null = null;
  const ai = async (cfg: ProviderConfig): Promise<AiResult> => {
    used = cfg;
    if (cfg.apiKey !== "fake-gemini-good-key-123") throw new AiProviderError("AI provider returned HTTP 401");
    return { text: "OK", provider: cfg.provider, model: cfg.model, inputTokens: 1, outputTokens: 1, refused: false };
  };
  const deps = { store, env, userId: ADMIN, ai };
  await adminAiKeys(deps, { action: "save", provider: "gemini", api_key: "fake-gemini-good-key-123", default_model: "gemini-2.5-flash" });
  await adminAiKeys(deps, { action: "set_defaults", default_provider: "gemini", fallback_provider: "" });
  assertEquals(st.settings, { default_provider: "gemini", fallback_provider: null });

  const ok = await adminAiKeys(deps, { action: "test", provider: "gemini" }) as { ok: boolean; message: string };
  assertEquals(ok.ok, true);
  assertEquals(used!.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");

  await adminAiKeys(deps, { action: "save", provider: "gemini", api_key: "fake-gemini-bad-key-456" });
  const bad = await adminAiKeys(deps, { action: "test", provider: "gemini" }) as { ok: boolean; message: string };
  assertEquals(bad.ok, false);
  assertStringIncludes(bad.message, "rejected");
  assert(!bad.message.includes("fake-gemini"));

  const missing = await adminAiKeys(deps, { action: "test", provider: "openai" }) as { ok: boolean; message: string };
  assertEquals(missing.ok, false);
});
