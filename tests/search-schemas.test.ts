import assert from "node:assert/strict";
import test from "node:test";
import { parseSearchRequest } from "../src/security/search-schemas.ts";

const PROJECT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

test("search query trims text and applies safe defaults", () => {
  const parsed = parseSearchRequest(new URLSearchParams("q=%20release%20plan%20"));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.q, "release plan");
  assert.equal(parsed.data.type, "all");
  assert.equal(parsed.data.limit, 20);
  assert.equal(parsed.data.offset, 0);
  assert.equal(parsed.data.projectId, undefined);
});

test("search filters accept only known types and canonical project identifiers", () => {
  const parsed = parseSearchRequest(new URLSearchParams(
    `q=milestone&type=task&projectId=${PROJECT_ID.toUpperCase()}&limit=50&offset=100`,
  ));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.type, "task");
  assert.equal(parsed.data.projectId, PROJECT_ID);
  assert.equal(parsed.data.limit, 50);
  assert.equal(parsed.data.offset, 100);

  assert.equal(parseSearchRequest(new URLSearchParams("q=milestone&type=sql" )).success, false);
  assert.equal(parseSearchRequest(new URLSearchParams("q=milestone&projectId=not-a-uuid" )).success, false);
});

test("search bounds reject missing, short, oversized, control, and excessive paging input", () => {
  assert.equal(parseSearchRequest(new URLSearchParams()).success, false);
  assert.equal(parseSearchRequest(new URLSearchParams("q=x")).success, false);
  assert.equal(parseSearchRequest(new URLSearchParams(`q=${"x".repeat(121)}`)).success, false);
  assert.equal(parseSearchRequest(new URLSearchParams("q=bad%0Aterm")).success, false);
  assert.equal(parseSearchRequest(new URLSearchParams("q=release&limit=51")).success, false);
  assert.equal(parseSearchRequest(new URLSearchParams("q=release&offset=10001")).success, false);
  assert.equal(parseSearchRequest(new URLSearchParams("q=release&offset=-1")).success, false);
});
