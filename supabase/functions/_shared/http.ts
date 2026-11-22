// HTTP helpers: CORS, JSON responses, client IP, safe error mapping.
import { ValidationError } from "./validate.ts";
import { AiConfigError, AiProviderError } from "./ai.ts";

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

export function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(origin), ...extra },
  });
}

/**
 * An empty allow-list means "any website may embed the widget".
 * Otherwise the request Origin must match one of the listed origins.
 * Requests without an Origin header (server-to-server, curl) are allowed;
 * the widget always runs in a browser, which always sends one.
 */
export function originAllowed(origin: string | null, allowed: string[] | null | undefined): boolean {
  if (!allowed || allowed.length === 0 || !origin) return true;
  const norm = (s: string) => s.trim().replace(/\/+$/, "").toLowerCase();
  return allowed.map(norm).includes(norm(origin));
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

export async function readJson(req: Request, maxBytes = 20_000): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > maxBytes) throw new HttpError(413, "too_large", "Request is too large");
  try {
    const data = JSON.parse(raw || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "bad_json", "Request body must be a JSON object");
  }
}

/** Convert any thrown error into a safe JSON response (no internals leaked). */
export function errorResponse(err: unknown, origin: string | null): Response {
  if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status, origin);
  if (err instanceof ValidationError) return json({ error: "invalid_input", message: err.message }, 400, origin);
  if (err instanceof AiConfigError) {
    console.error("AI configuration error:", err.message);
    return json({ error: "ai_not_configured", message: "The assistant is not available right now." }, 503, origin);
  }
  if (err instanceof AiProviderError) {
    return json({ error: "ai_unavailable", message: "The assistant is busy right now. Please try again shortly." }, err.status === 429 ? 503 : 502, origin);
  }
  console.error("Unexpected error:", err);
  return json({ error: "server_error", message: "Something went wrong. Please try again." }, 500, origin);
}
