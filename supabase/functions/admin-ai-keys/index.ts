// POST /admin-ai-keys {action: "list" | "save" | "delete" | "set_defaults" | "test", ...}
// Platform admins only. The caller is identified from their own login token
// and checked against platform_admins on the server. API keys are encrypted
// here (FAIDAHQ_ENCRYPTION_KEY) and never returned to the browser.
import { corsHeaders, errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { adminAiKeys } from "../_shared/admin_ai.ts";
import { adminAiStore, userIdFromRequest } from "../_shared/runtime.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  try {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const body = await readJson(req, 5_000);
    const userId = await userIdFromRequest(req);
    const result = await adminAiKeys({ store: adminAiStore(), env: (n) => Deno.env.get(n), userId }, body);
    return json(result, 200, origin, { "cache-control": "no-store" });
  } catch (err) {
    return errorResponse(err, origin);
  }
});
