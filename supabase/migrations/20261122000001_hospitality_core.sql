-- ============================================================================
-- FaidaHQ Hospitality Assistant — core schema
-- ----------------------------------------------------------------------------
-- Multi-business (multi-tenant) design:
--   * Every business-owned row carries business_id.
--   * Row Level Security (RLS) lets a signed-in user touch only the rows of
--     businesses they are a member of. Platform admins can see everything.
--   * Website visitors (the chat widget) NEVER talk to these tables directly.
--     They go through Edge Functions, which use the service role on the server
--     and scope every query to one business.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.business_type      as enum ('hotel', 'restaurant', 'hotel_restaurant', 'cafe');
create type public.business_status    as enum ('pending', 'active', 'suspended');
create type public.member_role        as enum ('owner', 'admin', 'staff');
create type public.knowledge_category as enum (
  'room', 'facility', 'menu_item', 'service', 'faq', 'policy', 'offer', 'hours', 'other'
);
create type public.conversation_status as enum ('open', 'escalated', 'closed');
create type public.message_role        as enum ('user', 'assistant', 'staff', 'system');
create type public.reservation_kind    as enum ('hotel', 'restaurant');
create type public.reservation_status  as enum ('pending', 'confirmed', 'declined', 'cancelled');
create type public.enquiry_status      as enum ('new', 'in_progress', 'resolved');
create type public.subscription_status as enum ('trial', 'active', 'past_due', 'cancelled');

-- ---------------------------------------------------------------------------
-- Plans (prepared for billing; no payment processing yet)
-- ---------------------------------------------------------------------------
create table public.plans (
  code                  text primary key,
  name                  text not null,
  setup_fee             numeric(12,2) not null default 0,
  monthly_price         numeric(12,2) not null default 0,
  currency              text not null default 'KES',
  monthly_message_limit integer not null default 1000 check (monthly_message_limit >= 0),
  created_at            timestamptz not null default now()
);

insert into public.plans (code, name, setup_fee, monthly_price, currency, monthly_message_limit) values
  ('starter',  'Starter',  15000, 5000,  'KES', 1000),
  ('growth',   'Growth',   25000, 12000, 'KES', 5000),
  ('premium',  'Premium',  50000, 25000, 'KES', 20000);

