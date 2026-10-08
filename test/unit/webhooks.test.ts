import { describe, expect, it } from "vitest";
import { sign, verify, verifyWebhook, webhooks, WebhookVerificationError } from "../../src/webhooks";
import { fixture } from "./fixtures";

type Case = { name: string; header: string | null; body?: string; valid: boolean; reason?: string };
const vectors = fixture<{ secret: string; body: string; now: number; tolerance_seconds: number; cases: Case[] }>("webhook-vectors.json");
const byName = (n: string) => vectors.cases.find((c) => c.name === n)!;
const run = (c: Case) => verifyWebhook(c.body ?? vectors.body, c.header === null ? {} : { "Midwater-Signature": c.header }, vectors.secret, { now: vectors.now, toleranceSeconds: vectors.tolerance_seconds });
const reasonOf = (c: Case) => { try { run(c); return "valid"; } catch (e) { expect(e).toBeInstanceOf(WebhookVerificationError); return (e as WebhookVerificationError).reason; } };

describe("verifyWebhook: the five required cases", () => {
  it("accepts a good payload", () => expect(run(byName("valid"))).toMatchObject({ type: "conversation.evaluated", environment: "live" }));
  it("rejects a tampered body", () => expect(reasonOf(byName("tampered_body"))).toBe("invalid_signature"));
  it("rejects a wrong secret", () => expect(reasonOf(byName("wrong_secret"))).toBe("invalid_signature"));
  it("rejects a stale timestamp", () => expect(reasonOf(byName("stale_timestamp"))).toBe("stale_timestamp"));
  it("accepts two v1= values when one matches", () => expect(run(byName("valid_with_rotated_second_v1")).id).toBe("evt_a1b2c3d4e5"));
});

describe("verifyWebhook against every shared vector", () => {
  for (const c of vectors.cases) it(c.name, () => expect(reasonOf(c)).toBe(c.valid ? "valid" : c.reason));
});

describe("webhooks", () => {
  const secret = "whsec_unit_test_only";
  const body = JSON.stringify({ id: "evt_1", type: "test", environment: "test", created_at: "2026-10-08T00:00:00Z", data: { message: "hi" } });

  it("signs the way it verifies, for strings and bytes", () => {
    const header = sign(body, secret, 1000);
    expect(verify(body, { "midwater-signature": header }, secret, { now: 1000 })).toMatchObject({ type: "test" });
    expect(verify(new TextEncoder().encode(body), { "Midwater-Signature": [header] }, secret, { now: 1000 }).id).toBe("evt_1");
  });

  it("signs with the current time by default and verifies within the default tolerance", () => {
    expect(webhooks.verify(body, { "midwater-signature": webhooks.sign(body, secret) }, secret).type).toBe("test");
  });

  it("reads a Headers object, case-insensitively", () => {
    const h = new Headers({ "MIDWATER-SIGNATURE": sign(body, secret, 1000) });
    expect(webhooks.verify(body, h, secret, { now: 1000 }).type).toBe("test");
  });

  it("needs a secret", () => {
    expect(() => verify(body, { "midwater-signature": sign(body, secret) }, "")).toThrow(/signing secret/);
  });

  it("rejects re-serialized JSON", () => {
    const header = sign(body, secret, 1000);
    expect(() => verify(JSON.stringify(JSON.parse(body), null, 2), { "midwater-signature": header }, secret, { now: 1000 })).toThrow(/doesn't match/);
  });

  it("skips header parts without a value", () => {
    const header = `junk,${sign(body, secret, 1000)}`;
    expect(verify(body, { "midwater-signature": header }, secret, { now: 1000 }).id).toBe("evt_1");
  });
});
