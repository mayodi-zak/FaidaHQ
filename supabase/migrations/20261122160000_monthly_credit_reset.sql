-- Monthly reply credits: a stored counter per business, reset by a scheduled
-- (pg_cron) job at 00:00 UTC on the 1st of every month.
-- ai_usage stays as the permanent log for analytics; it is no longer what the
-- limit check counts.

alter table public.businesses
  add column credits_used integer not null default 0 check (credits_used >= 0),
  add column credits_period_start timestamptz not null default date_trunc('month', now());

-- Start from this month's real usage so nobody's count jumps to zero on deploy.
update public.businesses b set credits_used = (
  select count(*)::int from public.ai_usage u
  where u.business_id = b.id and u.success and u.created_at >= date_trunc('month', now()));

create or replace function public.count_ai_credit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.success then
    update public.businesses set credits_used = credits_used + 1 where id = new.business_id;
  end if;
  return new;
end;
$$;
create trigger ai_usage_count_credit after insert on public.ai_usage
  for each row execute function public.count_ai_credit();

-- Owners must not be able to hand themselves credits back.
create or replace function public.protect_business_platform_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_platform_admin() then
    if new.status is distinct from old.status
       or new.plan_code is distinct from old.plan_code
       or new.subscription_status is distinct from old.subscription_status
       or new.setup_fee_paid is distinct from old.setup_fee_paid
       or new.current_period_end is distinct from old.current_period_end
       or new.monthly_message_limit is distinct from old.monthly_message_limit
       or new.credits_used is distinct from old.credits_used
       or new.credits_period_start is distinct from old.credits_period_start then
      raise exception 'Only FaidaHQ platform admins can change plan, status or limits';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.business_monthly_usage(p_business_id uuid)
returns table (used integer, message_limit integer)
language sql stable security definer set search_path = public
as $$
  select b.credits_used,
         coalesce(b.monthly_message_limit, p.monthly_message_limit)
  from public.businesses b
  join public.plans p on p.code = b.plan_code
  where b.id = p_business_id
    and (auth.uid() is null or public.is_business_member(p_business_id));
$$;

-- The monthly reset. Server-side only (cron / service role).
create or replace function public.reset_monthly_credits()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.businesses set credits_used = 0, credits_period_start = date_trunc('month', now())
  where credits_used > 0 or credits_period_start < date_trunc('month', now());
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.reset_monthly_credits() from public, anon, authenticated;

-- Schedule it where pg_cron exists (Supabase). Plain Postgres (CI) skips this.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'faidahq-reset-credits';
    perform cron.schedule('faidahq-reset-credits', '0 0 1 * *', 'select public.reset_monthly_credits()');
  end if;
end $$;
