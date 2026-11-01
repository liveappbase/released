// Runs ONLY the real-render tests (*.render.test.ts) under the Workers runtime
// (workerd via miniflare). workers-og's wasm (satori yoga + resvg) loads through
// workerd's module graph, so it renders a real PNG here — and a blank/throwing
// render (the #56 class) fails the byte/magic assertions. The plain-Node routing
// tests keep their own config (vitest.config.ts); this pool is separate so it
// never touches them.
//
// v4 API: @cloudflare/vitest-pool-workers exposes a `cloudflareTest` vitest
// plugin (replacing the old defineWorkersProject + poolOptions.workers). See the
// package's vitest-v3-to-v4 codemod.
//
// Node 22+ only. Importing @cloudflare/vitest-pool-workers pulls in miniflare
// (and wrangler), whose package.json declares engines node >=22.0.0. Older
// miniflare/undici combinations crashed outright on Node 20 with
// "TypeError: webidl.util.markAsUncloneable is not a function". The product
// itself still supports Node 20+ (the plain-Node suite in vitest.config.ts runs
// on the full CI matrix); only this workerd render pool needs Node 22. So the
// pool is dynamic-imported only on 22+, and skipped loudly below that rather
// than failing the whole gate.
import { defineConfig } from 'vitest/config';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const WORKERD_POOL_MIN_NODE = 22;

export default defineConfig(async () => {
  if (NODE_MAJOR < WORKERD_POOL_MIN_NODE) {
    console.warn(
      `\n[web-og] workerd render tests require Node ${WORKERD_POOL_MIN_NODE}+ ` +
        `(@cloudflare/vitest-pool-workers → miniflare/wrangler declare ` +
        `engines node >=22). ` +
        `Running on Node ${NODE_MAJOR}; skipping the render suite — ` +
        `it still runs on the node-${WORKERD_POOL_MIN_NODE} matrix cell.\n`,
    );
    return {
      test: { include: [], passWithNoTests: true },
    };
  }

  const { cloudflareTest } = await import('@cloudflare/vitest-pool-workers');
  return {
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'hono/jsx',
    },
    plugins: [
      cloudflareTest({
        // Test-only config (no Service Binding) — see wrangler.test.toml. wrangler
        // bundles workers-og's wasm natively for workerd from this config.
        wrangler: { configPath: './wrangler.test.toml' },
      }),
    ],
    test: {
      include: ['test/**/*.render.test.ts'],
    },
  };
});
