-- Self-improving assistant: the assistant drafts knowledge-base entries from
-- conversations it could not answer. A person ALWAYS reviews a draft before it
-- reaches the live knowledge base, so the AI never publishes facts on its own.

alter table public.conversations add column learned_at timestamptz;
create index conversations_unlearned_idx on public.conversations (business_id, last_message_at desc)
  where learned_at is null and status = 'escalated';

create type public.suggestion_status as enum ('pending', 'approved', 'dismissed');

create table public.knowledge_suggestions (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses(id) on delete cascade,
  source_conversation_id uuid references public.conversations(id) on delete set null,
  category               public.knowledge_category not null default 'faq',
  title                  text not null check (length(title) between 1 and 200),
  -- Empty when staff never answered: the owner supplies the real answer.
  content                text not null default '' check (length(content) <= 4000),
  status                 public.suggestion_status not null default 'pending',
  reviewed_by            uuid references auth.users(id) on delete set null,
  reviewed_at            timestamptz,
  created_at             timestamptz not null default now()
);
create index knowledge_suggestions_biz_idx on public.knowledge_suggestions (business_id, status, created_at desc);

alter table public.knowledge_suggestions enable row level security;
-- Members read their own business's drafts. There is no insert/update policy:
-- drafts are written by the server, and reviewed only through the function below.
create policy suggestions_read on public.knowledge_suggestions for select to authenticated
  using (public.is_business_member(business_id));

-- Approve (optionally with edits) or dismiss a draft. Owner/admin only.
create or replace function public.review_knowledge_suggestion(
  p_id uuid, p_action text, p_title text default null, p_content text default null,
  p_category public.knowledge_category default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  s public.knowledge_suggestions%rowtype;
  v_item uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into s from public.knowledge_suggestions where id = p_id for update;
  if not found or not public.has_business_role(s.business_id, array['owner','admin']::public.member_role[]) then
    raise exception 'Suggestion not found';
  end if;
  if s.status <> 'pending' then raise exception 'Already reviewed'; end if;

  if p_action = 'dismiss' then
    update public.knowledge_suggestions set status = 'dismissed', reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    return null;
  elsif p_action = 'approve' then
    if length(trim(coalesce(p_content, s.content))) = 0 then raise exception 'Add the answer before approving'; end if;
    insert into public.knowledge_items (business_id, category, title, content)
    values (s.business_id, coalesce(p_category, s.category), trim(coalesce(p_title, s.title)), trim(coalesce(p_content, s.content)))
    returning id into v_item;
    update public.knowledge_suggestions set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    return v_item;
  end if;
  raise exception 'Unknown action';
end;
$$;
revoke execute on function public.review_knowledge_suggestion(uuid, text, text, text, public.knowledge_category) from public, anon;
grant  execute on function public.review_knowledge_suggestion(uuid, text, text, text, public.knowledge_category) to authenticated;
