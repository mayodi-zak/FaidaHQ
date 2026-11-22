-- Row Level Security and business-isolation tests.
-- Each check raises an exception (and the run fails) if an expectation is not met.
\set ON_ERROR_STOP 1

create schema tests;
grant usage on schema tests to authenticated, anon;
create function tests.expect(actual bigint, expected bigint, label text) returns text
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
  return 'ok: ' || label;
end $$;
-- Runs a statement as the current role and checks that it is rejected.
create function tests.expect_denied(stmt text, label text) returns text
language plpgsql as $$
declare n bigint;
begin
  begin
    execute stmt;
    get diagnostics n = row_count;
    if n = 0 then return 'ok: ' || label || ' (no rows affected)'; end if;
  exception when others then
    return 'ok: ' || label || ' (' || sqlerrm || ')';
  end;
  raise exception 'FAIL: % (statement succeeded and changed % rows)', label, n;
end $$;
grant execute on all functions in schema tests to authenticated, anon;

-- Fixtures --------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner-a@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'owner-b@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'staff-a@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'admin@faidahq.com'),
  ('55555555-5555-4555-8555-555555555555', 'stranger@example.com');
insert into public.platform_admins (user_id) values ('44444444-4444-4444-8444-444444444444');

-- Owners create their businesses through the onboarding function.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select public.create_business('Hotel A', 'hotel-a', 'hotel') as a_id \gset
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select public.create_business('Cafe B', 'cafe-b', 'cafe') as b_id \gset
reset role;
select set_config('request.jwt.claim.sub', '', false);

insert into public.business_members (business_id, user_id, role) values (:'a_id', '33333333-3333-4333-8333-333333333333', 'staff');

-- Server-side (service role) rows, as the Edge Functions would write them.
insert into public.knowledge_items (business_id, category, title, content) values
  (:'a_id', 'faq', 'A secret', 'Only A should see this'),
  (:'b_id', 'faq', 'B secret', 'Only B should see this');
