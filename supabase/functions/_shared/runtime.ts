// Wiring for the deployed Edge Functions: service-role client + env access.
// The service role key is injected by Supabase at runtime (never in the browser).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { supabaseRepo } from "./repo.ts";
import type { Deps } from "./handlers.ts";

let cached: Deps | null = null;

export function runtimeDeps(): Deps {
  if (cached) return cached;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  cached = { repo: supabaseRepo(db), env: (n) => Deno.env.get(n) };
  return cached;
}
