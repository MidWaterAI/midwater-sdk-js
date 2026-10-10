import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * openapi/midwater.json is a pinned copy of the app's spec (checksum in openapi/midwater.json.sha256), and fixtures/ are
 * generated from it in midwater-docs. Drift fails the build.
 */
describe("pinned contract and fixtures", () => {
  const lines = readFileSync(new URL("../../fixtures/SHA256SUMS", import.meta.url), "utf8").trim().split("\n");
  it("pins the contract and every fixture", () => {
    expect(lines.map((l) => l.split(/\s+/)[1])).toContain("openapi/midwater.json");
    expect(lines.length).toBeGreaterThanOrEqual(11);
  });
  for (const line of lines) {
    const [sum, path] = line.split(/\s+/) as [string, string];
    it(path, () => expect(createHash("sha256").update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest("hex")).toBe(sum));
  }
});

describe("pinned API spec", () => {
  it("matches openapi/midwater.json.sha256 and names its source", () => {
    const [sum, path] = readFileSync(new URL("../../openapi/midwater.json.sha256", import.meta.url), "utf8").trim().split(/\s+/) as [string, string];
    expect(path).toBe("openapi/midwater.json");
    expect(createHash("sha256").update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest("hex")).toBe(sum);
    expect(readFileSync(new URL("../../openapi/SOURCE", import.meta.url), "utf8")).toMatch(/openapi\/midwater\.json/);
  });
});
