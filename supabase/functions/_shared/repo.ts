// Data access for the public widget endpoints.
// Every method takes a businessId and filters by it, so one business can never
// read or write another business's rows through these endpoints.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import type { BusinessContext, KnowledgeItem } from "./prompt.ts";

export interface BusinessRow extends BusinessContext {
  slug: string;
  status: "pending" | "active" | "suspended";
  allowed_origins: string[];
  /** false = only signed-in platform admins / members of the business may chat. */
  public_chat?: boolean;
  branding: Record<string, unknown> & { assistant_name?: string };
}

export interface AiSettingsRow {
  provider: string;
  model: string | null;
  temperature: number;
  max_output_tokens: number;
  tone: string;
  extra_instructions: string;
}

export interface ConversationRow {
  id: string;
  business_id: string;
  visitor_id: string;
  customer_id: string | null;
  status: "open" | "escalated" | "closed";
  message_count: number;
}

export interface MessageRow {
  role: "user" | "assistant" | "staff" | "system";
  content: string;
  created_at: string;
}

export interface CustomerInput {
  name: string;
  email: string | null;
  phone: string | null;
}

export interface Repo {
  getBusiness(id: string): Promise<BusinessRow | null>;
  getKnowledge(businessId: string): Promise<KnowledgeItem[]>;
  getAiSettings(businessId: string): Promise<AiSettingsRow | null>;
  monthlyUsage(businessId: string): Promise<{ used: number; limit: number }>;
  rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  findConversation(id: string, businessId: string, visitorId: string): Promise<ConversationRow | null>;
  createConversation(businessId: string, visitorId: string, pageUrl: string | null): Promise<ConversationRow>;
  recentMessages(conversationId: string, businessId: string, limit: number): Promise<MessageRow[]>;
  insertMessage(conversationId: string, businessId: string, role: MessageRow["role"], content: string): Promise<void>;
  updateConversation(id: string, businessId: string, patch: Partial<ConversationRow> & { escalation_reason?: string | null; last_message_at?: string }): Promise<void>;
  logUsage(row: { business_id: string; conversation_id: string | null; provider: string; model: string; input_tokens: number; output_tokens: number; latency_ms: number; success: boolean }): Promise<void>;
  upsertCustomer(businessId: string, c: CustomerInput): Promise<string>;
  insertReservation(row: Record<string, unknown>): Promise<string>;
  insertEnquiry(row: Record<string, unknown>): Promise<string>;
}

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

const BUSINESS_FIELDS =
  "id, slug, name, type, description, email, phone, whatsapp, website, address, city, country, timezone, currency, branding, allowed_origins, status, public_chat";

export function supabaseRepo(db: SupabaseClient): Repo {
  return {
    async getBusiness(id) {
      return must(await db.from("businesses").select(BUSINESS_FIELDS).eq("id", id).maybeSingle(), "load business") as BusinessRow | null;
    },
    async getKnowledge(businessId) {
      return must(
        await db.from("knowledge_items")
          .select("category, title, content, price, price_unit, metadata")
          .eq("business_id", businessId).eq("is_active", true)
          .order("category").order("sort_order").order("title")
          .limit(400),
        "load knowledge",
      ) as KnowledgeItem[];
    },
    async getAiSettings(businessId) {
      return must(await db.from("ai_settings").select("*").eq("business_id", businessId).maybeSingle(), "load ai settings") as AiSettingsRow | null;
    },
    async monthlyUsage(businessId) {
      const rows = must(await db.rpc("business_monthly_usage", { p_business_id: businessId }), "usage") as Array<{ used: number; message_limit: number }>;
      return { used: rows?.[0]?.used ?? 0, limit: rows?.[0]?.message_limit ?? 0 };
    },
    async rateLimit(key, limit, windowSeconds) {
      return must(await db.rpc("check_rate_limit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds }), "rate limit") as boolean;
    },
    async findConversation(id, businessId, visitorId) {
      return must(
        await db.from("conversations").select("id, business_id, visitor_id, customer_id, status, message_count")
          .eq("id", id).eq("business_id", businessId).eq("visitor_id", visitorId).maybeSingle(),
        "find conversation",
      ) as ConversationRow | null;
    },
    async createConversation(businessId, visitorId, pageUrl) {
      return must(
        await db.from("conversations").insert({ business_id: businessId, visitor_id: visitorId, page_url: pageUrl })
          .select("id, business_id, visitor_id, customer_id, status, message_count").single(),
        "create conversation",
      ) as ConversationRow;
    },
    async recentMessages(conversationId, businessId, limit) {
      const rows = must(
        await db.from("messages").select("role, content, created_at")
          .eq("conversation_id", conversationId).eq("business_id", businessId)
          .order("created_at", { ascending: false }).limit(limit),
        "load messages",
      ) as MessageRow[];
      return rows.reverse();
    },
    async insertMessage(conversationId, businessId, role, content) {
      must(await db.from("messages").insert({ conversation_id: conversationId, business_id: businessId, role, content }), "save message");
    },
    async updateConversation(id, businessId, patch) {
      must(await db.from("conversations").update(patch).eq("id", id).eq("business_id", businessId), "update conversation");
    },
    async logUsage(row) {
      const { error } = await db.from("ai_usage").insert(row);
      if (error) console.error("usage log failed:", error.message); // never block a reply on analytics
    },
    async upsertCustomer(businessId, c) {
      if (c.email) {
        const existing = must(
          await db.from("customers").select("id").eq("business_id", businessId).ilike("email", c.email).maybeSingle(),
          "find customer",
        ) as { id: string } | null;
        if (existing) {
          const patch: Record<string, unknown> = { last_seen: new Date().toISOString(), name: c.name };
          if (c.phone) patch.phone = c.phone;
          must(await db.from("customers").update(patch).eq("id", existing.id).eq("business_id", businessId), "update customer");
          return existing.id;
        }
      } else if (c.phone) {
        const existing = must(
          await db.from("customers").select("id").eq("business_id", businessId).eq("phone", c.phone).is("email", null).limit(1).maybeSingle(),
          "find customer",
        ) as { id: string } | null;
        if (existing) {
          must(await db.from("customers").update({ last_seen: new Date().toISOString(), name: c.name }).eq("id", existing.id).eq("business_id", businessId), "update customer");
          return existing.id;
        }
      }
      const created = must(
        await db.from("customers").insert({ business_id: businessId, ...c }).select("id").single(),
        "create customer",
      ) as { id: string };
      return created.id;
    },
    async insertReservation(row) {
      return (must(await db.from("reservations").insert(row).select("id").single(), "save reservation") as { id: string }).id;
    },
    async insertEnquiry(row) {
      return (must(await db.from("enquiries").insert(row).select("id").single(), "save enquiry") as { id: string }).id;
    },
  };
}
