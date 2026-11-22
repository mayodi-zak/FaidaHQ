// POST /contact {name, email, subject, message, website?}  (public: website visitors)
import { clientIp, corsHeaders, errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { submitContact } from "../_shared/contact.ts";
import { serviceClient } from "../_shared/runtime.ts";
import { supabaseRepo } from "../_shared/repo.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  try {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const body = await readJson(req, 10_000);
    const db = serviceClient();
    const repo = supabaseRepo(db);
    const result = await submitContact({
      env: (n) => Deno.env.get(n),
      rateLimit: repo.rateLimit,
      async insert(row) {
        const { data, error } = await db.from("contact_messages").insert(row).select("id").single();
        if (error) throw new Error(`save contact: ${error.message}`);
        return (data as { id: string }).id;
      },
      async markNotified(id) {
        await db.from("contact_messages").update({ notified: true }).eq("id", id);
      },
    }, body, clientIp(req));
    return json(result, 200, origin);
  } catch (err) {
    return errorResponse(err, origin);
  }
});
