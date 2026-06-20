import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";

const root = resolve(import.meta.dirname);
const docsRoot = resolve(root, "../docs");
const outDir = resolve(root, "dist");

function serveDocsData(): Plugin {
  return {
    name: "serve-docs-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/config/") && !url.startsWith("/data/")) {
          next();
          return;
        }
        const filePath = join(docsRoot, url);
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
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
  plugins: [serveDocsData()],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, "index.html"),
    },
  },
});