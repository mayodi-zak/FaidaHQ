// POST /learn {business_id}   -> owner/admin of that business (signed in)
// POST /learn {all: true}     -> scheduled run, needs header x-cron-secret
import { corsHeaders, errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { learn } from "../_shared/learn.ts";
import { learnStore, runtimeDeps, userIdFromRequest } from "../_shared/runtime.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  try {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const body = await readJson(req, 2_000);
    const base = runtimeDeps();
    const result = await learn({
      ...base,
      store: learnStore(),
      userId: body.all === true ? null : await userIdFromRequest(req),
      cronSecret: req.headers.get("x-cron-secret"),
    }, body);
    return json(result, 200, origin, { "cache-control": "no-store" });
  } catch (err) {
    return errorResponse(err, origin);
  }
});