insert into public.conversations (id, business_id, visitor_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', :'a_id', 'visitor-aaaaaaaaaaaaaaaa'),
  ('bbbbbbbb-0000-4000-8000-000000000001', :'b_id', 'visitor-bbbbbbbbbbbbbbbb');
insert into public.messages (conversation_id, business_id, role, content) values
  ('aaaaaaaa-0000-4000-8000-000000000001', :'a_id', 'user', 'hello A'),
  ('bbbbbbbb-0000-4000-8000-000000000001', :'b_id', 'user', 'hello B');
insert into public.customers (id, business_id, name, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', :'a_id', 'Guest A', 'g@a.com'),
  ('bbbbbbbb-0000-4000-8000-0000000000c1', :'b_id', 'Guest B', 'g@b.com');
insert into public.reservations (id, business_id, customer_id, kind, check_in, check_out, guests, contact_name, contact_email) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', :'a_id', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'hotel', current_date + 3, current_date + 5, 2, 'Guest A', 'g@a.com');
insert into public.reservations (id, business_id, kind, reservation_date, reservation_time, guests, contact_name, contact_phone) values
  ('bbbbbbbb-0000-4000-8000-0000000000a1', :'b_id', 'restaurant', current_date + 1, '19:30', 4, 'Guest B', '+254700000001');
insert into public.ai_usage (business_id, provider, model, input_tokens, output_tokens) values
  (:'a_id', 'anthropic', 'test', 10, 5), (:'b_id', 'anthropic', 'test', 10, 5);

-- 1. Anonymous visitors can read nothing directly -----------------------------
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select tests.expect_denied('select 1 from public.businesses limit 1', 'anon cannot read businesses');
select tests.expect_denied('select 1 from public.messages limit 1', 'anon cannot read messages');
select tests.expect_denied($$insert into public.messages (conversation_id, business_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000001', '$$ || :'a_id' || $$', 'user', 'x')$$, 'anon cannot write messages');
select tests.expect_denied($$select public.check_rate_limit('x', 1, 60)$$, 'anon cannot call rate limiter');
reset role;

-- 2. Owner A sees only business A ----------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select tests.expect((select count(*) from public.businesses), 1, 'owner A sees 1 business');
select tests.expect((select count(*) from public.knowledge_items where title = 'B secret'), 0, 'owner A cannot see B knowledge');
select tests.expect((select count(*) from public.knowledge_items), 1, 'owner A sees own knowledge');
select tests.expect((select count(*) from public.messages), 1, 'owner A sees only A messages');
select tests.expect((select count(*) from public.conversations), 1, 'owner A sees only A conversations');
select tests.expect((select count(*) from public.customers), 1, 'owner A sees only A customers');
select tests.expect((select count(*) from public.reservations), 1, 'owner A sees only A reservations');
select tests.expect((select count(*) from public.ai_usage), 1, 'owner A sees only A usage');
select tests.expect((select count(*) from public.ai_settings), 1, 'owner A sees only A AI settings');
select tests.expect((select used from public.business_monthly_usage(:'a_id')), 1, 'owner A reads own usage');
select tests.expect((select count(*) from public.business_monthly_usage(:'b_id')), 0, 'owner A cannot read B usage');

-- Owner A can manage own knowledge and confirm own reservation
insert into public.knowledge_items (business_id, category, title, content) values (:'a_id', 'room', 'Deluxe', 'Nice room');
select tests.expect((select count(*) from public.knowledge_items), 2, 'owner A adds knowledge');
update public.reservations set status = 'confirmed' where id = 'aaaaaaaa-0000-4000-8000-0000000000a1';
select tests.expect((select count(*) from public.reservations where status = 'confirmed' and decided_by = '11111111-1111-4111-8111-111111111111' and decided_at is not null), 1, 'owner A confirms reservation (who + when stamped)');
update public.businesses set description = 'Updated' where id = :'a_id';
select tests.expect((select count(*) from public.businesses where description = 'Updated'), 1, 'owner A edits profile');

-- Owner A cannot touch business B
select tests.expect_denied($$insert into public.knowledge_items (business_id, category, title) values ('$$ || :'b_id' || $$', 'faq', 'injected')$$, 'owner A cannot add knowledge to B');
select tests.expect_denied($$update public.reservations set status = 'confirmed' where id = 'bbbbbbbb-0000-4000-8000-0000000000a1'$$, 'owner A cannot confirm B reservation');
select tests.expect_denied($$update public.businesses set name = 'Hacked' where id = '$$ || :'b_id' || $$'$$, 'owner A cannot edit B profile');
select tests.expect_denied($$delete from public.knowledge_items where business_id = '$$ || :'b_id' || $$'$$, 'owner A cannot delete B knowledge');
select tests.expect_denied($$insert into public.business_members (business_id, user_id, role) values ('$$ || :'b_id' || $$', '11111111-1111-4111-8111-111111111111', 'owner')$$, 'owner A cannot join B');
select tests.expect_denied($$insert into public.messages (conversation_id, business_id, role, content) values ('bbbbbbbb-0000-4000-8000-000000000001', '$$ || :'a_id' || $$', 'staff', 'cross-business')$$, 'owner A cannot post into B conversation');
select tests.expect_denied($$insert into public.platform_admins (user_id) values ('11111111-1111-4111-8111-111111111111')$$, 'owner A cannot become platform admin');

-- Owner A cannot change platform-controlled fields
select tests.expect_denied($$update public.businesses set plan_code = 'premium' where id = '$$ || :'a_id' || $$'$$, 'owner cannot change own plan');
select tests.expect_denied($$update public.businesses set status = 'active', monthly_message_limit = 999999 where id = '$$ || :'a_id' || $$'$$, 'owner cannot raise own limit');

-- Staff reply into own conversation works
insert into public.messages (conversation_id, business_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000001', :'a_id', 'staff', 'Hi, this is reception');
select tests.expect((select count(*) from public.messages where role = 'staff'), 1, 'owner A posts staff reply');
select tests.expect_denied($$insert into public.messages (conversation_id, business_id, role, content) values ('aaaaaaaa-0000-4000-8000-000000000001', '$$ || :'a_id' || $$', 'assistant', 'fake AI')$$, 'members cannot forge assistant messages');

-- 3. Staff member of A: reads A, cannot edit knowledge ---------------------------
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
select tests.expect((select count(*) from public.knowledge_items), 2, 'staff A reads A knowledge');
select tests.expect_denied($$update public.knowledge_items set title = 'x' where business_id = '$$ || :'a_id' || $$'$$, 'staff cannot edit knowledge');
select tests.expect_denied($$update public.businesses set name = 'x' where id = '$$ || :'a_id' || $$'$$, 'staff cannot edit profile');
select tests.expect((select count(*) from public.reservations), 1, 'staff A sees A reservations');

-- 4. Stranger with an account sees nothing --------------------------------------
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', false);
select tests.expect((select count(*) from public.businesses), 0, 'stranger sees no businesses');
select tests.expect((select count(*) from public.messages), 0, 'stranger sees no messages');
select tests.expect((select count(*) from public.reservations), 0, 'stranger sees no reservations');
select tests.expect((select count(*) from public.customers), 0, 'stranger sees no customers');

-- 5. Platform admin sees everything and controls plans --------------------------
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select tests.expect((select count(*) from public.businesses), 3, 'admin sees all businesses (incl. demo)');
select tests.expect((select count(*) from public.messages), 3, 'admin sees all messages');
update public.businesses set status = 'suspended', plan_code = 'premium' where id = :'b_id';
select tests.expect((select count(*) from public.businesses where status = 'suspended' and plan_code = 'premium'), 1, 'admin suspends + changes plan');
reset role;

-- 6. Rate limiter (server only) --------------------------------------------------
select tests.expect((select count(*) from generate_series(1, 5) i where public.check_rate_limit('t:key', 3, 60)), 3, 'rate limiter allows 3 of 5');

-- 7. Data rules ------------------------------------------------------------------
select tests.expect_denied($$insert into public.reservations (business_id, kind, check_in, check_out, guests, contact_name, contact_email) values ('$$ || :'a_id' || $$', 'hotel', current_date + 5, current_date + 2, 2, 'X', 'x@x.com')$$, 'check-out before check-in rejected');
select tests.expect_denied($$insert into public.reservations (business_id, kind, reservation_date, reservation_time, guests, contact_name) values ('$$ || :'a_id' || $$', 'restaurant', current_date + 1, '19:00', 2, 'X')$$, 'reservation without contact rejected');
select tests.expect_denied($$insert into public.businesses (name, slug) values ('Bad', 'Bad Slug!')$$, 'invalid slug rejected');

-- 8. Team + admin helpers ------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select tests.expect((select count(*) from public.list_business_members(:'a_id')), 2, 'owner A lists own team');
select tests.expect((select count(*) from public.list_business_members(:'b_id')), 0, 'owner A cannot list B team');
select public.add_business_member(:'a_id', 'stranger@example.com', 'staff') is not null as added \gset
select tests.expect((select count(*) from public.list_business_members(:'a_id')), 3, 'owner A adds member by email');
select tests.expect_denied($$select public.add_business_member('$$ || :'b_id' || $$', 'owner-a@example.com', 'owner')$$, 'owner A cannot add self to B');
select tests.expect_denied('select * from public.admin_business_overview()', 'non-admin cannot read platform overview');
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
select tests.expect_denied($$select public.add_business_member('$$ || :'a_id' || $$', 'owner-b@example.com', 'admin')$$, 'staff cannot add members');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
select tests.expect((select count(*) from public.admin_business_overview()), 3, 'admin reads platform overview');
select tests.expect((select count(*) from public.admin_business_overview() where owner_email = 'owner-a@example.com'), 1, 'overview shows owner email');
reset role;

-- 10. Encrypted AI keys: no browser role can read or change them -----------------
insert into public.ai_provider_credentials (provider, encrypted_key, key_hint, default_model)
  values ('openai', 'v1:dGVzdA==:dGVzdA==', '…wxyz', 'gpt-5-mini');
select tests.expect_denied($$insert into public.ai_provider_credentials (provider, encrypted_key, key_hint) values ('gemini', 'plain-key', '…')$$, 'unencrypted key format rejected');
select tests.expect_denied($$insert into public.ai_provider_credentials (provider, encrypted_key, key_hint, base_url) values ('gemini', 'v1:a:b', '…', 'http://insecure.example')$$, 'non-https base url rejected');
select tests.expect_denied($$update public.platform_ai_settings set default_provider = 'openai', fallback_provider = 'openai'$$, 'fallback must differ from default');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
set role authenticated;
select tests.expect_denied('select * from public.ai_provider_credentials', 'platform admin cannot read key table directly');
select tests.expect_denied('select * from public.platform_ai_settings', 'platform admin cannot read AI settings table directly');
select tests.expect_denied($$update public.ai_provider_credentials set default_model = 'x'$$, 'admin cannot change keys directly');
select tests.expect_denied($$insert into public.ai_provider_credentials (provider, encrypted_key, key_hint) values ('gemini', 'v1:a:b', '…')$$, 'admin cannot insert keys directly');
select tests.expect((select count(*) from public.admin_ai_overview()), 4, 'admin overview lists all four providers');
select tests.expect((select count(*) from public.admin_ai_overview() where provider = 'openai' and key_hint = '…wxyz'), 1, 'admin overview shows only the key hint');
select tests.expect((select count(*) from information_schema.routines r join information_schema.parameters p on p.specific_name = r.specific_name
  where r.routine_name = 'admin_ai_overview' and p.parameter_name in ('encrypted_key', 'api_key')), 0, 'admin overview has no key column');
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select tests.expect_denied('select * from public.admin_ai_overview()', 'non-admin cannot read AI overview');
select tests.expect_denied('select * from public.ai_provider_credentials', 'owner cannot read key table');
select tests.expect((select count(*) from public.ai_settings where business_id = :'a_id'), 1, 'owner sees own AI settings');
update public.ai_settings set provider = 'gemini', model = 'gemini-2.5-flash' where business_id = :'a_id';
select tests.expect((select count(*) from public.ai_settings where business_id = :'a_id' and provider = 'gemini'), 1, 'owner can choose Gemini');
reset role;
set role anon;
select tests.expect_denied('select * from public.ai_provider_credentials', 'anon cannot read key table');
select tests.expect_denied('select * from public.admin_ai_overview()', 'anon cannot call AI overview');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 9. Demo seed loaded --------------------------------------------------------------
select tests.expect((select count(*) from public.knowledge_items where business_id = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'), 37, 'demo knowledge seeded');


-- 6. Learning suggestions: reviewed only by owner/admin of that business ---------
reset role;
select set_config('request.jwt.claim.sub', '', false);
insert into public.knowledge_suggestions (id, business_id, category, title, content) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', :'a_id', 'faq', 'Pets?', 'Small dogs welcome'),
  ('aaaaaaaa-0000-4000-8000-0000000000e2', :'a_id', 'faq', 'Parking?', ''),
  ('bbbbbbbb-0000-4000-8000-0000000000e1', :'b_id', 'faq', 'B draft', 'x');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select tests.expect((select count(*) from public.knowledge_suggestions), 2, 'owner A sees only A suggestions');
select tests.expect_denied($$insert into public.knowledge_suggestions (business_id, title) values ('$$ || :'a_id' || $$', 'forged')$$, 'members cannot write suggestions directly');
select tests.expect_denied($$select public.review_knowledge_suggestion('bbbbbbbb-0000-4000-8000-0000000000e1', 'approve')$$, 'owner A cannot review B suggestion');
select tests.expect_denied($$select public.review_knowledge_suggestion('aaaaaaaa-0000-4000-8000-0000000000e2', 'approve')$$, 'cannot approve a draft with no answer');
select public.review_knowledge_suggestion('aaaaaaaa-0000-4000-8000-0000000000e1', 'approve');
select tests.expect((select count(*) from public.knowledge_items where title = 'Pets?'), 1, 'approving adds it to the knowledge base');
select tests.expect_denied($$select public.review_knowledge_suggestion('aaaaaaaa-0000-4000-8000-0000000000e1', 'approve')$$, 'cannot review twice');
select public.review_knowledge_suggestion('aaaaaaaa-0000-4000-8000-0000000000e2', 'dismiss');
select tests.expect((select count(*) from public.knowledge_suggestions where status = 'pending'), 0, 'dismissed draft is closed');
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
select tests.expect((select count(*) from public.knowledge_suggestions), 2, 'staff can read suggestions');
select tests.expect_denied($$select public.review_knowledge_suggestion('aaaaaaaa-0000-4000-8000-0000000000e2', 'dismiss')$$, 'staff cannot review suggestions');
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
select tests.expect((select count(*) from public.knowledge_suggestions), 1, 'owner B sees only B suggestions');
select tests.expect((select count(*) from public.knowledge_suggestions where title = 'Pets?'), 0, 'owner B cannot see A suggestions');
reset role;

-- 7. Monthly credits: counted by trigger, reset by the cron function ---------------
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tests.expect((select credits_used from public.businesses where id = :'a_id'), 1, 'credits counted from usage rows');
insert into public.ai_usage (business_id, provider, model, success) values (:'a_id', 'anthropic', 'test', false);
select tests.expect((select credits_used from public.businesses where id = :'a_id'), 1, 'failed replies cost no credit');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select tests.expect_denied($$update public.businesses set credits_used = 0 where id = '$$ || :'a_id' || $$'$$, 'owner cannot reset own credits');
select tests.expect_denied('select public.reset_monthly_credits()', 'members cannot run the reset');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select tests.expect((select public.reset_monthly_credits()), 2, 'reset clears businesses that used credits');
select tests.expect((select count(*) from public.businesses where credits_used > 0), 0, 'all credits back to zero');
select tests.expect((select count(*) from public.ai_usage where business_id = :'a_id'), 2, 'usage log is kept after reset');

\echo 'All RLS / isolation checks passed'
