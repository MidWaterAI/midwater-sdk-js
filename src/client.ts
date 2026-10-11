import { APIConnectionError, errorFor, MidwaterError, WaitTimeoutError } from "./errors";
import type {
  AgentHealth,
  Conversation,
  ConversationAccepted,
  ConversationCreateParams,
  Feedback,
  FeedbackCreateParams,
  GroupHealth,
} from "./types";
import { VERSION } from "./version";

const KEY_SHAPE = /^(mw|vk)_(test|live)_/;
/** Retried: 408, 429 and every server error (plus network errors), on calls that are safe to repeat. */
const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;
/** The most retries any call makes, whatever `maxRetries` says. */
export const MAX_RETRIES_CAP = 3;

export interface MidwaterOptions {
  /** Required: pass it, or set `MIDWATER_API_KEY`. */
  apiKey?: string;
  /** Required: the base URL for your Midwater environment. Pass it, or set `MIDWATER_BASE_URL`. There's no default host. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Retries after the first attempt on 408, 429, 5xx and network errors, for calls safe to repeat. Default 2, at most 3. */
  maxRetries?: number;
  /** A fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Waits between retries; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  /** Sent as `Idempotency-Key`. Every POST the SDK makes sends one, generated when you don't pass it. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface InternalRequestOptions extends RequestOptions {
  /** Whether the call is safe to repeat. Default: GET only. */
  retry?: boolean;
}

export interface WaitOptions {
  /** Give up after this long. Default 60 000 ms. */
  timeoutMs?: number;
  /** Time between polls. Default 1 000 ms. */
  intervalMs?: number;
  signal?: AbortSignal;
}

function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name] || undefined;
}

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Node 18 has no global crypto.randomUUID by default; uniqueness is all an idempotency key needs.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Midwater API client.
 *
 * ```ts
 * const midwater = new Midwater(); // reads MIDWATER_API_KEY and MIDWATER_BASE_URL
 * const { id } = await midwater.conversations.create({ external_id: "call_8f2a91", channel: "voice", transcript });
 * const conversation = await midwater.conversations.wait(id);
 * ```
 */
export class Midwater {
  readonly baseUrl: string;
  readonly conversations: Conversations;
  readonly agents: Agents;
  readonly groups: Groups;
  /** `test` or `live`, from the key's prefix. */
  readonly environment: "test" | "live";

  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: MidwaterOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("MIDWATER_API_KEY");
    if (!apiKey) throw new MidwaterError("No API key. Set MIDWATER_API_KEY or pass { apiKey }.");
    const baseUrl = options.baseUrl ?? readEnv("MIDWATER_BASE_URL");
    if (!baseUrl) throw new MidwaterError("No base URL. Set MIDWATER_BASE_URL or pass { baseUrl }: the base URL for your Midwater environment.");
    const shape = KEY_SHAPE.exec(apiKey);
    if (!shape) throw new MidwaterError("That doesn't look like a Midwater API key: keys start mw_test_ or mw_live_.");
    this.#apiKey = apiKey;
    this.environment = shape[2] as "test" | "live";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = Math.min(MAX_RETRIES_CAP, Math.max(0, options.maxRetries ?? 2));
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new MidwaterError("No fetch implementation found. Use Node 18+ or pass { fetch }.");
    this.#fetch = f;
    this.#sleep = options.sleep ?? defaultSleep;
    this.conversations = new Conversations(this);
    this.agents = new Agents(this);
    this.groups = new Groups(this);
  }

  /** Keeps the key out of logs and console output. */
  toJSON() {
    return { baseUrl: this.baseUrl, environment: this.environment };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `Midwater { baseUrl: '${this.baseUrl}', environment: '${this.environment}' }`;
  }

  /**
   * Sends one request. GETs retry; POSTs send an idempotency key and retry only when `retry: true` says the
   * endpoint honours it. Exposed for endpoints the SDK doesn't wrap yet.
   */
  async request<T>(method: "GET" | "POST", path: string, body?: unknown, opts: InternalRequestOptions = {}): Promise<{ data: T; status: number; headers: Headers }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
      "user-agent": `midwater-js/${VERSION}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["idempotency-key"] = opts.idempotencyKey ?? newIdempotencyKey();
    const retryable = opts.retry ?? method === "GET";
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      const last = !retryable || attempt >= this.#maxRetries;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.#fetch(this.baseUrl + path, { method, headers, body: payload, signal: controller.signal });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (last) throw new APIConnectionError(`Couldn't reach Midwater at ${this.baseUrl}: ${(e as Error)?.message ?? e}`, e);
        await this.#sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON: keep the text */
      }
      if (res.ok) return { data: parsed as T, status: res.status, headers: res.headers };
      if (last || !retryableStatus(res.status)) throw errorFor(res.status, parsed, res.headers.get("midwater-request-id"));
      await this.#sleep(retryAfter(res.headers) ?? backoff(attempt));
    }
  }
}

