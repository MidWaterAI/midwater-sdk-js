/**
 * Webhook verification (server-side; uses node:crypto). Import from `@midwater/sdk/webhooks`.
 *
 * Midwater signs every delivery with the environment's signing secret (`whsec_…`, on the Developers page):
 * `Midwater-Signature: t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of `<t>.<raw body>`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./errors";
import type { WebhookEvent } from "./types";

export { WebhookVerificationError };
export type { WebhookEvent };

export const SIGNATURE_HEADER = "midwater-signature";
/** Sent with the same value as `Midwater-Signature` until launch; read only when the new header is absent. */
export const LEGACY_SIGNATURE_HEADER = "verdict-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export interface VerifyOptions {
  /** Maximum age (either direction) of the signature timestamp. Default 300 s. */
  toleranceSeconds?: number;
  /** Current time in seconds; for tests. */
  now?: number;
}

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** The signature header value for `payload`, as Midwater computes it. Useful in tests. */
export function sign(payload: string | Uint8Array, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(payload).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verifies a delivery and returns the parsed event. Throws {@link WebhookVerificationError} when it doesn't verify.
 *
 * `payload` must be the raw request body exactly as received (a string or bytes), not JSON you parsed and
 * re-serialized: any change to the bytes changes the signature.
 */
export function verify(payload: string | Uint8Array, headers: HeaderBag, secret: string, opts: VerifyOptions = {}): WebhookEvent {
  if (!secret) throw new WebhookVerificationError("no_secret", "No signing secret: pass your environment's whsec_… secret");
  const value = header(headers, SIGNATURE_HEADER) ?? header(headers, LEGACY_SIGNATURE_HEADER);
  if (!value) throw new WebhookVerificationError("missing_header", "No Midwater-Signature header");

  let t: string | undefined;
  const candidates: string[] = [];
  for (const part of value.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") candidates.push(v);
  }
  if (!t || !/^\d+$/.test(t) || candidates.length === 0) throw new WebhookVerificationError("malformed_header", "Midwater-Signature isn't t=<seconds>,v1=<hex>");

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(t)) > tolerance) throw new WebhookVerificationError("stale_timestamp", `Signature timestamp is more than ${tolerance} s from now`);

  const expected = createHmac("sha256", secret).update(`${t}.`).update(payload).digest();
  // Several v1 values may be present while a secret is rotated; any match passes. Compared in constant time.
  const ok = candidates.some((c) => /^[0-9a-f]{64}$/i.test(c) && timingSafeEqual(Buffer.from(c, "hex"), expected));
  if (!ok) throw new WebhookVerificationError("invalid_signature", "Signature doesn't match: wrong secret, or the body changed");

  const text = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
  return JSON.parse(text) as WebhookEvent;
}

/** `webhooks.verify(...)` and `webhooks.sign(...)`. */
export const webhooks = { verify, sign };
