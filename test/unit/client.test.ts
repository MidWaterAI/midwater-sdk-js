import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  IdempotencyConflictError,
  MAX_RETRIES_CAP,
  MethodNotAllowedError,
  Midwater,
  MidwaterError,
  NotFoundError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
  ServiceUnavailableError,
  ValidationError,
  WaitTimeoutError,
} from "../../src/index";
import { fixture } from "./fixtures";
import type { Conversation, DecidedBy, Outcome } from "../../src/index";

const KEY = `mw_test_${"k".repeat(32)}`;
const BASE = "https://api.example.test";

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
const client = (f: typeof fetch, extra = {}) => new Midwater({ apiKey: KEY, baseUrl: `${BASE}/`, fetch: f, sleep: async () => {}, ...extra });
const headersOf = (c: Call) => c.init.headers as Record<string, string>;
const conv = fixture("conversation-create.json");
const noFetch = vi.fn() as unknown as typeof fetch;

describe("construction", () => {
  it("reads MIDWATER_API_KEY and MIDWATER_BASE_URL", () => {
    vi.stubEnv("MIDWATER_API_KEY", KEY);
    vi.stubEnv("MIDWATER_BASE_URL", "http://localhost:3200/");
    const m = new Midwater({ fetch: noFetch });
    expect(m.baseUrl).toBe("http://localhost:3200");
    expect(m.environment).toBe("test");
    vi.unstubAllEnvs();
  });

  it("requires a base URL: there is no default host", () => {
    vi.stubEnv("MIDWATER_BASE_URL", "");
    expect(() => new Midwater({ apiKey: KEY, fetch: noFetch })).toThrow(/MIDWATER_BASE_URL/);
    vi.unstubAllEnvs();
  });

  it("requires a key, of the right shape, and never repeats it", () => {
    vi.stubEnv("MIDWATER_API_KEY", "");
    expect(() => new Midwater({ baseUrl: BASE, fetch: noFetch })).toThrow(/MIDWATER_API_KEY/);
    vi.unstubAllEnvs();
    const bad = "sk_live_supersecretvalue123";
    const err = (() => { try { new Midwater({ apiKey: bad, baseUrl: BASE }); } catch (e) { return e as Error; } })();
    expect(err).toBeInstanceOf(MidwaterError);
    expect(err!.message).not.toContain(bad);
  });

  it("accepts live keys and older keys", () => {
    expect(new Midwater({ apiKey: `mw_live_${"a".repeat(30)}`, baseUrl: BASE, fetch: noFetch }).environment).toBe("live");
    expect(new Midwater({ apiKey: `vk_test_${"a".repeat(30)}`, baseUrl: BASE, fetch: noFetch }).environment).toBe("test");
  });

  it("needs fetch", () => {
    const real = globalThis.fetch;
    // @ts-expect-error simulate a runtime without fetch
    delete globalThis.fetch;
    try {
      expect(() => new Midwater({ apiKey: KEY, baseUrl: BASE })).toThrow(/fetch/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("keeps the key out of JSON and inspect output", () => {
    const m = client(noFetch);
    expect(JSON.stringify(m)).not.toContain(KEY);
    expect(inspect(m)).not.toContain(KEY);
    expect(m.toJSON()).toEqual({ baseUrl: BASE, environment: "test" });
  });
});

describe("conversations.create", () => {
  it("posts the fixture conversation with auth, JSON and a generated idempotency key", async () => {
    const { fetch, calls } = mockFetch([json(202, fixture("conversation-accepted.json"))]);
    const r = await client(fetch).conversations.create(conv);
    expect(r).toEqual({ ...fixture("conversation-accepted.json"), replayed: false });
    expect(calls[0]!.url).toBe(`${BASE}/v1/conversations`);
    expect(calls[0]!.init.method).toBe("POST");
    const h = headersOf(calls[0]!);
    expect(h.authorization).toBe(`Bearer ${KEY}`);
    expect(h["content-type"]).toBe("application/json");
    expect(h.accept).toBe("application/json");
    expect(h["user-agent"]).toMatch(/^midwater-js\/\d/);
    expect(h["idempotency-key"]).toMatch(/.{8,}/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(conv);
  });

  it("generates a different key per call", async () => {
    const { fetch, calls } = mockFetch([json(202, fixture("conversation-accepted.json")), json(202, fixture("conversation-accepted.json"))]);
    const m = client(fetch);
    await m.conversations.create(conv);
    await m.conversations.create(conv);
    expect(headersOf(calls[0]!)["idempotency-key"]).not.toBe(headersOf(calls[1]!)["idempotency-key"]);
  });

  it("uses the caller's idempotency key and reports replays and duplicates", async () => {
    const { fetch, calls } = mockFetch([json(200, fixture("conversation-duplicate.json"), { "idempotent-replayed": "true" })]);
    const r = await client(fetch).conversations.create(conv, { idempotencyKey: "call_8f2a91" });
    expect(headersOf(calls[0]!)["idempotency-key"]).toBe("call_8f2a91");
    expect(r).toEqual({ ...fixture("conversation-duplicate.json"), replayed: true });
  });

  for (const status of [408, 429, 500, 502, 503, 504, 599])
    it(`retries ${status} with the same idempotency key, then succeeds`, async () => {
      const sleep = vi.fn(async () => {});
      const { fetch, calls } = mockFetch([json(status, { error: { type: "x", message: "x" } }), json(202, fixture("conversation-accepted.json"))]);
      await client(fetch, { sleep }).conversations.create(conv);
      expect(calls).toHaveLength(2);
      expect(headersOf(calls[0]!)["idempotency-key"]).toBe(headersOf(calls[1]!)["idempotency-key"]);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

  it("retries network errors and gives up with APIConnectionError", async () => {
    const { fetch, calls } = mockFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const err = await client(fetch).conversations.create(conv).catch((e) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(3);
  });

  it("times out an attempt and retries it", async () => {
    let n = 0;
    const slow = vi.fn((_url: string, init: RequestInit) => {
      n++;
      if (n === 1) return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return Promise.resolve(json(202, fixture("conversation-accepted.json")));
    }) as unknown as typeof fetch;
    const r = await client(slow, { timeoutMs: 10 }).conversations.create(conv);
    expect(r.id).toBe(fixture("conversation-accepted.json").id);
    expect(n).toBe(2);
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const p = client(hang).conversations.create(conv, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it("honours a numeric Retry-After, capped at 60 s", async () => {
    const sleep = vi.fn(async () => {});
    const { fetch } = mockFetch([
      json(429, { error: { type: "rate_limited", message: "slow down" } }, { "retry-after": "3" }),
      json(503, { error: { type: "service_unavailable", message: "x" } }, { "retry-after": "600" }),
      json(202, fixture("conversation-accepted.json")),
    ]);
    await client(fetch, { sleep }).conversations.create(conv);
    expect(sleep).toHaveBeenNthCalledWith(1, 3000);
    expect(sleep).toHaveBeenNthCalledWith(2, 60_000);
  });

  it("ignores a non-numeric Retry-After and backs off instead", async () => {
    const sleep = vi.fn(async () => {});
    const { fetch } = mockFetch([json(429, {}, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), json(202, fixture("conversation-accepted.json"))]);
    await client(fetch, { sleep }).conversations.create(conv);
    const ms = (sleep.mock.calls[0] as unknown as [number])[0];
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThanOrEqual(500);
  });

  it("raises RateLimitError when 429 persists", async () => {
    const { fetch } = mockFetch([0, 1, 2].map(() => json(429, fixture("errors.json").rate_limited.body)));
    await expect(client(fetch).conversations.create(conv)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("never retries more than 3 times", async () => {
    expect(MAX_RETRIES_CAP).toBe(3);
    const { fetch, calls } = mockFetch(Array.from({ length: 10 }, () => () => json(500, {})));
    await expect(client(fetch, { maxRetries: 10 }).conversations.create(conv)).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(4);
  });

  it("respects maxRetries: 0", async () => {
    const { fetch, calls } = mockFetch([json(500, fixture("errors.json").server_error.body)]);
    await expect(client(fetch, { maxRetries: 0 }).conversations.create(conv)).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });

  for (const status of [400, 401, 403, 404, 405, 409, 413, 422])
    it(`doesn't retry ${status}`, async () => {
      const { fetch, calls } = mockFetch([json(status, { error: { type: "x", message: "x" } })]);
      await expect(client(fetch).conversations.create(conv)).rejects.toBeInstanceOf(APIError);
      expect(calls).toHaveLength(1);
    });
});

describe("errors, from the shared fixtures", () => {
  const expected: Record<string, new (...a: never[]) => APIError> = {
    invalid_json: ValidationError,
    authentication_error: AuthenticationError,
    permission_denied: PermissionDeniedError,
    not_found: NotFoundError,
    method_not_allowed: MethodNotAllowedError,
    idempotency_conflict: IdempotencyConflictError,
    payload_too_large: PayloadTooLargeError,
    validation_error: ValidationError,
    rate_limited: RateLimitError,
    server_error: ServerError,
    service_unavailable: ServiceUnavailableError,
  };
  const errors = fixture<Record<string, { status: number; body: { error: { type: string; message: string; request_id?: string; fields?: object } } }>>("errors.json");

  it("covers every error type in the contract", () => {
    expect(Object.keys(errors).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [type, e] of Object.entries(errors))
    it(`maps ${e.status} ${type}`, async () => {
      const { fetch } = mockFetch([json(e.status, e.body), json(e.status, e.body), json(e.status, e.body)]);
      const err = await client(fetch).conversations.get("x").catch((x) => x);
      expect(err).toBeInstanceOf(expected[type]);
      expect(err).toMatchObject({ status: e.status, type, message: e.body.error.message, requestId: e.body.error.request_id });
      if (e.body.error.fields) expect(err.fields).toEqual(e.body.error.fields);
    });

  it("reads the request ID from the Midwater-Request-Id header when the body has none", async () => {
    const { fetch } = mockFetch([json(404, errors.not_found!.body, { "midwater-request-id": "req_header" })]);
    expect(await client(fetch).conversations.get("x").catch((e) => e.requestId)).toBe("req_header");
  });

  it("maps unknown statuses by class", async () => {
    const { fetch } = mockFetch([json(418, { error: { type: "teapot", message: "no" } })]);
    const err = await client(fetch).conversations.get("x").catch((e) => e);
    expect(err.constructor).toBe(APIError);
    expect(err.type).toBe("teapot");
    const r = mockFetch([0, 1, 2].map(() => json(507, { error: { type: "brand_new_type", message: "x" } })));
    expect(await client(r.fetch).conversations.get("x").catch((e) => e)).toBeInstanceOf(ServerError);
  });

  it("handles a non-JSON error body", async () => {
    const html = () => new Response("<html>Bad gateway</html>", { status: 502 });
    const { fetch } = mockFetch([html, html, html]);
    const err = await client(fetch).conversations.get("x").catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 502, type: "unknown", message: "HTTP 502", body: "<html>Bad gateway</html>", requestId: undefined });
  });

  it("maps 408 to RequestTimeoutError after retries", async () => {
    const { fetch } = mockFetch([0, 1, 2].map(() => json(408, {})));
    expect(await client(fetch).conversations.get("x").catch((e) => e)).toBeInstanceOf(RequestTimeoutError);
  });
});

describe("reads and feedback", () => {
  it("returns the fixtures and URL-encodes ids", async () => {
    const { fetch, calls } = mockFetch([json(200, fixture("conversation.json")), json(200, fixture("agent-health.json")), json(200, fixture("group-health.json")), json(200, fixture("feedback.json"))]);
    const m = client(fetch);
    expect(await m.conversations.get("call/with space")).toEqual(fixture("conversation.json"));
    expect(await m.agents.health("brightsmile-dental:receptionist-v3")).toEqual(fixture("agent-health.json"));
    expect(await m.groups.health("north east")).toEqual(fixture("group-health.json"));
    expect(await m.conversations.feedback("call_1", fixture("feedback-create.json"))).toEqual(fixture("feedback.json"));
    expect(calls.map((c) => c.url.replace(BASE, ""))).toEqual([
      "/v1/conversations/call%2Fwith%20space",
      "/v1/agents/brightsmile-dental%3Areceptionist-v3/health",
      "/v1/groups/north%20east/health",
      "/v1/conversations/call_1/feedback",
    ]);
    expect(calls[0]!.init.method).toBe("GET");
    expect(headersOf(calls[0]!)["content-type"]).toBeUndefined();
    expect(headersOf(calls[0]!)["idempotency-key"]).toBeUndefined();
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual(fixture("feedback-create.json"));
  });

  it("retries GETs", async () => {
    const { fetch, calls } = mockFetch([json(503, {}), json(200, fixture("conversation.json"))]);
    await client(fetch).conversations.get("c");
    expect(calls).toHaveLength(2);
  });

  it("sends an idempotency key with feedback, yours or a generated one, but doesn't retry it", async () => {
    const { fetch, calls } = mockFetch([json(503, {}), json(200, fixture("feedback.json"))]);
    const m = client(fetch);
    await expect(m.conversations.feedback("c", fixture("feedback-create.json"))).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]!)["idempotency-key"]).toMatch(/.{8,}/);
    await m.conversations.feedback("c", fixture("feedback-create.json"), { idempotencyKey: "fb-1" });
    expect(headersOf(calls[1]!)["idempotency-key"]).toBe("fb-1");
  });
});

describe("conversations.wait", () => {
  it("polls until done", async () => {
    const done = fixture("conversation.json");
    const { fetch, calls } = mockFetch([json(200, { ...done, status: "queued" }), json(200, { ...done, status: "evaluating" }), json(200, done)]);
    const c = await client(fetch).conversations.wait("c", { intervalMs: 1 });
    expect(c).toEqual(done);
    expect(calls).toHaveLength(3);
  });

  it("returns failed conversations too", async () => {
    const { fetch } = mockFetch([json(200, { ...fixture<object>("conversation.json"), status: "failed" })]);
    expect((await client(fetch).conversations.wait("c")).status).toBe("failed");
  });

  it("times out", async () => {
    const { fetch } = mockFetch(Array.from({ length: 50 }, () => () => json(200, { id: "c", status: "queued" })));
    await expect(client(fetch).conversations.wait("c", { timeoutMs: 20, intervalMs: 5 })).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it("uses the default timing", async () => {
    const { fetch } = mockFetch([json(200, fixture("conversation.json"))]);
    expect((await client(fetch).conversations.wait("c")).status).toBe("done");
  });
});

describe("planned value renames (A7)", () => {
  it("types accept old and new names, and they pass through untouched", async () => {
    const base = fixture<Conversation>("conversation.json");
    const outcomes: Outcome[] = ["escalated", "handed_to_person", "not_real_inquiry", "not_customer_call"];
    const deciders: DecidedBy[] = ["llm_judge", "second_review"];
    for (const outcome of outcomes)
      for (const decided_by of deciders) {
        const body = { ...base, outcome, results: [{ ...base.results[0]!, decided_by }] };
        const { fetch } = mockFetch([json(200, body)]);
        const c = await client(fetch).conversations.get("c");
        expect(c.outcome).toBe(outcome);
        expect(c.results[0]!.decided_by).toBe(decided_by);
      }
  });
});

describe("scorer_version", () => {
  it("passes null through (nothing scored the result)", async () => {
    const base = fixture<Conversation>("conversation.json");
    const { fetch } = mockFetch([json(200, { ...base, results: [{ ...base.results[0]!, scorer_version: null }] })]);
    const c = await client(fetch).conversations.get("c");
    expect(c.results[0]!.scorer_version).toBeNull();
  });
});

