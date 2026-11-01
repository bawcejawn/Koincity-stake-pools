import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/Koincity-stake-pools/",
  resolve: {
    alias: {
      koilib: path.resolve(root, "node_modules/koilib/lib/browser/index.js"),
    },
  },
  server: {
    port: 5173,
  },
});
