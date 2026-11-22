// In-memory Repo used by the Edge Function tests. It enforces the same
// business_id scoping as the real repository, so isolation is exercised.
import type { BusinessRow, ConversationRow, MessageRow, Repo } from "../../supabase/functions/_shared/repo.ts";
import type { KnowledgeItem } from "../../supabase/functions/_shared/prompt.ts";

export interface Store {
  businesses: BusinessRow[];
  knowledge: (KnowledgeItem & { business_id: string })[];
  conversations: ConversationRow[];
  messages: (MessageRow & { conversation_id: string; business_id: string })[];
  usage: Record<string, unknown>[];
  customers: { id: string; business_id: string; name: string; email: string | null; phone: string | null }[];
  reservations: Record<string, unknown>[];
  enquiries: Record<string, unknown>[];
  hits: Map<string, number>;
  limit: number;
}

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

export function makeBusiness(over: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: id(), slug: "b" + n, name: "Test Hotel", type: "hotel", description: "A test hotel",
    email: "desk@test.example", phone: "+254700000000", timezone: "Africa/Nairobi", currency: "KES",
    status: "active", allowed_origins: [], branding: { assistant_name: "Zuri" }, ...over,
  };
}

export function fakeRepo(store: Partial<Store> = {}): { repo: Repo; s: Store } {
  const s: Store = {
    businesses: [], knowledge: [], conversations: [], messages: [], usage: [], customers: [],
    reservations: [], enquiries: [], hits: new Map(), limit: 1000, ...store,
  };
  const repo: Repo = {
    getBusiness: async (bid) => s.businesses.find((b) => b.id === bid) ?? null,
    getKnowledge: async (bid) => s.knowledge.filter((k) => k.business_id === bid),
    getAiSettings: async () => null,
    monthlyUsage: async (bid) => ({ used: s.usage.filter((u) => u.business_id === bid && u.success).length, limit: s.limit }),
    rateLimit: async (key, limit) => {
      const h = (s.hits.get(key) ?? 0) + 1;
      s.hits.set(key, h);
      return h <= limit;
    },
    findConversation: async (cid, bid, vid) =>
      s.conversations.find((c) => c.id === cid && c.business_id === bid && c.visitor_id === vid) ?? null,
    createConversation: async (bid, vid) => {
      const c: ConversationRow = { id: id(), business_id: bid, visitor_id: vid, customer_id: null, status: "open", message_count: 0 };
      s.conversations.push(c);
      return c;
    },
    recentMessages: async (cid, bid, limit) =>
      s.messages.filter((m) => m.conversation_id === cid && m.business_id === bid).slice(-limit),
    insertMessage: async (cid, bid, role, content) => {
      s.messages.push({ conversation_id: cid, business_id: bid, role, content, created_at: new Date().toISOString() });
    },
    updateConversation: async (cid, bid, patch) => {
      const c = s.conversations.find((x) => x.id === cid && x.business_id === bid);
      if (c) Object.assign(c, patch);
    },
    logUsage: async (row) => { s.usage.push(row); },
    upsertCustomer: async (bid, c) => {
      const found = s.customers.find((x) => x.business_id === bid && c.email && x.email === c.email);
      if (found) return found.id;
      const row = { id: id(), business_id: bid, ...c };
      s.customers.push(row);
      return row.id;
    },
    insertReservation: async (row) => { const rid = id(); s.reservations.push({ id: rid, ...row }); return rid; },
    insertEnquiry: async (row) => { const eid = id(); s.enquiries.push({ id: eid, ...row }); return eid; },
  };
  return { repo, s };
}
