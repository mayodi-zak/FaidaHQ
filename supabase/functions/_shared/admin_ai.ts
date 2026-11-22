// Logic for the `admin-ai-keys` Edge Function: platform admins add, replace,
// delete and test AI provider keys. Keys are encrypted here before they reach
// the database, and are never sent back to the browser (only "…abcd" hints).
import { HttpError } from "./http.ts";
import { ValidationError } from "./validate.ts";
import {
  AiConfigError, AiProviderError, type AiRequest, type AiResult, ENV_KEYS, generateReply, PROVIDERS,
  type ProviderConfig, type ProviderName, resolveProviderConfig,
} from "./ai.ts";
import { CryptoConfigError, encryptSecret, importMasterKey, keyHint } from "./crypto.ts";
import { type CredentialRow, decryptPlatformAi, MASTER_KEY_ENV, type PlatformSettingsRow } from "./platform_ai.ts";

export interface AdminAiStore {
  isPlatformAdmin(userId: string): Promise<boolean>;
  getSettings(): Promise<PlatformSettingsRow>;
  listCredentials(): Promise<CredentialRow[]>;
  upsertCredential(row: {
    provider: ProviderName; encrypted_key: string; key_hint: string;
    default_model: string | null; base_url: string | null; updated_by: string;
  }): Promise<void>;
  /** Update model/base URL of an existing row. Returns false if there is no row. */
  updateCredentialMeta(provider: ProviderName, patch: { default_model: string | null; base_url: string | null; updated_by: string }): Promise<boolean>;
  deleteCredential(provider: ProviderName): Promise<void>;
  saveSettings(patch: { default_provider: ProviderName | null; fallback_provider: ProviderName | null; updated_by: string }): Promise<void>;
}

export interface AdminAiDeps {
  store: AdminAiStore;
  env: (name: string) => string | undefined;
  /** Id of the signed-in user (from their verified JWT), or null. */
  userId: string | null;
  ai?: (cfg: ProviderConfig, req: AiRequest) => Promise<AiResult>;
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  openai_compatible: "OpenAI-compatible (OpenRouter, Groq…)",
};

const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,100}$/;
const KEY_RE = /^[\x21-\x7e]{8,500}$/; // printable ASCII, no spaces

function provider(v: unknown, field = "provider"): ProviderName {
  if (typeof v !== "string" || !PROVIDERS.includes(v as ProviderName)) throw new ValidationError(`${field} is not a known provider`);
  return v as ProviderName;
}

function optionalProvider(v: unknown, field: string): ProviderName | null {
  return v === null || v === undefined || v === "" ? null : provider(v, field);
}

function optionalModel(v: unknown): string | null {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
  if (typeof v !== "string" || !MODEL_RE.test(v.trim())) throw new ValidationError("Model name has invalid characters");
  return v.trim();
}

