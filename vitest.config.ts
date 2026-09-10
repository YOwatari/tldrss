import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // GEMINI_API_KEY is a secret, so it is not in wrangler.toml.
        bindings: { GEMINI_API_KEY: "test-key" },
      },
    }),
  ],
});
