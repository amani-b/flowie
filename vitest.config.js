import { defineConfig } from "vitest/config";

/**
 * Test config, separate from `vite.config.js` on purpose: the app config pulls
 * in the PWA plugin and the production manual-chunk split, neither of which has
 * anything to do with running unit tests, and the PWA plugin writing a service
 * worker during a test run is exactly the kind of side effect that makes tests
 * flaky.
 *
 * Default environment is plain Node — the queue and the cache are storage- and
 * DOM-free by design, and the IDB layer already degrades to a miss when there is
 * no `window`. The few tests that need `localStorage` opt in per file with a
 * `@vitest-environment jsdom` docblock.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fail loudly instead of silently passing when a file has no tests.
    passWithNoTests: false,
  },
});
