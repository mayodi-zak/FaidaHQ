// POST /chat {business_id, visitor_id, conversation_id?, message, page_url?}
import { clientIp, corsHeaders, errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { chat } from "../_shared/handlers.ts";
import { requestDeps } from "../_shared/runtime.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  try {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const body = await readJson(req);
    return json(await chat(await requestDeps(req), body, origin, clientIp(req)), 200, origin);
  } catch (err) {
    return errorResponse(err, origin);
  }
});
