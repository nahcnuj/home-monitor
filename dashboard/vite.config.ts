import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";

const root = resolve(import.meta.dirname);
const repoRoot = resolve(root, "..");
const dataLocalFile = resolve(repoRoot, "data/local/dns-latency.tsv");
const docsRoot = resolve(repoRoot, "docs");
const outDir = resolve(root, "dist");

function resolveDevDataFile(url: string): string | null {
  if (url !== "/data/dns-latency.tsv") return null;
  if (existsSync(dataLocalFile)) return dataLocalFile;
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
        const filePath = resolveDevDataFile(url) ?? join(docsRoot, url);
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
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