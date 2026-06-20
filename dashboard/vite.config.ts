import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";

const root = resolve(import.meta.dirname);
const repoRoot = resolve(root, "..");
const dataLocalFile = resolve(repoRoot, "data/local/dns-latency.tsv");
const configFile = resolve(repoRoot, "config/monitor.json");
const docsRoot = resolve(repoRoot, "docs");
const outDir = resolve(root, "dist");

function resolveDevAsset(url: string): string | null {
  if (url === "/config/monitor.json" && existsSync(configFile)) {
    return configFile;
  }
  if (url === "/data/dns-latency.tsv") {
    if (existsSync(dataLocalFile)) return dataLocalFile;
    const docsFile = join(docsRoot, "data/dns-latency.tsv");
    if (existsSync(docsFile)) return docsFile;
  }
  const docsFile = join(docsRoot, url);
  if (existsSync(docsFile) && statSync(docsFile).isFile()) {
    return docsFile;
  }
  return null;
}

function serveDevData(): Plugin {
  return {
    name: "serve-dev-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/config/") && !url.startsWith("/data/")) {
          next();
          return;
        }
        const filePath = resolveDevAsset(url);
        if (!filePath) {
          next();
          return;
        }
        const type = filePath.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
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