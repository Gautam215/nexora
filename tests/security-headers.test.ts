import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../next.config.ts";

// Regression test for the security headers shipped by the Next.js
// config must not silently lose an entry. The CSP itself is covered by
// tests/content-security-policy.test.ts; this file pins the static headers
// and the frame-ancestors denial that keeps the app unframeable.
test("next config ships the full static security header set", async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  const headersFn = nextConfig.headers;
  if (typeof headersFn !== "function") throw new Error("next config has no headers function");
  const entries = await headersFn();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.source, "/:path*");
  const headers = new Map(
    (entries[0]?.headers ?? []).map((header) => [header.key, header.value]),
  );
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(
    headers.get("Permissions-Policy"),
    "camera=(), microphone=(), geolocation=()",
  );
});
