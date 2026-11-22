# FaidaHQ

This repository holds two things:

1. **The FaidaHQ website** (faidahq.com): static HTML pages built on a Bootstrap template, hosted on GitHub Pages.
2. **The FaidaHQ Hospitality Assistant**: an AI chat assistant that hotels, restaurants and cafés add to their own websites with one line of code.

There is no build step. Everything in the browser is plain HTML, CSS and JavaScript. The backend is Supabase (PostgreSQL, Auth and Edge Functions).

## The Hospitality Assistant in one picture

```
Guest's browser                     Supabase (server)                         AI provider
───────────────                     ─────────────────                         ───────────
widget.js  ── /widget  ──────────▶  Edge Function: public config + history
           ── /chat    ──────────▶  Edge Function: checks, rate limits,  ──▶  Claude / OpenAI /
           ── /enquiry ──────────▶  loads ONE business's knowledge,           Gemini / any compatible API
                                    saves messages & reservations
                                          │
Owner's browser                           ▼
dashboard/ ── supabase-js (anon key) ▶ PostgreSQL with Row Level Security
admin/                                  (each business sees only its own rows)
```

- The widget never talks to the database directly and never sees a secret.
- AI keys are added in the admin panel and stored **encrypted** (AES-256-GCM) in the database. Only the server can decrypt them, with one master secret (`FAIDAHQ_ENCRYPTION_KEY`). No browser can read them back.
- Row Level Security keeps every business's data separate.

## What's where

| Path | What it is |
| --- | --- |
| `widget.js` | The embeddable chat widget (one script tag, no dependencies) |
| `demo/` | A realistic demo resort website ("Tamu Bay") using the widget |
| `hospitality/` | Product page for the assistant |
| `dashboard/` | Business dashboard: overview, profile, knowledge base, conversations, reservations, customers, AI settings, analytics, team |
| `admin/` | FaidaHQ super-admin: businesses, plans, limits, suspend/activate, usage, AI providers and keys |
| `js/faidahq-config.js` | Public front-end settings (Supabase URL + anon key). No secrets. |
| `supabase/migrations/` | Database tables, indexes, security rules and helper functions |
| `supabase/functions/` | Edge Functions `widget`, `chat`, `enquiry` and shared code |
| `supabase/migrations/20261122135608_seed.sql` | Demo business data (generated from `demo/demo-business.json`) |
| `tests/` | Database, Edge Function and browser tests |
| `docs/SETUP.md` | **Step-by-step setup, deployment, env vars, widget install, testing** |

## Quick start

See it working with no setup at all:

```bash
deno task serve        # then open http://localhost:8080/demo/
```

Without Supabase keys, the demo widget runs in **demo mode**: it answers from the sample data in `demo/demo-business.json` using simple keyword matching, and says so in a yellow banner. Once you connect Supabase and an AI key, the same widget uses the real AI.

To go live, follow [docs/SETUP.md](docs/SETUP.md).

## Add the widget to a website

```html
<script src="https://faidahq.com/widget.js"
        data-business-id="YOUR_BUSINESS_ID"
        data-api-url="https://YOUR-PROJECT.supabase.co/functions/v1"
        defer></script>
```

The business owner can copy this exact snippet (with their ID filled in) from **Dashboard → Business profile**.

## How the assistant stays honest

- It answers only from the business's own knowledge base.
- It is told never to invent prices, availability or policies, and to say when it doesn't know.
- It can't confirm bookings. Reservation requests are saved as **pending** until staff confirm them in the dashboard.
- Questions it can't answer, complaints and requests for a person are flagged as **Needs a person**.

## Tests

```bash
deno install             # once: fetches the test helpers (Playwright, Supabase JS)
deno task e2e:setup      # once: downloads the Chromium browser for the browser tests
deno task test:functions # Edge Function logic
deno task test:db        # database security / business isolation (needs PostgreSQL)
deno task test:e2e       # browser tests for widget, dashboard, admin
```

Details in [docs/SETUP.md](docs/SETUP.md#testing).

## Licence

Website template by [HTML Codex](https://htmlcodex.com) (see `LICENSE.txt` and `docs/TEMPLATE-CREDITS.txt`).
