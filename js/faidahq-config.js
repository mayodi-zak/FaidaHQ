// FaidaHQ public front-end configuration.
// ---------------------------------------------------------------------------
// These values are PUBLIC by design (the Supabase "anon" key is meant to be in
// browsers; Row Level Security protects the data). NEVER put the service-role
// key or any AI provider key in this file.
//
// Fill these in after creating your Supabase project (see docs/SETUP.md):
//   supabaseUrl     → Project Settings › API › Project URL
//   supabaseAnonKey → Project Settings › API › anon public key
//   functionsUrl    → `${supabaseUrl}/functions/v1`
//
// While they are empty, the demo website runs the chat widget in offline demo
// mode, and the dashboards show setup instructions.
window.FaidaHQConfig = {
  supabaseUrl: "https://odcsufhzdxxttfuhctjs.supabase.co",
  supabaseAnonKey: "sb_publishable_OWbxQb7jzn_aMc6t_4DmPg_rrz7pA2G",
  functionsUrl: "https://odcsufhzdxxttfuhctjs.supabase.co/functions/v1",
  // The demo business created by supabase/migrations/20261122135608_seed.sql
  demoBusinessId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
};
