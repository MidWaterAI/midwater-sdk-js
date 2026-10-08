import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** openapi/midwater.yaml and fixtures/ are pinned copies of the contract repo's files. Drift fails the build. */
describe("pinned contract and fixtures", () => {
  const lines = readFileSync(new URL("../../fixtures/SHA256SUMS", import.meta.url), "utf8").trim().split("\n");
  it("pins the contract and every fixture", () => {
    expect(lines.map((l) => l.split(/\s+/)[1])).toContain("openapi/midwater.yaml");
    expect(lines.length).toBeGreaterThanOrEqual(11);
  });
  for (const line of lines) {
    const [sum, path] = line.split(/\s+/) as [string, string];
    it(path, () => expect(createHash("sha256").update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest("hex")).toBe(sum));
  }
});
