# Setting up the FaidaHQ Hospitality Assistant

Follow these steps in order. It takes about 30 minutes.

You need:

- A free [Supabase](https://supabase.com) account.
- An AI provider key: [OpenAI](https://platform.openai.com), [Google Gemini](https://aistudio.google.com/apikey), [Anthropic](https://console.anthropic.com), or any OpenAI-compatible service. You add it in the admin panel later.
- The [Supabase CLI](https://supabase.com/docs/guides/cli) on your computer.

---

## 1. Create the Supabase project

1. In Supabase, click **New project**. Pick a region close to your guests (e.g. Europe West for Kenya).
2. When it's ready, open **Project Settings → API** and note:
   - **Project URL**, e.g. `https://abcd1234.supabase.co`
   - **anon public** key (safe for browsers)
   - **Project reference** (the `abcd1234` part)

> The **service_role** key is secret. Never put it in any file in this repository. The Edge Functions receive it automatically.

## 2. Set up the database

From the repository folder:

```bash
supabase login
supabase link --project-ref abcd1234
supabase db push                      # creates all tables, security rules and functions
```

This also loads the demo business (Tamu Bay), because its data is a migration: `supabase/migrations/20261122135608_seed.sql`.

What `db push` creates:

| Table | Holds |
| --- | --- |
| `businesses` | Each hotel/restaurant: profile, branding, plan, status |
| `business_members` | Which user accounts belong to which business, and their role (owner/admin/staff) |
| `platform_admins` | FaidaHQ staff who can see and manage every business |
| `knowledge_items` | Rooms, menu, services, hours, policies, offers, FAQs |
| `ai_settings` | Per-business AI provider/model, tone, extra instructions |
| `conversations`, `messages` | Chat history |
| `customers` | Guests who left contact details |
| `reservations`, `enquiries` | Booking requests and general enquiries |
| `ai_usage` | Every AI call (for analytics and plan limits) |
| `plans` | Starter / Growth / Premium (prices and monthly reply limits) |
| `rate_limits` | Abuse protection counters (server only) |

Every table has Row Level Security switched on.

## 3. Set the master encryption key (one secret)

AI keys are added in the admin panel (step 6) and stored encrypted in the database. They are encrypted with **one master key** that lives only in Supabase secrets.

```bash
supabase secrets set FAIDAHQ_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

- It is 32 random bytes, written as base64. The command above creates it.
- Keep a private copy (for example in a password manager). If it is lost or changed, the saved AI keys can no longer be decrypted and must be entered again.
- Never put it in a file in this repository or in the browser.

### Optional: keys as secrets instead

You can still set AI keys as Supabase secrets. A key saved in the admin panel wins; a secret is used when no key is saved for that provider. See `supabase/functions/.env.example`:

| Variable | What it does |
| --- | --- |
| `AI_PROVIDER` | Default provider when none is chosen in the admin panel: `anthropic`, `openai`, `gemini` or `openai_compatible` |
| `AI_MODEL` | Model for `AI_PROVIDER` (Anthropic defaults to `claude-opus-5-5`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` | Provider keys |
| `OPENAI_COMPATIBLE_BASE_URL` | e.g. `https://openrouter.ai/api/v1` |
| `AI_TIMEOUT_MS` | AI timeout, default `30000` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Provided automatically by Supabase |

## 4. Deploy the Edge Functions

```bash
supabase functions deploy widget
supabase functions deploy chat
supabase functions deploy enquiry
supabase functions deploy admin-ai-keys
supabase functions deploy learn
```

`supabase/config.toml` marks the first three as public (`verify_jwt = false`) because website visitors are not signed in. They protect themselves: input validation, business status checks, allowed-website checks, per-visitor and per-IP rate limits, and monthly plan limits. `admin-ai-keys` needs a signed-in user and checks on the server that the user is a platform admin.

Quick check (replace the URL):

```bash
curl "https://abcd1234.supabase.co/functions/v1/widget?business_id=6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b"
```

You should see the Tamu Bay name and branding.

## 5. Configure the website

Edit `js/faidahq-config.js`:

```js
window.FaidaHQConfig = {
  supabaseUrl: "https://abcd1234.supabase.co",
  supabaseAnonKey: "eyJ...your anon key...",
  functionsUrl: "https://abcd1234.supabase.co/functions/v1",
  demoBusinessId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
};
```

Commit and push. GitHub Pages publishes it. Now:

- `/demo/` uses the real AI instead of demo mode.
- `/dashboard/` and `/admin/` work.

In Supabase **Authentication → URL Configuration**, set the Site URL to `https://faidahq.com` and add `https://faidahq.com/dashboard/` as a redirect URL (used for email confirmation and password reset).

## 6. Make yourself a platform admin

1. Open `https://faidahq.com/dashboard/` and create an account.
2. In Supabase → SQL Editor, run (with your email):

```sql
insert into public.platform_admins (user_id)
select id from auth.users where email = 'you@faidahq.com';
```

3. To manage the demo business from the dashboard, also run:

```sql
insert into public.business_members (business_id, user_id, role)
select '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', id, 'owner' from auth.users where email = 'you@faidahq.com';
```

`/admin/` now shows all businesses.

### Add your AI keys

1. Open `/admin/` → **AI providers**.
2. Click **Add key** next to OpenAI and/or Google Gemini (or Anthropic), paste the key, and type the model (for example `gpt-5-mini` or `gemini-2.5-flash`). Click **Save**.
3. Click **Test** to check the key works.
4. Under **Which AI answers guests**, pick the **main provider** and, if you like, a **fallback provider** that is used automatically when the main one fails. Click **Save choice**.

How the keys are protected:

- The key is sent once over HTTPS to the `admin-ai-keys` function, which checks you are a platform admin, encrypts it (AES-256-GCM) and stores only the encrypted text.
- The database tables for keys cannot be read by any browser, not even an admin. The page only ever shows the last 4 characters.
- The chat function decrypts keys on the server when it needs them. Changes take effect within a minute.
- To change a key, click **Replace / edit**. To remove it, click **Delete**.

A business can still pick its own provider and model in **Dashboard → AI configuration**.

## Monthly reply limits and the self-improving assistant

**How the monthly limit resets.** Each business has a `credits_used` counter, increased by a database trigger every time a reply succeeds. A `pg_cron` job (`faidahq-reset-credits`, created by the migration `20261122160000_monthly_credit_reset.sql`) runs `reset_monthly_credits()` at 00:00 UTC on the 1st of every month and sets every counter back to zero. `ai_usage` is kept as the permanent log for analytics. Check the job with `select * from cron.job;` and its history with `select * from cron.job_run_details order by start_time desc limit 5;`. Owners cannot change the counter; only the cron job and platform admins can.

**Assistant learning.** When the assistant escalates a conversation, the `learn` function reads it and drafts knowledge entries (using the staff reply when there is one, and leaving the answer blank when there is not). Drafts appear under *Assistant learning* in the dashboard; an owner or admin approves, edits or dismisses each one, and only approved drafts join the knowledge base. Guest text is treated as untrusted and no draft is ever published automatically. Learning does not use up a business's monthly replies.

- Owners/admins press *Check recent conversations now* (limited to 5 runs an hour per business).
- To run it automatically for every business, create one shared secret and a weekly job. The secret is kept in Supabase Vault, so it never appears in the job text. Generate a long random string (for example `openssl rand -hex 32`), then:

```bash
supabase secrets set LEARN_CRON_SECRET=<the string>
```

```sql
-- Supabase SQL editor. Replace <the string> and <project-ref>.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select vault.create_secret('<the string>', 'learn_cron_secret', 'Shared secret for the weekly learn function');

select cron.schedule('faidahq-learn', '0 3 * * 1', $job$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/learn',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'learn_cron_secret')),
    body := '{"all": true}'::jsonb);
$job$);
```

It runs Mondays at 03:00 UTC. Check it with `select * from cron.job;`, and see the result of the last call with `select status_code, content from net._http_response order by id desc limit 1;` (a healthy run returns `{"reviewed":…,"created":…,"failed":0}`). To rotate the secret, set both copies again: `supabase secrets set` and `select vault.update_secret(id, '<new>') from vault.secrets where name = 'learn_cron_secret';`.

## 7. Onboard a new hotel or restaurant

Either:

- **The owner signs up** at `/dashboard/` and clicks **Create business**, or
- **You create it** in `/admin/` → **New business**, and add the owner by email (they must sign up first).

Then in the dashboard:

1. **Business profile**: contact details, colours, assistant name, welcome message. Optionally list the websites allowed to show the chat.
2. **Knowledge base**: add rooms, menu items, hours, policies, offers and FAQs.
3. **Business profile → Add the chat to your website**: copy the snippet into their website.

## Installing the widget

Paste before `</body>` on every page:

```html
<script src="https://faidahq.com/widget.js"
        data-business-id="BUSINESS_ID"
        data-api-url="https://abcd1234.supabase.co/functions/v1"
        defer></script>
```

Options:

| Attribute | Effect |
| --- | --- |
| `data-position="left"` | Button bottom-left instead of bottom-right |
| `data-open="true"` | Open the chat on page load |
| `data-demo="true"` | Offline demo mode (no backend) |

JavaScript controls, available after the `faidahq:ready` event:

```js
FaidaHQWidget.open();            // open the chat
FaidaHQWidget.send("Hello");     // open and send a message
FaidaHQWidget.book("restaurant") // open the reservation form ("hotel" or "restaurant")
```

- **WordPress**: use a plugin like "Insert Headers and Footers" and paste the snippet in the footer.
- **Wix / Squarespace**: add it as custom code in the site footer.

## Security summary

- Browser code only uses the public anon key. Secrets live in Supabase function secrets.
- Row Level Security: members see only their business; staff can read and reply, owners/admins can edit; only platform admins change plans, limits and status.
- Visitors can only read their own conversation (random visitor ID + conversation ID, both checked).
- Rate limits: 12 chat messages a minute per visitor, 40 per IP; 5 enquiries per 10 minutes per visitor.
- Monthly reply limits per plan; when reached, guests get a polite message with the business's contact details instead of an AI reply.
- Optional allowed-websites list per business, checked on every request.
- All guest text is shown as text, never as HTML.

## Testing

```bash
npm install                # installs the Supabase JS file used by dashboard tests
```

**Edge Function logic** (Deno, no network):

```bash
deno test --allow-env tests/functions
```

Covers chat, conversation ownership, business isolation in the AI prompt, escalation, reservation validation, rate limits, plan limits, provider adapters, error handling, key encryption, fallback provider and the admin-only key function.

**Database security** (needs a PostgreSQL 15+ server you can create databases on):

```bash
PGHOST=localhost PGUSER=postgres tests/db/run.sh
```

Loads the migrations onto a throwaway database and checks that each business only sees its own data, staff can't edit what they shouldn't, owners can't change their own plan, and so on.

**Browser tests** (needs [Playwright](https://playwright.dev) with Chromium):

```bash
node --test tests/e2e/*.test.mjs
```

Covers the widget (demo and live mode against a mocked API, mobile layout, errors, retries, XSS, host-site CSS) and the dashboard/admin pages (against a mocked Supabase API).

GitHub Actions runs the function and database tests on every pull request (`.github/workflows/tests.yml`).

**Manual check after deploying**: open `/demo/`, ask "What rooms do you have?", then "Can I bring my dog?" (should say pets aren't allowed), then "Do you have a helipad?" (should say it doesn't know and offer a person). Submit a reservation request and confirm it in the dashboard.

## What's next (not built yet)

- Payment processing for setup fees and subscriptions (plans and statuses are ready in the database).
- WhatsApp and other channels (the `conversations.channel` column is ready).
- Email/SMS notifications to staff for new reservation requests.
