-- Private assistants: when public_chat is false, only a signed-in platform admin
-- or a member of that business can use the chat (so nobody else can spend AI
-- credits on it). Real client businesses stay public because their guests are
-- anonymous; test/demo businesses are made private.
alter table public.businesses add column public_chat boolean not null default true;

-- The demo resort is for admins only. (The public /demo page runs offline.)
update public.businesses set public_chat = false where id = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

-- Owners must not be able to make their own assistant public again.
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
       or new.credits_period_start is distinct from old.credits_period_start
       or new.public_chat is distinct from old.public_chat then
      raise exception 'Only FaidaHQ platform admins can change plan, status or limits';
    end if;
  end if;
  return new;
end;
$$;
