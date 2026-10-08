import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  Midwater,
  MidwaterError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
  WaitTimeoutError,
} from "../../src/index";

const KEY = `mw_test_${"k".repeat(32)}`;

type Call = { url: string; init: RequestInit };
function mockFetch(responses: (Response | Error | (() => Response))[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const client = (f: typeof fetch, extra = {}) => new Midwater({ apiKey: KEY, baseUrl: "https://api.example.test/", fetch: f, sleep: async () => {}, ...extra });
const headersOf = (c: Call) => c.init.headers as Record<string, string>;
const conv = { external_id: "call_1", channel: "voice" as const, transcript: [{ speaker: "user" as const, text: "Hi" }] };

describe("construction", () => {
  it("reads MIDWATER_API_KEY and MIDWATER_BASE_URL", () => {
    vi.stubEnv("MIDWATER_API_KEY", KEY);
    vi.stubEnv("MIDWATER_BASE_URL", "http://localhost:3200/");
    const m = new Midwater({ fetch: vi.fn() as unknown as typeof fetch });
    expect(m.baseUrl).toBe("http://localhost:3200");
    expect(m.environment).toBe("test");
    vi.unstubAllEnvs();
  });

  it("defaults to the production host", () => {
    vi.stubEnv("MIDWATER_BASE_URL", "");
    expect(new Midwater({ apiKey: KEY, fetch: vi.fn() as unknown as typeof fetch }).baseUrl).toBe("https://api.midwater.ai");
    vi.unstubAllEnvs();
  });

  it("needs a key, of the right shape, and never repeats it", () => {
    vi.stubEnv("MIDWATER_API_KEY", "");
    expect(() => new Midwater({ fetch: vi.fn() as unknown as typeof fetch })).toThrow(/MIDWATER_API_KEY/);
    vi.unstubAllEnvs();
    const bad = "sk_live_supersecretvalue123";
    try {
      new Midwater({ apiKey: bad });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MidwaterError);
      expect(String((e as Error).message)).not.toContain(bad);
    }
  });

  it("accepts live keys and keys made before October 2026", () => {
    expect(new Midwater({ apiKey: `mw_live_${"a".repeat(30)}`, fetch: vi.fn() as unknown as typeof fetch }).environment).toBe("live");
    expect(new Midwater({ apiKey: `vk_test_${"a".repeat(30)}`, fetch: vi.fn() as unknown as typeof fetch }).environment).toBe("test");
  });

  it("keeps the key out of JSON and inspect output", () => {
    const m = client(vi.fn() as unknown as typeof fetch);
    expect(JSON.stringify(m)).not.toContain(KEY);
    expect(inspect(m)).not.toContain(KEY);
  });
});

describe("conversations.create", () => {
  it("posts the conversation with auth, JSON and a generated idempotency key", async () => {
    const { fetch, calls } = mockFetch([json(202, { id: "c1", status: "queued" })]);
    const r = await client(fetch).conversations.create(conv);
    expect(r).toEqual({ id: "c1", status: "queued", replayed: false });
    expect(calls[0]!.url).toBe("https://api.example.test/v1/conversations");
    expect(calls[0]!.init.method).toBe("POST");
    const h = headersOf(calls[0]!);
    expect(h.authorization).toBe(`Bearer ${KEY}`);
    expect(h["content-type"]).toBe("application/json");
    expect(h["user-agent"]).toMatch(/^midwater-js\//);
    expect(h["idempotency-key"]).toMatch(/.{8,}/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(conv);
  });

  it("uses the caller's idempotency key and reports replays and duplicates", async () => {
    const { fetch, calls } = mockFetch([json(200, { id: "c1", status: "done", duplicate: true }, { "idempotent-replayed": "true" })]);
    const r = await client(fetch).conversations.create(conv, { idempotencyKey: "call_1" });
    expect(headersOf(calls[0]!)["idempotency-key"]).toBe("call_1");
    expect(r).toEqual({ id: "c1", status: "done", duplicate: true, replayed: true });
  });

  it("retries 503 with the same idempotency key, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const { fetch, calls } = mockFetch([json(503, { error: { type: "server_error", message: "x" } }), json(202, { id: "c1", status: "queued" })]);
    await client(fetch, { sleep }).conversations.create(conv);
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[0]!)["idempotency-key"]).toBe(headersOf(calls[1]!)["idempotency-key"]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries network errors and gives up with APIConnectionError", async () => {
    const { fetch, calls } = mockFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    await expect(client(fetch).conversations.create(conv)).rejects.toBeInstanceOf(APIConnectionError);
    expect(calls).toHaveLength(3);
  });

  it("honours a numeric Retry-After on 429", async () => {
    const sleep = vi.fn(async () => {});
    const { fetch } = mockFetch([json(429, { error: { type: "rate_limited", message: "slow down" } }, { "retry-after": "3" }), json(202, { id: "c1", status: "queued" })]);
    await client(fetch, { sleep }).conversations.create(conv);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("raises RateLimitError when 429 persists", async () => {
    const { fetch } = mockFetch([0, 1, 2].map(() => json(429, { error: { type: "rate_limited", message: "slow down" } })));
    await expect(client(fetch).conversations.create(conv)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("doesn't retry a 422, and exposes the field errors", async () => {
    const body = { error: { type: "validation_error", message: "The conversation payload is invalid", fields: { channel: ["bad"] } } };
    const { fetch, calls } = mockFetch([json(422, body)]);
    const err = await client(fetch).conversations.create(conv).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ status: 422, type: "validation_error", fields: { channel: ["bad"] }, message: "The conversation payload is invalid" });
    expect(calls).toHaveLength(1);
  });

  it("respects maxRetries: 0", async () => {
    const { fetch, calls } = mockFetch([json(500, { error: { type: "server_error", message: "x" } })]);
    await expect(client(fetch, { maxRetries: 0 }).conversations.create(conv)).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });
});

describe("errors", () => {
  const cases: [number, unknown, new (...a: never[]) => APIError][] = [
    [400, { error: { type: "invalid_json", message: "Body must be valid JSON" } }, ValidationError],
    [401, { error: { type: "authentication_error", message: "Missing or invalid API key." } }, AuthenticationError],
    [404, { error: { type: "not_found", message: "Conversation not found" } }, NotFoundError],
    [409, { error: { type: "conflict", message: "x" } }, APIError],
  ];
  for (const [status, body, cls] of cases)
    it(`maps ${status}`, async () => {
      const { fetch } = mockFetch([json(status, body)]);
      const err = await client(fetch).conversations.get("x").catch((e) => e);
      expect(err).toBeInstanceOf(cls);
      expect(err.status).toBe(status);
      expect(err.type).toBe((body as { error: { type: string } }).error.type);
    });

  it("handles a non-JSON error body", async () => {
    const { fetch } = mockFetch([new Response("<html>Bad gateway</html>", { status: 502 }), new Response("<html>Bad gateway</html>", { status: 502 }), new Response("<html>Bad gateway</html>", { status: 502 })]);
    const err = await client(fetch).conversations.get("x").catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 502, type: "unknown", message: "HTTP 502", body: "<html>Bad gateway</html>" });
  });

  it("never puts the key in an error message", async () => {
    const { fetch } = mockFetch([json(401, { error: { type: "authentication_error", message: "Missing or invalid API key." } })]);
    const err = await client(fetch).conversations.get("x").catch((e) => e);
    expect(`${err.message} ${err.stack}`).not.toContain(KEY);
  });
});

describe("reads", () => {
  it("URL-encodes ids", async () => {
    const { fetch, calls } = mockFetch([json(200, { id: "c" }), json(200, {}), json(200, {}), json(200, {})]);
    const m = client(fetch);
    await m.conversations.get("call/with space");
    await m.agents.health("brightsmile-dental:receptionist-v3");
    await m.groups.health("north east");
    await m.conversations.feedback("call_1", { check_key: "need_unresolved", verdict: "fail", note: "n" });
    expect(calls.map((c) => c.url.replace("https://api.example.test", ""))).toEqual([
      "/v1/conversations/call%2Fwith%20space",
      "/v1/agents/brightsmile-dental%3Areceptionist-v3/health",
      "/v1/groups/north%20east/health",
      "/v1/conversations/call_1/feedback",
    ]);
    expect(calls[0]!.init.method).toBe("GET");
    expect(headersOf(calls[0]!)["content-type"]).toBeUndefined();
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ check_key: "need_unresolved", verdict: "fail", note: "n" });
  });

  it("retries GETs without an idempotency key", async () => {
    const { fetch, calls } = mockFetch([json(503, {}), json(200, { id: "c" })]);
    await client(fetch).conversations.get("c");
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[0]!)["idempotency-key"]).toBeUndefined();
  });

  it("doesn't retry feedback (not idempotent)", async () => {
    const { fetch, calls } = mockFetch([json(503, {})]);
    await expect(client(fetch).conversations.feedback("c", { check_key: "k", verdict: "pass" })).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });
});

describe("conversations.wait", () => {
  it("polls until done", async () => {
    const { fetch, calls } = mockFetch([json(200, { id: "c", status: "queued" }), json(200, { id: "c", status: "evaluating" }), json(200, { id: "c", status: "done", results: [] })]);
    const c = await client(fetch).conversations.wait("c", { intervalMs: 1 });
    expect(c.status).toBe("done");
    expect(calls).toHaveLength(3);
  });

  it("returns failed conversations too", async () => {
    const { fetch } = mockFetch([json(200, { id: "c", status: "failed" })]);
    expect((await client(fetch).conversations.wait("c")).status).toBe("failed");
  });

  it("times out", async () => {
    const { fetch } = mockFetch(Array.from({ length: 50 }, () => () => json(200, { id: "c", status: "queued" })));
    await expect(client(fetch).conversations.wait("c", { timeoutMs: 20, intervalMs: 5 })).rejects.toBeInstanceOf(WaitTimeoutError);
  });
});
