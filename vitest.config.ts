import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // The AI binding is remote-only; tests stub it, so no API token is needed.
      remoteBindings: false,
    }),
  ],
});
