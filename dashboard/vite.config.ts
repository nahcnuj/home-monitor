import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";
import { parseTsv } from "./src/data.ts";

const root = resolve(import.meta.dirname);
const repoRoot = resolve(root, "..");
const dataLocalTsv = resolve(repoRoot, "data/local/dns-latency.tsv");
const docsRoot = resolve(repoRoot, "docs");
const outDir = resolve(root, "dist");

function resolveDevTsv(): string | null {
  if (existsSync(dataLocalTsv)) return dataLocalTsv;
  const docsFile = join(docsRoot, "data/dns-latency.tsv");
  if (existsSync(docsFile)) return docsFile;
  return null;
}

function serveDevData(): Plugin {
  return {
    name: "serve-dev-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/data/")) {
          next();
          return;
        }

        // Dashboard loads JSON; build it from local/docs TSV on the fly for dev.
        if (url === "/data/dns-latency.json") {
          const tsvPath = resolveDevTsv();
          if (!tsvPath) {
            next();
            return;
          }
          const records = parseTsv(readFileSync(tsvPath, "utf8"));
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(`${JSON.stringify(records)}\n`);
          return;
        }

        if (url === "/data/dns-latency.tsv") {
          const tsvPath = resolveDevTsv();
          if (!tsvPath) {
            next();
            return;
          }
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          createReadStream(tsvPath).pipe(res);
          return;
        }

        const filePath = join(docsRoot, url);
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }
        const type = filePath.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8";
        res.setHeader("Content-Type", type);
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  plugins: [serveDevData()],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, "index.html"),
    },
  },
});