function optionalBaseUrl(v: unknown): string | null {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
  if (typeof v !== "string" || v.length > 300) throw new ValidationError("Base URL is too long");
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    throw new ValidationError("Base URL is not a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new ValidationError("Base URL must start with https://");
  return url.toString().replace(/\/+$/, "");
}

async function masterKey(env: AdminAiDeps["env"]): Promise<CryptoKey> {
  try {
    return await importMasterKey(env(MASTER_KEY_ENV));
  } catch (err) {
    if (err instanceof CryptoConfigError) throw new HttpError(503, "encryption_not_ready", err.message);
    throw err;
  }
}

async function overview(deps: AdminAiDeps) {
  const [settings, rows] = await Promise.all([deps.store.getSettings(), deps.store.listCredentials()]);
  let encryptionReady = true;
  try {
    await importMasterKey(deps.env(MASTER_KEY_ENV));
  } catch {
    encryptionReady = false;
  }
  return {
    encryption_ready: encryptionReady,
    default_provider: settings.default_provider,
    fallback_provider: settings.fallback_provider,
    env_default_provider: deps.env("AI_PROVIDER") || null,
    providers: PROVIDERS.map((p) => {
      const row = rows.find((r) => r.provider === p);
      // Only safe metadata leaves the server. Never row.encrypted_key.
      return {
        provider: p,
        label: PROVIDER_LABELS[p],
        key_saved: Boolean(row),
        key_hint: row?.key_hint ?? null,
        default_model: row?.default_model ?? null,
        base_url: row?.base_url ?? null,
        updated_at: row?.updated_at ?? null,
        env_key_name: ENV_KEYS[p],
        env_configured: Boolean(deps.env(ENV_KEYS[p])),
      };
    }),
  };
}

export async function adminAiKeys(deps: AdminAiDeps, body: Record<string, unknown>) {
  if (!deps.userId) throw new HttpError(401, "not_signed_in", "Please sign in again.");
  if (!(await deps.store.isPlatformAdmin(deps.userId))) throw new HttpError(403, "forbidden", "Only FaidaHQ platform admins can manage AI keys.");
  const userId = deps.userId;

  switch (body.action) {
    case "list":
      return overview(deps);

    case "save": {
      const p = provider(body.provider);
      // A field left out keeps its saved value; an empty string clears it.
      const existing = (await deps.store.listCredentials()).find((r) => r.provider === p);
      const model = body.default_model === undefined ? existing?.default_model ?? null : optionalModel(body.default_model);
      const baseUrl = body.base_url === undefined ? existing?.base_url ?? null : optionalBaseUrl(body.base_url);
      const rawKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
      if (p === "openai_compatible" && !baseUrl && !deps.env("OPENAI_COMPATIBLE_BASE_URL")) {
        throw new ValidationError("An OpenAI-compatible provider needs a base URL, e.g. https://openrouter.ai/api/v1");
      }
      if (rawKey) {
        if (!KEY_RE.test(rawKey)) throw new ValidationError("That API key does not look right (8 to 500 characters, no spaces)");
        const key = await masterKey(deps.env);
        await deps.store.upsertCredential({
          provider: p,
          encrypted_key: await encryptSecret(rawKey, key, p),
          key_hint: keyHint(rawKey),
          default_model: model,
          base_url: baseUrl,
          updated_by: userId,
        });
      } else {
        const updated = await deps.store.updateCredentialMeta(p, { default_model: model, base_url: baseUrl, updated_by: userId });
        if (!updated) throw new ValidationError("Enter an API key");
      }
      return overview(deps);
    }

    case "delete":
      await deps.store.deleteCredential(provider(body.provider));
      return overview(deps);

    case "set_defaults": {
      const def = optionalProvider(body.default_provider, "default_provider");
      const fb = optionalProvider(body.fallback_provider, "fallback_provider");
      if (def && fb && def === fb) throw new ValidationError("The fallback provider must be different from the main one");
      await deps.store.saveSettings({ default_provider: def, fallback_provider: fb, updated_by: userId });
      return overview(deps);
    }

    case "test": {
      const p = provider(body.provider);
      const [settings, rows] = await Promise.all([deps.store.getSettings(), deps.store.listCredentials()]);
      const platform = await decryptPlatformAi(settings, rows, deps.env(MASTER_KEY_ENV), () => {});
      try {
        const cfg = resolveProviderConfig({ provider: p }, deps.env, platform);
        const call = deps.ai ?? generateReply;
        const res = await call(cfg, {
          system: "You are a connection test. Reply with the single word OK.",
          messages: [{ role: "user", content: "Say OK" }],
          maxOutputTokens: 16,
          temperature: 0,
        });
        return { ok: true, provider: p, model: res.model, message: `Working. ${PROVIDER_LABELS[p]} answered using ${res.model}.` };
      } catch (err) {
        if (err instanceof AiConfigError) return { ok: false, provider: p, message: err.message };
        if (err instanceof AiProviderError) {
          const hint = err.message.includes("401") || err.message.includes("403")
            ? "The key was rejected. Check it and save it again."
            : err.message.includes("404") ? "The model was not found. Check the model name."
            : err.message;
          return { ok: false, provider: p, message: hint };
        }
        throw err;
      }
    }

    default:
      throw new ValidationError("Unknown action");
  }
}
