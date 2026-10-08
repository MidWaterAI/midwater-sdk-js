import { afterEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { Midwater } from "../../src/index";
import { fixture } from "./fixtures";

const KEY = `mw_live_${"s3cr3t".repeat(6)}`;

describe("the API key never appears in any log", () => {
  const captured: string[] = [];
  afterEach(() => vi.restoreAllMocks());

  it("through a full flow with retries, errors and a connection failure", async () => {
    for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void captured.push(a.map((x) => inspect(x)).join(" ")));
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => (captured.push(String(c)), true));
    const err = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => (captured.push(String(c)), true));

    const replies = [
      new Response(JSON.stringify({}), { status: 503 }),
      new Response(JSON.stringify(fixture("conversation-accepted.json")), { status: 202 }),
      new Response(JSON.stringify(fixture("conversation.json")), { status: 200 }),
      new Response(JSON.stringify(fixture("feedback.json")), { status: 200 }),
      new Response(JSON.stringify(fixture("agent-health.json")), { status: 200 }),
      new Response(JSON.stringify(fixture("errors.json").authentication_error.body), { status: 401 }),
      new Response(JSON.stringify(fixture("errors.json").validation_error.body), { status: 422 }),
    ];
    const fetchImpl = (async () => {
      const r = replies.shift();
      if (!r) throw new TypeError("connect ECONNREFUSED");
      return r;
    }) as unknown as typeof fetch;
    const m = new Midwater({ apiKey: KEY, baseUrl: "https://api.example.test", fetch: fetchImpl, sleep: async () => {}, maxRetries: 1 });
    const errors: unknown[] = [];
    const accepted = await m.conversations.create(fixture("conversation-create.json"));
    const conv = await m.conversations.wait(accepted.id);
    await m.conversations.feedback(conv.external_id, fixture("feedback-create.json"));
    await m.agents.health("front-desk");
    for (const p of [m.conversations.get("x"), m.conversations.create(fixture("conversation-create.json"), { idempotencyKey: "a" }), m.agents.health("y")])
      errors.push(await p.catch((e) => e));
    console.log(m, errors);
    console.error(...errors);
    out.mockRestore();
    err.mockRestore();

    expect(errors).toHaveLength(3);
    const everything = [
      ...captured,
      inspect(m, { depth: 5, showHidden: true }),
      JSON.stringify(m),
      ...errors.map((e) => `${String(e)} ${(e as Error).stack} ${inspect(e, { depth: 5, showHidden: true })} ${JSON.stringify(e)}`),
    ].join("\n");
    expect(everything.length).toBeGreaterThan(100);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("s3cr3ts3cr3t");
  });
});
