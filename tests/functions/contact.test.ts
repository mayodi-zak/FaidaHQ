import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { type ContactDeps, type ContactRow, type EmailMessage, submitContact } from "../../supabase/functions/_shared/contact.ts";
import { HttpError } from "../../supabase/functions/_shared/http.ts";
import { ValidationError } from "../../supabase/functions/_shared/validate.ts";

function setup(env: Record<string, string> = { RESEND_API_KEY: "k", CONTACT_TO_EMAIL: "team@example.com" }) {
  const rows: ContactRow[] = [];
  const sent: EmailMessage[] = [];
  const notified: string[] = [];
  const hits = new Map<string, number>();
  const deps: ContactDeps = {
    env: (n) => env[n],
    insert: async (r) => { rows.push(r); return "id1"; },
    markNotified: async (id) => { notified.push(id); },
    rateLimit: async (k, limit) => { const h = (hits.get(k) ?? 0) + 1; hits.set(k, h); return h <= limit; },
    send: async (m) => { sent.push(m); },
  };
  return { deps, rows, sent, notified };
}
const good = { name: "Wanjiku", email: "W@Example.com", subject: "Hello\nthere", message: "I need a chatbot for my hotel." };

Deno.test("contact: saves the message, emails the team with reply-to set to the visitor", async () => {
  const { deps, rows, sent, notified } = setup();
  assertEquals(await submitContact(deps, good, "1.1.1.1"), { ok: true });
  assertEquals(rows[0].email, "w@example.com");
  assertEquals(rows[0].subject, "Hello there");
  assertEquals(sent[0].to, "team@example.com");
  assertEquals(sent[0].replyTo, "w@example.com");
  assertEquals(notified, ["id1"]);
});

Deno.test("contact: an email failure never loses the message", async () => {
  const { deps, rows, notified } = setup();
  deps.send = () => Promise.reject(new Error("resend down"));
  assertEquals(await submitContact(deps, good, "1.1.1.1"), { ok: true });
  assertEquals(rows.length, 1);
  assertEquals(notified.length, 0);
});

Deno.test("contact: still saves when email is not configured", async () => {
  const { deps, rows, sent } = setup({});
  await submitContact(deps, good, "1.1.1.1");
  assertEquals(rows.length, 1);
  assertEquals(sent.length, 0);
});

Deno.test("contact: honeypot is dropped silently, bad input rejected, floods limited", async () => {
  const { deps, rows } = setup();
  assertEquals(await submitContact(deps, { ...good, website: "http://spam" }, "2.2.2.2"), { ok: true });
  assertEquals(rows.length, 0);
  await assertRejects(() => submitContact(deps, { ...good, email: "nope" }, "2.2.2.2"), ValidationError);
  await assertRejects(() => submitContact(deps, { ...good, message: "" }, "2.2.2.2"), ValidationError);
  for (let i = 0; i < 5; i++) await submitContact(deps, good, "3.3.3.3");
  await assertRejects(() => submitContact(deps, good, "3.3.3.3"), HttpError, "Too many");
});
