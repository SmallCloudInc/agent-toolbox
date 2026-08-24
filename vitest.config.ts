import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.json" },
			// EMAIL uses remote: true in wrangler.json so local/dev hits Email Service.
			// Tests stay on the local simulator and do not require Cloudflare credentials.
			remoteBindings: false,
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
				},
			},
		})),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
	},
});
