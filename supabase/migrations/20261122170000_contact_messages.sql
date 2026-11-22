-- Messages sent from the FaidaHQ website contact page. Written by the
-- `contact` Edge Function (service role); only platform admins can read them.
create type public.contact_status as enum ('new', 'handled');

create table public.contact_messages (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 120),
  email      text not null check (length(email) between 3 and 200),
  subject    text not null check (length(subject) between 1 and 200),
  message    text not null check (length(message) between 1 and 4000),
  status     public.contact_status not null default 'new',
  notified   boolean not null default false, -- alert email was sent
  created_at timestamptz not null default now()
);
create index contact_messages_created_idx on public.contact_messages (status, created_at desc);

alter table public.contact_messages enable row level security;
create policy contact_admin_read   on public.contact_messages for select to authenticated using (public.is_platform_admin());
create policy contact_admin_update on public.contact_messages for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
