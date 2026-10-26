import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import test from "node:test";
import { GET } from "../src/app/api/health/route.ts";

test("health endpoint reports liveness and database state without secrets", async () => {
  const response = await GET(
    new NextRequest("http://localhost:3000/api/health"),
  );
  const body = (await response.json()) as {
    data: { status: string; database: string };
    requestId: string;
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
  assert.ok(body.requestId);
  assert.deepEqual(Object.keys(body.data).sort(), ["database", "status"]);
  assert.ok(["up", "unavailable", "unconfigured"].includes(body.data.database));
  assert.equal(
    body.data.status,
    body.data.database === "up" ? "ok" : "degraded",
  );
});
