import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const collectPs1 = readFileSync(
  resolve(import.meta.dirname, "../../scripts/collect-dns.ps1"),
  "utf8",
);

describe("collect-dns.ps1", () => {
  it("Start-DnsLookupJob does not pass -retry=0 to nslookup", () => {
    const invoke = collectPs1.match(/\$output\s*=\s*&\s*nslookup\.exe\s*([\s\S]+?)\s*2>&1/);
    expect(invoke).not.toBeNull();
    expect(invoke![1]).not.toMatch(/-retry\s*=\s*0/i);
    expect(collectPs1).not.toMatch(/["']-retry=0["']/);
  });

  it("can be dot-sourced without running the main collection", () => {
    expect(collectPs1).toMatch(/InvocationName -eq '\.'/);
  });
});
