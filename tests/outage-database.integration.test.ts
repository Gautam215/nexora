import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NextRequest } from "next/server.js";
import { GET as health } from "../src/app/api/health/route.ts";
import { GET as ready } from "../src/app/api/ready/route.ts";
import { closeDatabasePool } from "../src/server/db.ts";

const connectionString = process.env.NEXORA_TEST_DATABASE_URL;
const realDatabaseUrl = connectionString;
const deadDatabaseUrl = "postgresql://nexora_app:app-test@127.0.0.1:1/nexora_test";
if (connectionString) process.env.DATABASE_URL = connectionString;

after(async () => {
  await closeDatabasePool();
});

function apiRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { method: "GET" });
}

test(
  "database outage: readiness fails closed, liveness stays 200, recovery restores readiness",
  { skip: !connectionString },
  async () => {
    const baselineReady = await ready(apiRequest("/api/ready"));
    assert.equal(baselineReady.status, 200);
    const baselineHealth = await health(apiRequest("/api/health"));
    assert.equal(baselineHealth.status, 200);
    const baselineBody = (await baselineHealth.json()) as { data: { database: string } };
    assert.equal(baselineBody.data.database, "up");

    // Point the pool at a dead host: the next probe must fail.
    await closeDatabasePool();
    process.env.DATABASE_URL = deadDatabaseUrl;
    const downReady = await ready(apiRequest("/api/ready"));
    assert.equal(downReady.status, 503);
    const downHealth = await health(apiRequest("/api/health"));
    assert.equal(downHealth.status, 200);
    const downBody = (await downHealth.json()) as { data: { database: string } };
    assert.equal(downBody.data.database, "unavailable");

    // Recovery: drop the dead pool, restore the real URL, and
    // readiness comes back without a restart.
    await closeDatabasePool();
    process.env.DATABASE_URL = realDatabaseUrl;
    const recoveredReady = await ready(apiRequest("/api/ready"));
    assert.equal(recoveredReady.status, 200);
  },
);
