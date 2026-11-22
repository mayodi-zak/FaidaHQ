// Contact form on the main FaidaHQ website. Every message is saved first (so
// nothing is lost), then an alert email is sent through Resend on a best-effort
// basis: an email failure never loses the message or fails the visitor's request.
import { HttpError } from "./http.ts";
import * as v from "./validate.ts";

export interface ContactRow { name: string; email: string; subject: string; message: string }
export interface EmailMessage { from: string; to: string; replyTo: string; subject: string; text: string }

export interface ContactDeps {
  insert(row: ContactRow): Promise<string>;
  markNotified(id: string): Promise<void>;
  rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  env: (name: string) => string | undefined;
  send?: (msg: EmailMessage, apiKey: string) => Promise<void>;
}

export const CONTACT_LIMITS = { perIpPer10Min: 5, allPerHour: 60 };

/** Sends through Resend's HTTPS API (Edge Functions cannot use SMTP). */
export async function sendWithResend(msg: EmailMessage, apiKey: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: msg.from, to: [msg.to], reply_to: msg.replyTo, subject: msg.subject, text: msg.text }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
}

export async function submitContact(deps: ContactDeps, body: Record<string, unknown>, ip: string) {
  // Hidden "website" field: humans leave it empty, simple bots fill it in.
  if (typeof body.website === "string" && body.website.trim()) return { ok: true };

  const name = v.text(body.name, "name", { required: true, max: 120 });
  const email = v.optionalEmail(body.email);
  if (!email) throw new v.ValidationError("email is required");
  const subject = v.text(body.subject, "subject", { required: true, max: 200 }).replace(/\s+/g, " ");
  const message = v.text(body.message, "message", { required: true, max: 4000 });

  const okIp = await deps.rateLimit(`contact:ip:${ip}`, CONTACT_LIMITS.perIpPer10Min, 600);
  const okAll = await deps.rateLimit("contact:all", CONTACT_LIMITS.allPerHour, 3600); // protects the email quota
  if (!okIp || !okAll) throw new HttpError(429, "rate_limited", "Too many messages. Please try again a little later.");

  const id = await deps.insert({ name, email, subject, message });

  const apiKey = deps.env("RESEND_API_KEY");
  const to = deps.env("CONTACT_TO_EMAIL");
  if (apiKey && to) {
    try {
      await (deps.send ?? sendWithResend)({
        from: deps.env("CONTACT_FROM_EMAIL") || "FaidaHQ Website <onboarding@resend.dev>",
        to, replyTo: email,
        subject: `[FaidaHQ website] ${subject}`.slice(0, 250),
        text: `New message from the contact page\n\nName: ${name}\nEmail: ${email}\n\n${message}\n`,
      }, apiKey);
      await deps.markNotified(id);
    } catch (err) {
      console.error("Contact alert email failed:", (err as Error).message);
    }
  } else {
    console.error("Contact alert email skipped: RESEND_API_KEY / CONTACT_TO_EMAIL not set");
  }
  return { ok: true };
}
