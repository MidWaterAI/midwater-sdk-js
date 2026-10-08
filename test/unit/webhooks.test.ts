import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sign, verify, webhooks, WebhookVerificationError } from "../../src/webhooks";

type Case = { name: string; header: string | null; body?: string; valid: boolean; reason?: string };
const vectors = JSON.parse(readFileSync(new URL("../fixtures/webhook-vectors.json", import.meta.url), "utf8")) as {
  secret: string; body: string; now: number; tolerance_seconds: number; cases: Case[];
};

describe("webhooks.verify against the shared vectors", () => {
  for (const c of vectors.cases)
    it(c.name, () => {
      const headers = c.header === null ? {} : { "Midwater-Signature": c.header };
      const run = () => verify(c.body ?? vectors.body, headers, vectors.secret, { now: vectors.now, toleranceSeconds: vectors.tolerance_seconds });
      if (c.valid) expect(run()).toMatchObject({ type: "conversation.evaluated", environment: "live" });
      else {
        const err = (() => { try { run(); } catch (e) { return e; } })() as WebhookVerificationError;
        expect(err).toBeInstanceOf(WebhookVerificationError);
        expect(err.reason).toBe(c.reason);
      }
    });
});

describe("webhooks", () => {
  const secret = "whsec_unit_test_only";
  const body = JSON.stringify({ id: "evt_1", type: "test", environment: "test", created_at: "2026-10-08T00:00:00Z", data: { message: "hi" } });

  it("signs the way it verifies, for strings and bytes", () => {
    const header = sign(body, secret, 1000);
    expect(verify(body, { "midwater-signature": header }, secret, { now: 1000 })).toMatchObject({ type: "test" });
    expect(verify(new TextEncoder().encode(body), { "Midwater-Signature": header }, secret, { now: 1000 }).id).toBe("evt_1");
  });

  it("reads a Headers object, case-insensitively", () => {
    const h = new Headers({ "MIDWATER-SIGNATURE": sign(body, secret, 1000) });
    expect(webhooks.verify(body, h, secret, { now: 1000 }).type).toBe("test");
  });

  it("falls back to the legacy header only when Midwater-Signature is absent", () => {
    expect(verify(body, { "verdict-signature": sign(body, secret, 1000) }, secret, { now: 1000 }).type).toBe("test");
    expect(() => verify(body, { "midwater-signature": sign(body, "whsec_wrong", 1000), "verdict-signature": sign(body, secret, 1000) }, secret, { now: 1000 })).toThrow(WebhookVerificationError);
  });

  it("needs a secret", () => {
    expect(() => verify(body, { "midwater-signature": sign(body, secret) }, "")).toThrow(/signing secret/);
  });

  it("rejects re-serialized JSON", () => {
    const header = sign(body, secret, 1000);
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    expect(() => verify(reserialized, { "midwater-signature": header }, secret, { now: 1000 })).toThrow(/doesn't match/);
  });
});
