// Provider-independent AI client. Runs ONLY on the server (Edge Functions);
// API keys come from Supabase function secrets and never reach a browser.
//
// Supported providers:
//   anthropic          — Claude Messages API
//   openai             — OpenAI Chat Completions API
//   openai_compatible  — any service with an OpenAI-style /chat/completions
//                        endpoint (OpenRouter, Groq, Together, a local server…)

export type ProviderName = "anthropic" | "openai" | "openai_compatible";

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

/**
 * Work out which provider/model/key to use.
 * Business setting wins over the platform default (AI_PROVIDER / AI_MODEL).
 */
export function resolveProviderConfig(
  business: { provider?: string | null; model?: string | null },
  env: Env,
): ProviderConfig {
  const requested = business.provider && business.provider !== "default" ? business.provider : env("AI_PROVIDER");
  const provider = (requested || "anthropic").trim() as ProviderName;
  if (!["anthropic", "openai", "openai_compatible"].includes(provider)) {
    throw new AiConfigError(`Unknown AI provider "${provider}"`);
  }

  const platformModel = env("AI_PROVIDER") === provider ? env("AI_MODEL") : undefined;
  const model = (business.model || platformModel || DEFAULT_MODELS[provider] || "").trim();
  if (!model) throw new AiConfigError(`Set AI_MODEL (or a model in the business AI settings) for provider "${provider}"`);

  const keyName = provider === "anthropic"
    ? "ANTHROPIC_API_KEY"
    : provider === "openai"
    ? "OPENAI_API_KEY"
    : "OPENAI_COMPATIBLE_API_KEY";
  const apiKey = env(keyName) || "";
  if (!apiKey) throw new AiConfigError(`Missing secret ${keyName}`);

  const baseUrl = provider === "anthropic"
    ? (env("ANTHROPIC_BASE_URL") || "https://api.anthropic.com")
    : provider === "openai"
    ? (env("OPENAI_BASE_URL") || "https://api.openai.com/v1")
    : (env("OPENAI_COMPATIBLE_BASE_URL") || "");
  if (!baseUrl) throw new AiConfigError("Missing OPENAI_COMPATIBLE_BASE_URL");

  const timeoutMs = Number(env("AI_TIMEOUT_MS") || 30000);
  return { provider, model, apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), timeoutMs };
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
