// Small, dependency-free input validators shared by the Edge Functions.

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISITOR_RE = /^[A-Za-z0-9_-]{16,100}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function uuid(v: unknown, field: string): string {
  if (!isUuid(v)) throw new ValidationError(`${field} must be a valid id`);
  return v.toLowerCase();
}

export function optionalUuid(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  return uuid(v, field);
}

export function visitorId(v: unknown): string {
  if (typeof v !== "string" || !VISITOR_RE.test(v)) {
    throw new ValidationError("visitor_id is invalid");
  }
  return v;
}

/** Trim, strip control characters, enforce length. */
export function text(v: unknown, field: string, opts: { min?: number; max: number; required?: boolean }): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new ValidationError(`${field} must be text`);
  // deno-lint-ignore no-control-regex
  const clean = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  const min = opts.min ?? (opts.required ? 1 : 0);
  if (clean.length < min) throw new ValidationError(`${field} is required`);
  if (clean.length > opts.max) throw new ValidationError(`${field} is too long (max ${opts.max} characters)`);
  return clean;
}

export function optionalEmail(v: unknown): string | null {
  const s = text(v, "email", { max: 200 });
  if (!s) return null;
  if (!EMAIL_RE.test(s)) throw new ValidationError("email address looks invalid");
  return s.toLowerCase();
}

export function optionalPhone(v: unknown): string | null {
  const s = text(v, "phone", { max: 40 });
  if (!s) return null;
  if (!PHONE_RE.test(s)) throw new ValidationError("phone number looks invalid");
  return s;
}

export function date(v: unknown, field: string): string {
  if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) {
    throw new ValidationError(`${field} must be a date (YYYY-MM-DD)`);
  }
  return v;
}

export function time(v: unknown, field: string): string {
  if (typeof v !== "string" || !TIME_RE.test(v)) throw new ValidationError(`${field} must be a time (HH:MM)`);
  return v;
}

export function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

/** Today's date (YYYY-MM-DD) in a given IANA time zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
