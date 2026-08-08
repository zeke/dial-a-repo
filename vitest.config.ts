import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Test-only values so tests never depend on real secrets. These
      // override whatever is (or isn't) configured for local dev/prod.
      miniflare: {
        bindings: {
          XAI_API_KEY: "test-xai-api-key",
          XAI_WEBHOOK_SECRET: "whsec_dGVzdC1zZWNyZXQ=",
        },
      },
    }),
  ],
});
