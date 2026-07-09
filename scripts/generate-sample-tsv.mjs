/**
 * Generate a ~30 minute DNS latency TSV with mixed successes and errors.
 * Writes assets/sample-dns-latency.tsv and optionally data/local/dns-latency.tsv.
 *
 * Usage: node scripts/generate-sample-tsv.mjs [--local]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const writeLocal = process.argv.includes("--local");

const now = Math.floor(Date.now() / 1000);
const end = now - (now % 60);
const start = end - 30 * 60;
const resolvers = ["203.165.31.152", "122.197.254.136"];
const domains = [
  "google.com",
  "cloudflare.com",
  "github.com",
  "amazon.co.jp",
  "yahoo.co.jp",
  "apple.com",
  "microsoft.com",
  "line.me",
  "203-165-31-152.rev.home.ne.jp",
];

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);

const outageWindows = [
  { from: 8, to: 11, type: "dns_timeout" },
  { from: 18, to: 20, type: "mixed" },
];

const lines = [];
for (let ts = start; ts <= end; ts += 60) {
  const minute = (ts - start) / 60;
  for (const resolver of resolvers) {
    for (const domain of domains) {
      const base = resolver.startsWith("203") ? 180 : 220;
      const jitter = Math.floor(rnd() * 80) - 20;
      const latency = Math.max(40, base + jitter + Math.floor(Math.sin(minute / 3) * 30));
      const inOutage = outageWindows.find((w) => minute >= w.from && minute < w.to);

      if (inOutage) {
        const failPrimary = inOutage.type === "dns_timeout" && resolver.startsWith("203");
        const failBoth = inOutage.type === "mixed";
        const failSecondaryOnly =
          inOutage.type === "dns_timeout" && !resolver.startsWith("203") && rnd() < 0.35;
        if (failPrimary || failBoth || failSecondaryOnly) {
          if (inOutage.type === "dns_timeout" || (inOutage.type === "mixed" && rnd() < 0.55)) {
            const durs = [9000, 18000, 27000, 36000, 45000, 54000, 63000];
            const dur = durs[Math.floor(rnd() * durs.length)];
            const code = rnd() < 0.75 ? "dns_timeout" : "job_timeout";
            const ms = code === "job_timeout" ? 70000 : dur;
            lines.push([ts, resolver, domain, ms, code].join("\t"));
          } else {
            lines.push([ts, resolver, domain, Math.floor(2000 + rnd() * 3000), "no_response"].join("\t"));
          }
          continue;
        }
      }

      if (rnd() < 0.015) {
        lines.push([ts, resolver, domain, Math.floor(5000 + rnd() * 10000), "dns_timeout"].join("\t"));
        continue;
      }
      if (rnd() < 0.008) {
        lines.push([ts, resolver, domain, "", "server_fail"].join("\t"));
        continue;
      }

      lines.push([ts, resolver, domain, latency].join("\t"));
    }
  }
}

const body = `${lines.join("\n")}\n`;
const samplePath = path.join(root, "assets/sample-dns-latency.tsv");
fs.mkdirSync(path.dirname(samplePath), { recursive: true });
fs.writeFileSync(samplePath, body);
console.log("wrote", samplePath, "rows=", lines.length);

if (writeLocal) {
  const localPath = path.join(root, "data/local/dns-latency.tsv");
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, body);
  console.log("wrote", localPath);
}
