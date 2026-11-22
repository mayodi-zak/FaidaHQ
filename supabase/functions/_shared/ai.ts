// Provider-independent AI client. Runs ONLY on the server (Edge Functions);
// API keys come from Supabase function secrets and never reach a browser.
//
// Supported providers:
//   anthropic          — Claude Messages API
//   openai             — OpenAI Chat Completions API
//   gemini             — Google Gemini (through its OpenAI-compatible endpoint)
//   openai_compatible  — any service with an OpenAI-style /chat/completions
//                        endpoint (OpenRouter, Groq, Together, a local server…)

export type ProviderName = "anthropic" | "openai" | "gemini" | "openai_compatible";
export const PROVIDERS: ProviderName[] = ["anthropic", "openai", "gemini", "openai_compatible"];

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  system: string;
  messages: ChatTurn[];
  maxOutputTokens: number;
  temperature: number;
}

export interface AiResult {
  text: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  refused: boolean;
}

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

export class AiProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "AiProviderError";
    this.status = status;
  }
}

type Env = (name: string) => string | undefined;

const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: "claude-opus-5-5",
};

export const ENV_KEYS: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openai_compatible: "OPENAI_COMPATIBLE_API_KEY",
};

const DEFAULT_BASE_URLS: Partial<Record<ProviderName, string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/** A key saved (encrypted) from the admin panel, already decrypted on the server. */
export interface StoredCredential {
  apiKey: string;
  defaultModel?: string | null;
  baseUrl?: string | null;
}

/** Platform-wide AI choices saved from the admin panel. */
export interface PlatformAi {
  defaultProvider?: string | null;
  fallbackProvider?: string | null;
  credentials: Partial<Record<ProviderName, StoredCredential>>;
}

const EMPTY_PLATFORM: PlatformAi = { credentials: {} };

function asProvider(p: string | null | undefined): ProviderName {
  const provider = (p || "").trim() as ProviderName;
  if (!PROVIDERS.includes(provider)) throw new AiConfigError(`Unknown AI provider "${p}"`);
  return provider;
}

function buildConfig(provider: ProviderName, modelOverride: string | null | undefined, env: Env, platform: PlatformAi): ProviderConfig {
  const stored = platform.credentials[provider];
  const envModel = env("AI_PROVIDER") === provider ? env("AI_MODEL") : undefined;
  const model = (modelOverride || stored?.defaultModel || envModel || DEFAULT_MODELS[provider] || "").trim();
  if (!model) throw new AiConfigError(`Choose a model for provider "${provider}" in the admin panel (or set AI_MODEL)`);

  // Key saved in the admin panel wins; the function secret is the fallback.
  const apiKey = stored?.apiKey || env(ENV_KEYS[provider]) || "";
  if (!apiKey) throw new AiConfigError(`No API key for "${provider}". Add one in the admin panel (or set ${ENV_KEYS[provider]})`);

  const envBase = provider === "anthropic" ? env("ANTHROPIC_BASE_URL")
    : provider === "openai" ? env("OPENAI_BASE_URL")
    : provider === "openai_compatible" ? env("OPENAI_COMPATIBLE_BASE_URL")
    : undefined;
  const baseUrl = stored?.baseUrl || envBase || DEFAULT_BASE_URLS[provider] || "";
  if (!baseUrl) throw new AiConfigError(`Set a base URL for "${provider}" in the admin panel (or OPENAI_COMPATIBLE_BASE_URL)`);

  const timeoutMs = Number(env("AI_TIMEOUT_MS") || 30000);
  return { provider, model, apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), timeoutMs };
}

/**
 * Work out which provider/model/key to use. Order of preference:
 *   provider: business setting → admin-panel default → AI_PROVIDER secret → anthropic
 *   model:    business setting → admin-panel default model → AI_MODEL → built-in default
 *   key:      admin-panel (encrypted in DB) → function secret
 */
