import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDatabaseConnectionString } from "../src/server/db.ts";

// Unit tests only: no database is touched. The normalizer exists
// because pg warns on sslmode=require (Vercel counts that stderr
// warning as an error); verify-full is the same behaviour today,
// stated explicitly.
test("normalizeDatabaseConnectionString rewrites only the sslmode query param", () => {
  assert.equal(
    normalizeDatabaseConnectionString("postgresql://user:pass@host:5432/db?sslmode=require&channel_binding=require"),
    "postgresql://user:pass@host:5432/db?sslmode=verify-full&channel_binding=require",
  );
  assert.equal(
    normalizeDatabaseConnectionString("postgresql://user:pass@host:5432/db?channel_binding=require&sslmode=require"),
    "postgresql://user:pass@host:5432/db?channel_binding=require&sslmode=verify-full",
  );
  assert.equal(
    normalizeDatabaseConnectionString("postgresql://user:pass@host:5432/db?sslmode=verify-full"),
    "postgresql://user:pass@host:5432/db?sslmode=verify-full",
  );
  assert.equal(
    normalizeDatabaseConnectionString("postgresql://user:pass@localhost:5432/db"),
    "postgresql://user:pass@localhost:5432/db",
  );
});
