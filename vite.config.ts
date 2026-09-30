import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const pinets = JSON.parse(
  readFileSync(new URL("./node_modules/pinets/package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __PINETS_VERSION__: JSON.stringify(pinets.version),
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
});
