import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fakeRepo, makeBusiness } from "./fake_repo.ts";
import { learn, type LearnDeps, type LearnStore, parseSuggestions, type SuggestionInput } from "../../supabase/functions/_shared/learn.ts";
import { HttpError } from "../../supabase/functions/_shared/http.ts";

function setup(opts: { manager?: boolean } = {}) {
  const a = makeBusiness();
  const { repo } = fakeRepo({ businesses: [a] });
  const convo = "00000000-0000-4000-8000-0000000000aa";
  const saved: SuggestionInput[] = [];
  const learned: string[] = [];
  const store: LearnStore = {
    canManage: async () => opts.manager ?? true,
    candidates: async (bid) => bid === a.id ? [{ id: convo, escalation_reason: "x" }, { id: "00000000-0000-4000-8000-0000000000ab", escalation_reason: "Monthly assistant limit reached" }] : [],
    messages: async () => [
      { role: "user", content: "Do you allow pets?", created_at: "" },
      { role: "staff", content: "Yes, small dogs under 10kg are welcome.", created_at: "" },
    ],
    insertSuggestions: async (rows) => { saved.push(...rows); },
    markLearned: async (_b, ids) => { learned.push(...ids); },
    businessesWithCandidates: async () => [a.id],
  };
  const prompts: string[] = [];
  const deps: LearnDeps = {
    repo, store, userId: "u1", env: (n) => (n === "ANTHROPIC_API_KEY" ? "k" : n === "LEARN_CRON_SECRET" ? "s3cret" : undefined),
    now: () => new Date("2026-11-22T10:00:00Z"),
    ai: async (cfg, req) => {
      prompts.push(req.messages[0].content);
      return { text: `\`\`\`json\n[{"conversation":"${convo}","category":"policy","title":"Are pets allowed?","content":"Small dogs under 10kg are welcome."},{"conversation":"bogus","category":"faq","title":"Injected","content":"x"}]\n\`\`\``, provider: cfg.provider, model: cfg.model, inputTokens: 1, outputTokens: 1, refused: false };
    },
  };
  return { a, convo, deps, saved, learned, prompts };
}

Deno.test("learn: drafts suggestions from escalated chats, as pending drafts for review", async () => {
  const { a, convo, deps, saved, learned, prompts } = setup();
  const r = await learn(deps, { business_id: a.id });
  assertEquals(r, { reviewed: 1, created: 1 });
  assertEquals(saved.length, 1, "a draft that points at a conversation we did not offer is dropped");
  assertEquals(saved[0].business_id, a.id);
  assertEquals(saved[0].source_conversation_id, convo);
  assertEquals(learned, [convo], "limit-reached chats are skipped, handled ones are marked");
  assert(prompts[0].includes("STAFF: Yes, small dogs"));
});

Deno.test("learn: AI failure leaves conversations to be retried", async () => {
  const { a, deps, learned } = setup();
  deps.ai = () => Promise.reject(new Error("down"));
  await assertRejects(() => learn(deps, { business_id: a.id }));
  assertEquals(learned.length, 0);
});

Deno.test("learn: needs a signed-in owner/admin of that business", async () => {
  const { a, deps } = setup({ manager: false });
  await assertRejects(() => learn(deps, { business_id: a.id }), HttpError, "owner or an admin");
  await assertRejects(() => learn({ ...deps, userId: null }, { business_id: a.id }), HttpError, "sign in");
});

Deno.test("learn: scheduled run needs the cron secret", async () => {
  const { deps } = setup();
  await assertRejects(() => learn({ ...deps, userId: null, cronSecret: "wrong" }, { all: true }), HttpError, "Not allowed");
  const r = await learn({ ...deps, userId: null, cronSecret: "s3cret" }, { all: true });
  assertEquals(r.created, 1);
});

Deno.test("learn: parser tolerates junk and caps results", () => {
  const ids = new Set(["c1"]);
  assertEquals(parseSuggestions("no json", ids), []);
  assertEquals(parseSuggestions("[not json]", ids), []);
  const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ conversation: "c1", category: "nope", title: "T" + i, content: "" })));
  const out = parseSuggestions(many, ids);
  assertEquals(out.length, 5);
  assertEquals(out[0].category, "faq");
});
