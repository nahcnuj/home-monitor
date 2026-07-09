import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const collectPs1 = readFileSync(
  resolve(import.meta.dirname, "../../scripts/collect-dns.ps1"),
  "utf8",
);

describe("collect-dns.ps1 safety", () => {
  it("does not pass -retry=0 as an nslookup argument (Windows false no_response)", () => {
    // Allow mentions in comments; forbid actual argument forms.
    expect(collectPs1).not.toMatch(/["']-retry=0["']/);
    expect(collectPs1).not.toMatch(/nslookup\.exe[\s\S]{0,200}-retry=0/);
  });

  it("invokes nslookup with timeout and type only (no -retry flag)", () => {
    expect(collectPs1).toMatch(/nslookup\.exe/);
    const invoke = collectPs1.match(/\$output\s*=\s*&\s*nslookup\.exe\s*([\s\S]+?)\s*2>&1/);
    expect(invoke).not.toBeNull();
    const args = invoke![1];
    expect(args).toMatch(/-timeout=/);
    expect(args).toMatch(/-type=/);
    expect(args).not.toMatch(/retry/i);
  });

  it("documents why retry=0 is forbidden", () => {
    expect(collectPs1).toMatch(/Do NOT pass -retry=0/i);
  });
});


