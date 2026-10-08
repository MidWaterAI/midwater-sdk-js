import { readFileSync } from "node:fs";

/** The shared fixtures, pinned by checksum in fixtures/SHA256SUMS. */
export const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8")) as T;
