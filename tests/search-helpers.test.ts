import assert from "node:assert/strict";
import test from "node:test";
import {
  addRecentSearch,
  highlightSegments,
  loadRecentSearches,
} from "../src/app/components/organization-search-helpers.ts";

test("highlight matches query words case-insensitively and keeps order", () => {
  assert.deepEqual(highlightSegments("Release plan for launch", "release"), [
    { text: "Release", match: true },
    { text: " plan for launch", match: false },
  ]);
  assert.deepEqual(highlightSegments("Design review design", "design review"), [
    { text: "Design", match: true },
    { text: " ", match: false },
    { text: "review", match: true },
    { text: " ", match: false },
    { text: "design", match: true },
  ]);
});

test("highlight ignores short words and regex characters in the query", () => {
  assert.deepEqual(highlightSegments("Version 2.0 (final)", "a 2.0"), [
    { text: "Version ", match: false },
    { text: "2.0", match: true },
    { text: " (final)", match: false },
  ]);
  assert.deepEqual(highlightSegments("No match here", ""), [
    { text: "No match here", match: false },
  ]);
});

test("recent searches dedup case-insensitively, newest first, capped at five", () => {
  const added = addRecentSearch(["launch", "design"], "Launch");
  assert.deepEqual(added, ["Launch", "design"]);
  const capped = ["a1", "a2", "a3", "a4", "a5"];
  assert.deepEqual(addRecentSearch(capped, "a6"), ["a6", "a1", "a2", "a3", "a4"]);
  assert.deepEqual(addRecentSearch(["launch"], "x"), ["launch"]);
});

test("recent searches load only valid stored strings", () => {
  assert.deepEqual(loadRecentSearches(null), []);
  assert.deepEqual(loadRecentSearches("not json"), []);
  assert.deepEqual(loadRecentSearches(JSON.stringify(["launch", 42, "x", " design "])), [
    "launch",
    " design ",
  ]);
});
