import { defineConfig } from "vitest/config";

// Use the automatic JSX runtime in tests so `.tsx` sources (components,
// server pages) render without an in-scope `React` import. Next.js already
// compiles them this way; this only aligns vitest's esbuild transform.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
});
