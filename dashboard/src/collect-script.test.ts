import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const collectPs1 = readFileSync(
  resolve(import.meta.dirname, "../../scripts/collect-dns.ps1"),
  "utf8",
);

describe("collect-dns.ps1 nslookup contract", () => {
  it("invokes nslookup with timeout and type only (no -retry flag)", () => {
    expect(collectPs1).toMatch(/nslookup\.exe/);
    const invoke = collectPs1.match(/\$output\s*=\s*&\s*nslookup\.exe\s*([\s\S]+?)\s*2>&1/);
    expect(invoke).not.toBeNull();
    const args = invoke![1];
    expect(args).toMatch(/-timeout=/);
    expect(args).toMatch(/-type=/);
    expect(args).not.toMatch(/retry/i);
  });
});
