// Business logic for the public widget endpoints. Pure with respect to I/O:
// everything external (database, AI, env) is passed in, so it is unit-testable.
import { HttpError, originAllowed } from "./http.ts";
import * as v from "./validate.ts";
import { buildSystemPrompt, parseAssistantReply } from "./prompt.ts";
import { type AiResult, generateReply, type ProviderConfig, resolveProviderConfig, type AiRequest } from "./ai.ts";
import type { BusinessRow, Repo } from "./repo.ts";

export interface Deps {
  repo: Repo;
  env: (name: string) => string | undefined;
  ai?: (cfg: ProviderConfig, req: AiRequest) => Promise<AiResult>;
  now?: () => Date;
}

export const LIMITS = {
  chatPerVisitorPerMinute: 12,
  chatPerIpPerMinute: 40,
  enquiryPerVisitorPer10Min: 5,
  enquiryPerIpPer10Min: 15,
  historyMessages: 20, // how much of the conversation the AI sees
  maxMessageLength: 1000,
};

async function loadActiveBusiness(deps: Deps, businessId: string, origin: string | null): Promise<BusinessRow> {
  const business = await deps.repo.getBusiness(businessId);
  if (!business) throw new HttpError(404, "not_found", "This assistant could not be found.");
  if (business.status !== "active") throw new HttpError(403, "unavailable", "This assistant is currently unavailable.");
  if (!originAllowed(origin, business.allowed_origins)) {
    throw new HttpError(403, "origin_not_allowed", "This website is not allowed to use this assistant.");
  }
  return business;
}

function contactLine(b: BusinessRow): string {
  const bits = [b.phone && `call ${b.phone}`, b.email && `email ${b.email}`].filter(Boolean);
  return bits.length ? ` You can also ${bits.join(" or ")}.` : "";
}

// ---------------------------------------------------------------------------
// GET config
// ---------------------------------------------------------------------------
export async function widgetConfig(deps: Deps, params: { business_id: unknown }, origin: string | null) {
  const businessId = v.uuid(params.business_id, "business_id");
  const b = await loadActiveBusiness(deps, businessId, origin);
  const branding = b.branding || {};
  return {
    business: {
      id: b.id,
      name: b.name,
      type: b.type,
      phone: b.phone ?? null,
      email: b.email ?? null,
      whatsapp: b.whatsapp ?? null,
      timezone: b.timezone,
      currency: b.currency,
    },
    branding: {
      assistant_name: branding.assistant_name || "Assistant",
      primary_color: branding.primary_color || "#4f46e5",
      accent_color: branding.accent_color || "#10b981",
      logo_url: branding.logo_url || null,
      welcome_message: branding.welcome_message || `Hello! Welcome to ${b.name}. How can I help you today?`,
      suggestions: Array.isArray(branding.suggestions) ? (branding.suggestions as unknown[]).slice(0, 4) : [],
    },
  };
}

// ---------------------------------------------------------------------------
// POST history
// ---------------------------------------------------------------------------
export async function conversationHistory(deps: Deps, body: Record<string, unknown>, origin: string | null) {
  const businessId = v.uuid(body.business_id, "business_id");
  const visitorId = v.visitorId(body.visitor_id);
  const conversationId = v.uuid(body.conversation_id, "conversation_id");
  await loadActiveBusiness(deps, businessId, origin);
  const convo = await deps.repo.findConversation(conversationId, businessId, visitorId);
  if (!convo) return { conversation_id: null, status: null, messages: [] };
  const rows = await deps.repo.recentMessages(convo.id, businessId, 50);
  return {
    conversation_id: convo.id,
    status: convo.status,
    messages: rows.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content, created_at: m.created_at })),
  };
}

