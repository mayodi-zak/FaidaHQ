// GET  /widget?business_id=...   -> public widget configuration (name, branding)
// POST /widget {action:"history", business_id, visitor_id, conversation_id}
import { clientIp, errorResponse, HttpError, json, readJson, corsHeaders } from "../_shared/http.ts";
import { conversationHistory, widgetConfig } from "../_shared/handlers.ts";
import { requestDeps } from "../_shared/runtime.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  try {
    const deps = await requestDeps(req);
    if (req.method === "GET") {
      const url = new URL(req.url);
      const ok = await deps.repo.rateLimit(`cfg:ip:${clientIp(req)}`, 120, 60);
      if (!ok) throw new HttpError(429, "rate_limited", "Too many requests");
      const data = await widgetConfig(deps, { business_id: url.searchParams.get("business_id") }, origin);
      return json(data, 200, origin, { "cache-control": req.headers.get("authorization") ? "private, no-store" : "public, max-age=60" });
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (body.action !== "history") throw new HttpError(400, "bad_action", "Unknown action");
      const ok = await deps.repo.rateLimit(`hist:ip:${clientIp(req)}`, 60, 60);
      if (!ok) throw new HttpError(429, "rate_limited", "Too many requests");
      return json(await conversationHistory(deps, body, origin), 200, origin);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  } catch (err) {
    return errorResponse(err, origin);
  }
});
