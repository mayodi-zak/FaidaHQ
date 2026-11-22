-- ============================================================================
-- Encrypted AI provider keys, managed from the FaidaHQ admin panel
-- ----------------------------------------------------------------------------
-- * API keys are encrypted by the `admin-ai-keys` Edge Function (AES-256-GCM)
--   with one master key (secret FAIDAHQ_ENCRYPTION_KEY) that never touches the
--   database or the browser. The database only ever holds ciphertext.
-- * No browser role can read or write these tables directly (RLS on, no
--   policies, privileges revoked). Only the Edge Functions (service role) can.
-- * Admins see safe metadata (last 4 characters, model, dates) through
--   admin_ai_overview(), never the key itself.
-- ============================================================================

create table public.ai_provider_credentials (
  provider       text primary key check (provider in ('anthropic', 'openai', 'gemini', 'openai_compatible')),
  encrypted_key  text not null check (encrypted_key like 'v1:%'),
  key_hint       text not null check (length(key_hint) <= 12),   -- e.g. "…a1B2"
  default_model  text check (default_model is null or length(default_model) <= 100),
  base_url       text check (base_url is null or base_url ~ '^https://'),
  updated_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Singleton row with platform-wide AI choices.
create table public.platform_ai_settings (
  id                int primary key default 1 check (id = 1),
  -- null = use the AI_PROVIDER function secret (or anthropic)
  default_provider  text check (default_provider is null or default_provider in ('anthropic', 'openai', 'gemini', 'openai_compatible')),
  fallback_provider text check (fallback_provider is null or fallback_provider in ('anthropic', 'openai', 'gemini', 'openai_compatible')),
  updated_by        uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now(),
  constraint fallback_differs check (fallback_provider is null or default_provider is null or fallback_provider <> default_provider)
);
insert into public.platform_ai_settings (id) values (1);

create trigger ai_provider_credentials_touch before update on public.ai_provider_credentials
  for each row execute function public.touch_updated_at();
create trigger platform_ai_settings_touch before update on public.platform_ai_settings
  for each row execute function public.touch_updated_at();

alter table public.ai_provider_credentials enable row level security;
alter table public.platform_ai_settings   enable row level security;
-- No policies on purpose: only the service role (Edge Functions) gets through.
revoke all on public.ai_provider_credentials from anon, authenticated;
revoke all on public.platform_ai_settings   from anon, authenticated;

-- Businesses can now pick Gemini too.
alter table public.ai_settings drop constraint if exists ai_settings_provider_check;
alter table public.ai_settings add constraint ai_settings_provider_check
  check (provider in ('default', 'anthropic', 'openai', 'gemini', 'openai_compatible'));

-- Safe overview for the admin panel: never returns the key or ciphertext.
create or replace function public.admin_ai_overview()
returns table (
  provider text, key_hint text, default_model text, base_url text, updated_at timestamptz,
  is_default boolean, is_fallback boolean
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admins only';
  end if;
  return query
  select p.provider, c.key_hint, c.default_model, c.base_url, c.updated_at,
         coalesce(p.provider = s.default_provider, false), coalesce(p.provider = s.fallback_provider, false)
  from (values ('anthropic'), ('openai'), ('gemini'), ('openai_compatible')) as p(provider)
  cross join public.platform_ai_settings s
  left join public.ai_provider_credentials c on c.provider = p.provider;
end;
$$;
revoke execute on function public.admin_ai_overview() from public, anon;
grant execute on function public.admin_ai_overview() to authenticated;
