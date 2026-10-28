import assert from "node:assert/strict";
import test from "node:test";
import { parseAiJsonOutput } from "../src/server/ai/provider.ts";

test("model JSON output parses plain JSON unchanged", () => {
  assert.deepEqual(parseAiJsonOutput('{"risks": []}'), { risks: [] });
});

test("model JSON output strips a json code fence", () => {
  assert.deepEqual(
    parseAiJsonOutput('```json\n{"risks": [{"title": "T", "detail": "D", "severity": "low"}]}\n```'),
    { risks: [{ title: "T", detail: "D", severity: "low" }] },
  );
});

test("model JSON output strips a bare code fence and surrounding whitespace", () => {
  assert.deepEqual(
    parseAiJsonOutput('  \n```\n{"tasks": []}\n```\n'),
    { tasks: [] },
  );
});

test("model JSON output still throws on genuinely invalid JSON", () => {
  assert.throws(() => parseAiJsonOutput("not json at all"), SyntaxError);
  assert.throws(() => parseAiJsonOutput('```json\n{"a": }\n```'), SyntaxError);
});