export function resolveProviderConfig(
  business: { provider?: string | null; model?: string | null },
  env: Env,
  platform: PlatformAi = EMPTY_PLATFORM,
): ProviderConfig {
  const fromBusiness = business.provider && business.provider !== "default" ? business.provider : null;
  const provider = asProvider(fromBusiness || platform.defaultProvider || env("AI_PROVIDER") || "anthropic");
  return buildConfig(provider, business.model, env, platform);
}

/** The platform's fallback provider, if one is set, usable, and different from `primary`. */
export function resolveFallbackConfig(primary: ProviderName | null, env: Env, platform: PlatformAi = EMPTY_PLATFORM): ProviderConfig | null {
  if (!platform.fallbackProvider || platform.fallbackProvider === primary) return null;
  try {
    return buildConfig(asProvider(platform.fallbackProvider), null, env, platform);
  } catch {
    return null; // a misconfigured fallback must never break the main path
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    throw new AiProviderError(aborted ? "AI provider timed out" : "Could not reach AI provider", 504);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch { /* non-JSON error body */ }
  if (!res.ok) {
    // Never echo provider error bodies to the browser; log a short summary only.
    const errObj = json.error as { message?: string } | undefined;
    console.error(`AI provider HTTP ${res.status}: ${(errObj?.message || raw).slice(0, 300)}`);
    throw new AiProviderError(`AI provider returned HTTP ${res.status}`, res.status === 429 ? 429 : 502);
  }
  return json;
}

async function callAnthropic(cfg: ProviderConfig, req: AiRequest, fetchImpl: typeof fetch): Promise<AiResult> {
  // Current Claude models think adaptively; "low" effort keeps chat replies fast
  // and cheap. max_tokens leaves room for that thinking plus the visible reply.
  const body = {
    model: cfg.model,
    max_tokens: req.maxOutputTokens + 2000,
    system: req.system,
    messages: req.messages,
    output_config: { effort: "low" },
    // Server-side fallback: if a safety classifier declines, retry on a
    // suitable model instead of failing the guest's message.
    fallbacks: "default",
  };
  const json = await postJson(
    `${cfg.baseUrl}/v1/messages`,
    {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body,
    cfg.timeoutMs,
    fetchImpl,
  );
  const content = Array.isArray(json.content) ? json.content as Array<{ type: string; text?: string }> : [];
  const text = content.filter((b) => b.type === "text").map((b) => b.text || "").join("").trim();
  const usage = (json.usage || {}) as { input_tokens?: number; output_tokens?: number };
  return {
    text,
    provider: "anthropic",
    model: String(json.model || cfg.model),
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    refused: json.stop_reason === "refusal",
  };
}

async function callOpenAiStyle(cfg: ProviderConfig, req: AiRequest, fetchImpl: typeof fetch): Promise<AiResult> {
  const body = {
    model: cfg.model,
    max_tokens: req.maxOutputTokens,
    temperature: req.temperature,
    messages: [{ role: "system", content: req.system }, ...req.messages],
  };
  const json = await postJson(
    `${cfg.baseUrl}/chat/completions`,
    { authorization: `Bearer ${cfg.apiKey}` },
    body,
    cfg.timeoutMs,
    fetchImpl,
  );
  const choices = (json.choices || []) as Array<{ message?: { content?: string }; finish_reason?: string }>;
  const usage = (json.usage || {}) as { prompt_tokens?: number; completion_tokens?: number };
  return {
    text: (choices[0]?.message?.content || "").trim(),
    provider: cfg.provider,
    model: String(json.model || cfg.model),
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    refused: choices[0]?.finish_reason === "content_filter",
  };
}

export function generateReply(cfg: ProviderConfig, req: AiRequest, fetchImpl: typeof fetch = fetch): Promise<AiResult> {
  return cfg.provider === "anthropic" ? callAnthropic(cfg, req, fetchImpl) : callOpenAiStyle(cfg, req, fetchImpl);
}
