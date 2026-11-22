-- ============================================================================
-- Team management and platform (super-admin) helpers
-- ============================================================================

-- Owners add a colleague who already has a FaidaHQ account, by email.
create or replace function public.add_business_member(p_business_id uuid, p_email text, p_role public.member_role)
returns uuid
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_user uuid;
begin
  if not public.has_business_role(p_business_id, array['owner']::public.member_role[]) then
    raise exception 'Only the business owner can add team members';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No FaidaHQ account uses that email yet. Ask them to sign up first.';
  end if;
  insert into public.business_members (business_id, user_id, role)
  values (p_business_id, v_user, p_role)
  on conflict (business_id, user_id) do update set role = excluded.role;
  return v_user;
end;
$$;

-- Team list with emails (members of that business, or platform admins).
create or replace function public.list_business_members(p_business_id uuid)
returns table (user_id uuid, email text, role public.member_role, created_at timestamptz)
language sql stable security definer set search_path = public, auth
as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.business_members m
  join auth.users u on u.id = m.user_id
  where m.business_id = p_business_id
    and public.is_business_member(p_business_id)
  order by m.created_at;
$$;

-- Platform overview for the FaidaHQ super-admin dashboard.
create or replace function public.admin_business_overview()
returns table (
  id uuid, name text, slug text, type public.business_type, status public.business_status,
  plan_code text, subscription_status public.subscription_status, setup_fee_paid boolean,
  monthly_message_limit integer, effective_limit integer,
  owner_email text, conversations_30d bigint, ai_replies_month bigint,
  tokens_month bigint, pending_reservations bigint, created_at timestamptz
)
language plpgsql stable security definer set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admins only';
  end if;
  return query
  select b.id, b.name, b.slug, b.type, b.status, b.plan_code, b.subscription_status, b.setup_fee_paid,
         b.monthly_message_limit,
         coalesce(b.monthly_message_limit, p.monthly_message_limit),
         (select u.email::text from public.business_members m join auth.users u on u.id = m.user_id
           where m.business_id = b.id and m.role = 'owner' order by m.created_at limit 1),
         (select count(*) from public.conversations c where c.business_id = b.id and c.started_at > now() - interval '30 days'),
         (select count(*) from public.ai_usage a where a.business_id = b.id and a.success and a.created_at >= date_trunc('month', now())),
         (select coalesce(sum(a.input_tokens + a.output_tokens), 0) from public.ai_usage a where a.business_id = b.id and a.created_at >= date_trunc('month', now())),
         (select count(*) from public.reservations r where r.business_id = b.id and r.status = 'pending'),
         b.created_at
  from public.businesses b
  join public.plans p on p.code = b.plan_code
  order by b.created_at desc;
end;
$$;

revoke execute on function public.add_business_member(uuid, text, public.member_role) from public, anon;
revoke execute on function public.list_business_members(uuid) from public, anon;
revoke execute on function public.admin_business_overview() from public, anon;
grant execute on function public.add_business_member(uuid, text, public.member_role) to authenticated;
grant execute on function public.list_business_members(uuid) to authenticated;
grant execute on function public.admin_business_overview() to authenticated;

-- Realtime: let the dashboard receive new messages/reservations live.
-- (RLS still applies to realtime subscriptions.)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages, public.reservations, public.conversations;
  end if;
end $$;