-- ---------------------------------------------------------------------------
-- Businesses
-- ---------------------------------------------------------------------------
create table public.businesses (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  name                  text not null check (length(name) between 2 and 120),
  type                  public.business_type not null default 'hotel',
  description           text not null default '' check (length(description) <= 5000),
  email                 text check (email is null or length(email) <= 200),
  phone                 text check (phone is null or length(phone) <= 40),
  whatsapp              text check (whatsapp is null or length(whatsapp) <= 40),
  website               text check (website is null or length(website) <= 300),
  address               text check (address is null or length(address) <= 300),
  city                  text check (city is null or length(city) <= 100),
  country               text not null default 'Kenya',
  timezone              text not null default 'Africa/Nairobi',
  currency              text not null default 'KES' check (length(currency) = 3),
  -- Widget branding: assistant_name, primary_color, accent_color, logo_url, welcome_message
  branding              jsonb not null default '{}'::jsonb,
  -- Websites allowed to embed the widget (empty = any). e.g. {https://myhotel.co.ke}
  allowed_origins       text[] not null default '{}',
  status                public.business_status not null default 'active',
  plan_code             text not null default 'starter' references public.plans(code),
  subscription_status   public.subscription_status not null default 'trial',
  setup_fee_paid        boolean not null default false,
  current_period_end    timestamptz,
  monthly_message_limit integer check (monthly_message_limit is null or monthly_message_limit >= 0), -- override of plan limit
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.member_role not null default 'staff',
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_members_user_idx on public.business_members(user_id);

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Knowledge base: one flexible table for rooms, menu, services, FAQs, etc.
-- ---------------------------------------------------------------------------
create table public.knowledge_items (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  category    public.knowledge_category not null,
  title       text not null check (length(title) between 1 and 200),
  content     text not null default '' check (length(content) <= 4000),
  price       numeric(12,2) check (price is null or price >= 0),
  price_unit  text check (price_unit is null or length(price_unit) <= 40), -- e.g. "per night", "per person"
  metadata    jsonb not null default '{}'::jsonb,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index knowledge_items_business_idx on public.knowledge_items(business_id, category, sort_order);

-- ---------------------------------------------------------------------------
-- AI configuration per business (provider API keys are NOT stored here; they
-- live in Edge Function secrets so they never reach a browser).
-- ---------------------------------------------------------------------------
create table public.ai_settings (
  business_id        uuid primary key references public.businesses(id) on delete cascade,
  provider           text not null default 'default' check (provider in ('default', 'anthropic', 'openai', 'openai_compatible')),
  model              text check (model is null or length(model) <= 100),
  temperature        numeric(3,2) not null default 0.3 check (temperature between 0 and 1),
  max_output_tokens  integer not null default 600 check (max_output_tokens between 50 and 2000),
  tone               text not null default 'warm and professional' check (length(tone) <= 200),
  extra_instructions text not null default '' check (length(extra_instructions) <= 2000),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Customers, conversations and messages
-- ---------------------------------------------------------------------------
create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text check (name is null or length(name) <= 120),
  email       text check (email is null or length(email) <= 200),
  phone       text check (phone is null or length(phone) <= 40),
  notes       text not null default '' check (length(notes) <= 2000),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create unique index customers_business_email_uniq on public.customers(business_id, lower(email)) where email is not null;
create index customers_business_idx on public.customers(business_id, last_seen desc);

create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  visitor_id      text not null check (length(visitor_id) between 16 and 100),
  customer_id     uuid references public.customers(id) on delete set null,
  status          public.conversation_status not null default 'open',
  channel         text not null default 'web',
  escalation_reason text,
  message_count   integer not null default 0,
  page_url        text check (page_url is null or length(page_url) <= 500),
  started_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index conversations_business_idx on public.conversations(business_id, last_message_at desc);
create index conversations_visitor_idx  on public.conversations(business_id, visitor_id);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  business_id     uuid not null references public.businesses(id) on delete cascade,
  role            public.message_role not null,
  content         text not null check (length(content) <= 8000),
  created_at      timestamptz not null default now()
);
create index messages_conversation_idx on public.messages(conversation_id, created_at);
create index messages_business_idx     on public.messages(business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Reservations and general enquiries
-- ---------------------------------------------------------------------------
create table public.reservations (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  customer_id      uuid references public.customers(id) on delete set null,
  conversation_id  uuid references public.conversations(id) on delete set null,
  kind             public.reservation_kind not null,
  -- hotel
  check_in         date,
  check_out        date,
  room_preference  text check (room_preference is null or length(room_preference) <= 200),
  -- restaurant
  reservation_date date,
  reservation_time time,
  -- shared
  guests           integer not null check (guests between 1 and 500),
  special_requests text not null default '' check (length(special_requests) <= 2000),
  contact_name     text not null check (length(contact_name) between 1 and 120),
  contact_email    text check (contact_email is null or length(contact_email) <= 200),
  contact_phone    text check (contact_phone is null or length(contact_phone) <= 40),
  status           public.reservation_status not null default 'pending',
  business_notes   text not null default '' check (length(business_notes) <= 2000),
  decided_at       timestamptz,
  decided_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint reservation_contact_present check (contact_email is not null or contact_phone is not null),
  constraint hotel_dates check (kind <> 'hotel' or (check_in is not null and check_out is not null and check_out > check_in)),
  constraint restaurant_slot check (kind <> 'restaurant' or (reservation_date is not null and reservation_time is not null))
);
create index reservations_business_idx on public.reservations(business_id, status, created_at desc);

create table public.enquiries (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  customer_id     uuid references public.customers(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  contact_name    text not null check (length(contact_name) between 1 and 120),
  contact_email   text check (contact_email is null or length(contact_email) <= 200),
  contact_phone   text check (contact_phone is null or length(contact_phone) <= 40),
  message         text not null check (length(message) between 1 and 4000),
  status          public.enquiry_status not null default 'new',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint enquiry_contact_present check (contact_email is not null or contact_phone is not null)
);
create index enquiries_business_idx on public.enquiries(business_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- AI usage log (analytics + limits)
-- ---------------------------------------------------------------------------
create table public.ai_usage (
  id              bigserial primary key,
  business_id     uuid not null references public.businesses(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  provider        text not null,
  model           text not null,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  latency_ms      integer,
  success         boolean not null default true,
  created_at      timestamptz not null default now()
);
create index ai_usage_business_idx on public.ai_usage(business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Rate limiting (fixed window counters, used by Edge Functions)
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);

create or replace function public.check_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits   integer;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;

  -- Opportunistic cleanup of old windows (cheap, keeps the table small).
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return v_hits <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helper functions used by RLS
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = auth.uid()
  ) or public.is_platform_admin();
$$;

create or replace function public.has_business_role(p_business_id uuid, p_roles public.member_role[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = auth.uid() and role = any(p_roles)
  ) or public.is_platform_admin();
$$;

-- Messages used this calendar month vs. limit (assistant replies only).
create or replace function public.business_monthly_usage(p_business_id uuid)
returns table (used integer, message_limit integer)
language sql stable security definer set search_path = public
as $$
  select
    (select count(*)::int from public.ai_usage u
      where u.business_id = p_business_id and u.success
        and u.created_at >= date_trunc('month', now())) as used,
    coalesce(b.monthly_message_limit, p.monthly_message_limit) as message_limit
  from public.businesses b
  join public.plans p on p.code = b.plan_code
  where b.id = p_business_id
    -- service role (no auth.uid()) or a member of this business only
    and (auth.uid() is null or public.is_business_member(p_business_id));
$$;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger businesses_touch      before update on public.businesses      for each row execute function public.touch_updated_at();
create trigger knowledge_items_touch before update on public.knowledge_items for each row execute function public.touch_updated_at();
create trigger ai_settings_touch     before update on public.ai_settings     for each row execute function public.touch_updated_at();
create trigger reservations_touch    before update on public.reservations    for each row execute function public.touch_updated_at();
create trigger enquiries_touch       before update on public.enquiries       for each row execute function public.touch_updated_at();

-- Business members may not change subscription / platform-controlled fields.
create or replace function public.protect_business_platform_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    if new.status is distinct from old.status
       or new.plan_code is distinct from old.plan_code
       or new.subscription_status is distinct from old.subscription_status
       or new.setup_fee_paid is distinct from old.setup_fee_paid
       or new.current_period_end is distinct from old.current_period_end
       or new.monthly_message_limit is distinct from old.monthly_message_limit then
      raise exception 'Only FaidaHQ platform admins can change plan, status or limits';
    end if;
  end if;
  return new;
end;
$$;
create trigger businesses_protect before update on public.businesses
  for each row execute function public.protect_business_platform_fields();

-- Record who confirmed/declined a reservation and when.
create or replace function public.stamp_reservation_decision()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and new.status in ('confirmed', 'declined', 'cancelled') then
    new.decided_at := now();
    new.decided_by := auth.uid();
  end if;
  return new;
end;
$$;
create trigger reservations_decision before update on public.reservations
  for each row execute function public.stamp_reservation_decision();

-- ---------------------------------------------------------------------------
-- Onboarding: a signed-in user creates a business and becomes its owner.
-- ---------------------------------------------------------------------------
create or replace function public.create_business(p_name text, p_slug text, p_type public.business_type)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if (select count(*) from public.business_members where user_id = auth.uid() and role = 'owner') >= 5 then
    raise exception 'Business limit reached for this account';
  end if;

  insert into public.businesses (name, slug, type, status)
  values (trim(p_name), lower(trim(p_slug)), p_type, 'active')
  returning id into v_id;

  insert into public.business_members (business_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.ai_settings (business_id) values (v_id);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.plans            enable row level security;
alter table public.businesses       enable row level security;
alter table public.business_members enable row level security;
alter table public.platform_admins  enable row level security;
alter table public.knowledge_items  enable row level security;
alter table public.ai_settings      enable row level security;
alter table public.customers        enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.reservations     enable row level security;
alter table public.enquiries        enable row level security;
alter table public.ai_usage         enable row level security;
alter table public.rate_limits      enable row level security; -- no policies: server only

-- Plans: readable by any signed-in user; only admins edit.
create policy plans_read  on public.plans for select to authenticated using (true);
create policy plans_admin on public.plans for all    to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Businesses
create policy businesses_read   on public.businesses for select to authenticated using (public.is_business_member(id));
create policy businesses_update on public.businesses for update to authenticated
  using (public.has_business_role(id, array['owner','admin']::public.member_role[]))
  with check (public.has_business_role(id, array['owner','admin']::public.member_role[]));
create policy businesses_admin_insert on public.businesses for insert to authenticated with check (public.is_platform_admin());
create policy businesses_admin_delete on public.businesses for delete to authenticated using (public.is_platform_admin());

-- Members: see your colleagues; owners manage the team.
create policy members_read on public.business_members for select to authenticated
  using (user_id = auth.uid() or public.is_business_member(business_id));
create policy members_manage on public.business_members for all to authenticated
  using (public.has_business_role(business_id, array['owner']::public.member_role[]))
  with check (public.has_business_role(business_id, array['owner']::public.member_role[]));

-- Platform admins table: admins only.
create policy platform_admins_read on public.platform_admins for select to authenticated
  using (user_id = auth.uid() or public.is_platform_admin());

-- Knowledge: any member reads; owner/admin edit.
create policy knowledge_read on public.knowledge_items for select to authenticated using (public.is_business_member(business_id));
create policy knowledge_write on public.knowledge_items for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::public.member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::public.member_role[]));

-- AI settings
create policy ai_settings_read on public.ai_settings for select to authenticated using (public.is_business_member(business_id));
create policy ai_settings_write on public.ai_settings for all to authenticated
  using (public.has_business_role(business_id, array['owner','admin']::public.member_role[]))
  with check (public.has_business_role(business_id, array['owner','admin']::public.member_role[]));

-- Customers / conversations / reservations / enquiries: members read & update.
create policy customers_read   on public.customers for select to authenticated using (public.is_business_member(business_id));
create policy customers_update on public.customers for update to authenticated using (public.is_business_member(business_id)) with check (public.is_business_member(business_id));
create policy customers_delete on public.customers for delete to authenticated using (public.has_business_role(business_id, array['owner','admin']::public.member_role[]));

create policy conversations_read   on public.conversations for select to authenticated using (public.is_business_member(business_id));
create policy conversations_update on public.conversations for update to authenticated using (public.is_business_member(business_id)) with check (public.is_business_member(business_id));

create policy messages_read on public.messages for select to authenticated using (public.is_business_member(business_id));
-- Staff can reply inside a conversation of their own business.
create policy messages_staff_insert on public.messages for insert to authenticated
  with check (
    role = 'staff'
    and public.is_business_member(business_id)
    and exists (select 1 from public.conversations c where c.id = conversation_id and c.business_id = messages.business_id)
  );

create policy reservations_read   on public.reservations for select to authenticated using (public.is_business_member(business_id));
create policy reservations_update on public.reservations for update to authenticated using (public.is_business_member(business_id)) with check (public.is_business_member(business_id));

create policy enquiries_read   on public.enquiries for select to authenticated using (public.is_business_member(business_id));
create policy enquiries_update on public.enquiries for update to authenticated using (public.is_business_member(business_id)) with check (public.is_business_member(business_id));

create policy ai_usage_read on public.ai_usage for select to authenticated using (public.is_business_member(business_id));

-- Lock down privileged functions: only the server (service role) may call these.
revoke execute on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.create_business(text, text, public.business_type) from public, anon;
grant  execute on function public.create_business(text, text, public.business_type) to authenticated;
revoke execute on function public.business_monthly_usage(uuid) from public, anon;
grant  execute on function public.business_monthly_usage(uuid) to authenticated;
