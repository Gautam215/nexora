import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Accessibility regression checks for the DESIGN.md palette and
// the component tree. These are static checks, not a substitute
// for a screen-reader or keyboard pass on the deployed app, and
// they are labelled as such in docs: they catch regressions in
// the two things this codebase controls statically — palette
// contrast and form-control labelling — without pretending to
// prove WCAG conformance.

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

test("DESIGN.md palette pairs meet WCAG AA for normal text (4.5:1)", () => {
  const pairs: Array<[string, string, string]> = [
    ["primary text on background", "#f2f3f4", "#111315"],
    ["primary text on surface", "#f2f3f4", "#191c1f"],
    ["muted text on background", "#a1a6aa", "#111315"],
    ["muted text on surface", "#a1a6aa", "#191c1f"],
    ["accent text on background", "#a9c2b0", "#111315"],
  ];
  for (const [name, foreground, background] of pairs) {
    const ratio = contrastRatio(foreground, background);
    assert.ok(ratio >= 4.5, `${name}: ${ratio.toFixed(2)}:1 is below 4.5:1`);
  }
});

test("every form control in components is labelled (wrapped in <label> or aria-labelled)", async () => {
  const componentsDir = path.join(process.cwd(), "src", "app", "components");
  const files = (await readdir(componentsDir)).filter((file) => file.endsWith(".tsx"));
  assert.ok(files.length > 0, "expected component files");
  const unlabeled: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(componentsDir, file), "utf8");
    const labelledIds = new Set([...text.matchAll(/htmlFor="([^"]+)"/g)].map((match) => match[1]));
    let labelDepth = 0;
    for (const match of text.matchAll(/<(?:\/)?(label|input|select|textarea)\b([^>]*)>/g)) {
      const isClosing = match[0].startsWith("</");
      const tag = match[1];
      const attrs = match[2] ?? "";
      if (tag === "label") {
        if (isClosing) labelDepth = Math.max(0, labelDepth - 1);
        else labelDepth += 1;
      } else if (!isClosing) {
        if (attrs.includes('type="hidden"')) continue;
        const id = /id="([^"]+)"/.exec(attrs)?.[1];
        if (labelDepth === 0 && !attrs.includes("aria-label") && !(id && labelledIds.has(id))) {
          const line = text.slice(0, match.index).split("\n").length;
          unlabeled.push(`${file}:${line} <${tag}>`);
        }
      }
    }
  }
  assert.deepEqual(unlabeled, []);
});