// ---------------------------------------------------------------------------
// POST chat
// ---------------------------------------------------------------------------
export async function chat(deps: Deps, body: Record<string, unknown>, origin: string | null, ip: string) {
  const businessId = v.uuid(body.business_id, "business_id");
  const visitorId = v.visitorId(body.visitor_id);
  const conversationId = v.optionalUuid(body.conversation_id, "conversation_id");
  const message = v.text(body.message, "message", { required: true, max: LIMITS.maxMessageLength });
  const pageUrl = v.text(body.page_url, "page_url", { max: 500 }) || null;
  const now = deps.now?.() ?? new Date();

  const business = await loadActiveBusiness(deps, businessId, origin);

  const okVisitor = await deps.repo.rateLimit(`chat:v:${businessId}:${visitorId}`, LIMITS.chatPerVisitorPerMinute, 60);
  const okIp = await deps.repo.rateLimit(`chat:ip:${ip}`, LIMITS.chatPerIpPerMinute, 60);
  if (!okVisitor || !okIp) {
    throw new HttpError(429, "rate_limited", "You're sending messages very quickly. Please wait a moment and try again.");
  }

  // Conversation: reuse only if it belongs to this business AND this visitor.
  let convo = conversationId ? await deps.repo.findConversation(conversationId, businessId, visitorId) : null;
  if (!convo) convo = await deps.repo.createConversation(businessId, visitorId, pageUrl);

  await deps.repo.insertMessage(convo.id, businessId, "user", message);
  let count = convo.message_count + 1;

  const finish = async (reply: string, extra: { escalate?: boolean; reason?: string | null } = {}) => {
    await deps.repo.insertMessage(convo!.id, businessId, "assistant", reply);
    count += 1;
    const patch: Record<string, unknown> = { message_count: count, last_message_at: now.toISOString() };
    if (extra.escalate && convo!.status !== "escalated") {
      patch.status = "escalated";
      patch.escalation_reason = extra.reason || "Assistant could not answer confidently";
    }
    await deps.repo.updateConversation(convo!.id, businessId, patch);
  };

  // Plan limit reached: answer politely without calling the AI.
  const usage = await deps.repo.monthlyUsage(businessId);
  if (usage.limit > 0 && usage.used >= usage.limit) {
    const reply = `Thanks for your message! Our team will get back to you shortly.${contactLine(business)}`;
    await finish(reply, { escalate: true, reason: "Monthly assistant limit reached" });
    return { conversation_id: convo.id, reply, show_reservation_form: false, escalated: true, limited: true };
  }

  const [knowledge, settings, history] = await Promise.all([
    deps.repo.getKnowledge(businessId),
    deps.repo.getAiSettings(businessId),
    deps.repo.recentMessages(convo.id, businessId, LIMITS.historyMessages),
  ]);

  const cfg = resolveProviderConfig({ provider: settings?.provider, model: settings?.model }, deps.env);
  const system = buildSystemPrompt(business, knowledge, settings ?? {}, v.todayIn(business.timezone, now));

  // Map stored history to alternating user/assistant turns (staff replies are
  // shown to the AI as assistant turns; consecutive same-role turns merged).
  const turns: AiRequest["messages"] = [];
  for (const m of history) {
    if (m.role === "system") continue;
    const role = m.role === "user" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${m.content}`;
    else turns.push({ role, content: m.content });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") turns.push({ role: "user", content: message });

  const started = Date.now();
  let result: AiResult;
  try {
    result = await (deps.ai ?? generateReply)(cfg, {
      system,
      messages: turns,
      maxOutputTokens: settings?.max_output_tokens ?? 600,
      temperature: Number(settings?.temperature ?? 0.3),
    });
  } catch (err) {
    await deps.repo.logUsage({
      business_id: businessId, conversation_id: convo.id, provider: cfg.provider, model: cfg.model,
      input_tokens: 0, output_tokens: 0, latency_ms: Date.now() - started, success: false,
    });
    await deps.repo.updateConversation(convo.id, businessId, { message_count: count, last_message_at: now.toISOString() });
    throw err;
  }

  await deps.repo.logUsage({
    business_id: businessId, conversation_id: convo.id, provider: result.provider, model: result.model,
    input_tokens: result.inputTokens, output_tokens: result.outputTokens, latency_ms: Date.now() - started, success: true,
  });

  const parsed = result.refused
    ? { text: `I'm not able to help with that here, but our team can.${contactLine(business)}`, showReservationForm: false, escalate: true, escalationReason: "Request declined by AI safety filter" }
    : parseAssistantReply(result.text);

  await finish(parsed.text, { escalate: parsed.escalate, reason: parsed.escalationReason });
  return {
    conversation_id: convo.id,
    reply: parsed.text,
    show_reservation_form: parsed.showReservationForm,
    escalated: parsed.escalate,
  };
}

// ---------------------------------------------------------------------------
// POST enquiry (reservation request or general enquiry / callback request)
// ---------------------------------------------------------------------------
export async function submitEnquiry(deps: Deps, body: Record<string, unknown>, origin: string | null, ip: string) {
  const businessId = v.uuid(body.business_id, "business_id");
  const visitorId = v.visitorId(body.visitor_id);
  const conversationId = v.optionalUuid(body.conversation_id, "conversation_id");
  const type = body.type;
  if (type !== "hotel" && type !== "restaurant" && type !== "general") {
    throw new v.ValidationError("type must be hotel, restaurant or general");
  }
  const name = v.text(body.name, "name", { required: true, max: 120 });
  const email = v.optionalEmail(body.email);
  const phone = v.optionalPhone(body.phone);
  if (!email && !phone) throw new v.ValidationError("Please give an email address or phone number so the team can reach you");

  const business = await loadActiveBusiness(deps, businessId, origin);
  const okVisitor = await deps.repo.rateLimit(`enq:v:${businessId}:${visitorId}`, LIMITS.enquiryPerVisitorPer10Min, 600);
  const okIp = await deps.repo.rateLimit(`enq:ip:${ip}`, LIMITS.enquiryPerIpPer10Min, 600);
  if (!okVisitor || !okIp) throw new HttpError(429, "rate_limited", "Too many requests. Please try again in a few minutes.");

  const today = v.todayIn(business.timezone, deps.now?.() ?? new Date());
  const convo = conversationId ? await deps.repo.findConversation(conversationId, businessId, visitorId) : null;
  const customerId = await deps.repo.upsertCustomer(businessId, { name, email, phone });

  const base = {
    business_id: businessId,
    customer_id: customerId,
    conversation_id: convo?.id ?? null,
    contact_name: name,
    contact_email: email,
    contact_phone: phone,
  };

  let id: string;
  let summary: string;
  let reply: string;

  if (type === "general") {
    const message = v.text(body.message, "message", { required: true, max: 4000 });
    id = await deps.repo.insertEnquiry({ ...base, message });
    summary = `General enquiry submitted by ${name}.`;
    reply = `Thank you, ${name}. Your message has been sent to the ${business.name} team, and they will get back to you soon.`;
  } else {
    const guests = v.int(body.guests, "guests", 1, 50);
    const special = v.text(body.special_requests, "special_requests", { max: 2000 });
    if (type === "hotel") {
      const checkIn = v.date(body.check_in, "check_in");
      const checkOut = v.date(body.check_out, "check_out");
      if (checkIn < today) throw new v.ValidationError("Check-in date cannot be in the past");
      if (checkOut <= checkIn) throw new v.ValidationError("Check-out must be after check-in");
      const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000;
      if (nights > 60) throw new v.ValidationError("For stays longer than 60 nights, please contact the hotel directly");
      const room = v.text(body.room_preference, "room_preference", { max: 200 }) || null;
      id = await deps.repo.insertReservation({
        ...base, kind: "hotel", check_in: checkIn, check_out: checkOut, room_preference: room,
        guests, special_requests: special, status: "pending",
      });
      summary = `Room reservation request: ${checkIn} to ${checkOut}, ${guests} guest(s)${room ? `, ${room}` : ""}. Status: pending confirmation.`;
    } else {
      const date = v.date(body.reservation_date, "reservation_date");
      const time = v.time(body.reservation_time, "reservation_time");
      if (date < today) throw new v.ValidationError("Reservation date cannot be in the past");
      if (Date.parse(date) - Date.parse(today) > 366 * 86_400_000) throw new v.ValidationError("Reservations can be requested up to one year ahead");
      id = await deps.repo.insertReservation({
        ...base, kind: "restaurant", reservation_date: date, reservation_time: time,
        guests, special_requests: special, status: "pending",
      });
      summary = `Table reservation request: ${date} at ${time}, ${guests} guest(s). Status: pending confirmation.`;
    }
    reply = `Thank you, ${name}! Your reservation request has been sent to ${business.name}. ` +
      `It is not confirmed yet: the team will check availability and contact you${email ? ` at ${email}` : ""}${phone ? `${email ? " or" : " on"} ${phone}` : ""} to confirm.`;
  }

  if (convo) {
    await deps.repo.insertMessage(convo.id, businessId, "system", summary);
    await deps.repo.insertMessage(convo.id, businessId, "assistant", reply);
    await deps.repo.updateConversation(convo.id, businessId, {
      customer_id: customerId,
      message_count: convo.message_count + 1,
      last_message_at: new Date().toISOString(),
    });
  }

  return { id, type, status: type === "general" ? "new" : "pending", reply };
}
