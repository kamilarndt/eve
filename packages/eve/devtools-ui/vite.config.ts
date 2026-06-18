import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const uiRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(uiRoot, "..");

export default defineConfig({
  root: uiRoot,
  resolve: {
    alias: {
      "@geist-fonts": resolve(packageRoot, "node_modules/geist/dist/fonts"),
      "@ui": resolve(uiRoot, "src"),
    },
  },
  build: {
    emptyOutDir: true,
    manifest: true,
    outDir: resolve(packageRoot, "dist/devtools-ui"),
    rolldownOptions: {
      input: resolve(uiRoot, "index.html"),
      output: {
        codeSplitting: false,
      },
    },
  },
  server: {
    host: "127.0.0.1",
  },
});