/** 0.5 s, 1 s, 2 s, … capped at 8 s, with full jitter on the upper half. */
function backoff(attempt: number) {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

/** Midwater doesn't send Retry-After today; honoured when it does (seconds only), capped at 60 s. */
function retryAfter(h: Headers) {
  const v = h.get("retry-after");
  if (!v || !/^\d+(\.\d+)?$/.test(v)) return undefined;
  return Math.min(60_000, Number(v) * 1000);
}

const seg = (s: string) => encodeURIComponent(s);

export class Conversations {
  constructor(private readonly client: Midwater) {}

  /**
   * Sends a finished conversation. Resolves once Midwater has stored it (`status: "queued"`), before scoring.
   * An idempotency key is generated when you don't pass one, so retries never store the conversation twice.
   */
  async create(params: ConversationCreateParams, opts: RequestOptions = {}): Promise<ConversationAccepted> {
    // Safe to repeat: the same idempotency key goes with every retry, and the API honours it on this endpoint.
    const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
    const r = await this.client.request<Omit<ConversationAccepted, "replayed">>("POST", "/v1/conversations", params, { ...opts, idempotencyKey, retry: true });
    return { ...r.data, replayed: r.headers.get("idempotent-replayed") === "true" };
  }

  /** A conversation with its outcome and check results. `id` is Midwater's ID or your `external_id`. */
  async get(id: string, opts: Pick<RequestOptions, "signal"> = {}): Promise<Conversation> {
    return (await this.client.request<Conversation>("GET", `/v1/conversations/${seg(id)}`, undefined, opts)).data;
  }

  /** Polls until scoring finishes (`done` or `failed`) and returns the conversation. */
  async wait(id: string, opts: WaitOptions = {}): Promise<Conversation> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = await this.get(id, { signal: opts.signal });
      if (c.status === "done" || c.status === "failed") return c;
      if (Date.now() + intervalMs > deadline) throw new WaitTimeoutError(`Conversation ${id} was still ${c.status} after ${Math.round(timeoutMs / 1000)} s`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * Confirms or corrects one check's result on a conversation. Like every POST it sends an idempotency key (yours, or
   * a new one per call) and reuses it on its own retries, which the API honours (API 1.2.0), so a retry never records
   * the answer twice.
   */
  async feedback(id: string, params: FeedbackCreateParams, opts: RequestOptions = {}): Promise<Feedback> {
    const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
    const r = await this.client.request<Omit<Feedback, "replayed">>("POST", `/v1/conversations/${seg(id)}/feedback`, params, { ...opts, idempotencyKey, retry: true });
    return { ...r.data, replayed: r.headers.get("idempotent-replayed") === "true" };
  }
}

export class Agents {
  constructor(private readonly client: Midwater) {}

  /** The agent's health in the key's environment. `agentId` is the `agent.id` you send, or `default`. */
  async health(agentId: string, opts: Pick<RequestOptions, "signal"> = {}): Promise<AgentHealth> {
    return (await this.client.request<AgentHealth>("GET", `/v1/agents/${seg(agentId)}/health`, undefined, opts)).data;
  }
}

export class Groups {
  constructor(private readonly client: Midwater) {}

  /** The group's health: the worst of its agents, each agent's status, and totals. */
  async health(groupId: string, opts: Pick<RequestOptions, "signal"> = {}): Promise<GroupHealth> {
    return (await this.client.request<GroupHealth>("GET", `/v1/groups/${seg(groupId)}/health`, undefined, opts)).data;
  }
}

