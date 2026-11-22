// Wiring for the deployed Edge Functions: service-role client + env access.
// The service role key is injected by Supabase at runtime (never in the browser).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { supabaseRepo } from "./repo.ts";
import type { Deps } from "./handlers.ts";
import type { PlatformAi, ProviderName } from "./ai.ts";
import { type CredentialRow, decryptPlatformAi, MASTER_KEY_ENV, type PlatformSettingsRow } from "./platform_ai.ts";
import type { AdminAiStore } from "./admin_ai.ts";
import type { LearnStore } from "./learn.ts";

let client: SupabaseClient | null = null;
let cached: Deps | null = null;

export function serviceClient(): SupabaseClient {
  if (client) return client;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const CRED_FIELDS = "provider, encrypted_key, key_hint, default_model, base_url, updated_at";

async function loadSettings(db: SupabaseClient): Promise<PlatformSettingsRow> {
  const { data, error } = await db.from("platform_ai_settings").select("default_provider, fallback_provider").eq("id", 1).maybeSingle();
  if (error) throw new Error(`platform_ai_settings: ${error.message}`);
  return data ?? { default_provider: null, fallback_provider: null };
}

async function loadCredentials(db: SupabaseClient): Promise<CredentialRow[]> {
  const { data, error } = await db.from("ai_provider_credentials").select(CRED_FIELDS);
  if (error) throw new Error(`ai_provider_credentials: ${error.message}`);
  return data ?? [];
}

// Decrypted keys are kept in memory for one minute, so a change in the admin
// panel takes effect within a minute without a database read on every message.
const PLATFORM_TTL_MS = 60_000;
let platformCache: { at: number; value: PlatformAi } | null = null;

async function platformAi(): Promise<PlatformAi> {
  if (platformCache && Date.now() - platformCache.at < PLATFORM_TTL_MS) return platformCache.value;
  let value: PlatformAi = { credentials: {} };
  try {
    const db = serviceClient();
    const [settings, rows] = await Promise.all([loadSettings(db), loadCredentials(db)]);
    value = await decryptPlatformAi(settings, rows, Deno.env.get(MASTER_KEY_ENV));
  } catch (err) {
    // Database trouble must not stop the chat: fall back to function secrets.
    console.error("Could not load saved AI settings:", (err as Error).message);
  }
  platformCache = { at: Date.now(), value };
  return value;
}

export function runtimeDeps(): Deps {
  if (cached) return cached;
  cached = { repo: supabaseRepo(serviceClient()), env: (n) => Deno.env.get(n), platformAi };
  return cached;
}

export function adminAiStore(db: SupabaseClient = serviceClient()): AdminAiStore {
  return {
    async isPlatformAdmin(userId) {
      const { data, error } = await db.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(`platform_admins: ${error.message}`);
      return Boolean(data);
    },
    getSettings: () => loadSettings(db),
    listCredentials: () => loadCredentials(db),
    async upsertCredential(row) {
      const { error } = await db.from("ai_provider_credentials").upsert(row, { onConflict: "provider" });
      if (error) throw new Error(`save key: ${error.message}`);
      platformCache = null;
    },
    async updateCredentialMeta(provider: ProviderName, patch) {
      const { data, error } = await db.from("ai_provider_credentials").update(patch).eq("provider", provider).select("provider");
      if (error) throw new Error(`update key: ${error.message}`);
      platformCache = null;
      return (data ?? []).length > 0;
    },
    async deleteCredential(provider) {
      const { error } = await db.from("ai_provider_credentials").delete().eq("provider", provider);
      if (error) throw new Error(`delete key: ${error.message}`);
      platformCache = null;
    },
    async saveSettings(patch) {
      const { error } = await db.from("platform_ai_settings").update(patch).eq("id", 1);
      if (error) throw new Error(`save settings: ${error.message}`);
      platformCache = null;
    },
  };
}

/** The signed-in user from the request's Authorization header, checked by Supabase Auth. */
export async function userIdFromRequest(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

export function learnStore(db: SupabaseClient = serviceClient()): LearnStore {
  const must = <T>(res: { data: T; error: { message: string } | null }, what: string): T => {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    return res.data;
  };
  return {
    async canManage(userId, businessId) {
      const m = must(await db.from("business_members").select("role").eq("business_id", businessId).eq("user_id", userId).maybeSingle(), "membership") as { role: string } | null;
      if (m && (m.role === "owner" || m.role === "admin")) return true;
      return await adminAiStore(db).isPlatformAdmin(userId);
    },
    async candidates(businessId, sinceIso, limit) {
      return must(
        await db.from("conversations").select("id, escalation_reason")
          .eq("business_id", businessId).eq("status", "escalated").is("learned_at", null)
          .gte("last_message_at", sinceIso).order("last_message_at", { ascending: false }).limit(limit),
        "candidates",
      ) as { id: string; escalation_reason: string | null }[];
    },
    async messages(conversationId, businessId) {
      return must(
        await db.from("messages").select("role, content, created_at")
          .eq("conversation_id", conversationId).eq("business_id", businessId)
          .order("created_at").limit(40),
        "messages",
      ) as { role: "user" | "assistant" | "staff" | "system"; content: string; created_at: string }[];
    },
    async insertSuggestions(rows) {
      must(await db.from("knowledge_suggestions").insert(rows), "save suggestions");
    },
    async markLearned(businessId, ids, atIso) {
      must(await db.from("conversations").update({ learned_at: atIso }).eq("business_id", businessId).in("id", ids), "mark learned");
    },
    async businessesWithCandidates(sinceIso) {
      const rows = must(
        await db.from("conversations").select("business_id, businesses!inner(status)")
          .eq("status", "escalated").is("learned_at", null).gte("last_message_at", sinceIso)
          .eq("businesses.status", "active").limit(1000),
        "businesses to learn from",
      ) as { business_id: string }[];
      return [...new Set(rows.map((r) => r.business_id))];
    },
  };
}
