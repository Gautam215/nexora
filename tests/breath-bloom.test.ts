import assert from "node:assert/strict";
import test from "node:test";
import {
  breathAt,
  cubicBezier,
  damp,
  petalSize,
  petalTransform,
  pointerPose,
  sampleKeys,
} from "../src/app/components/breath-bloom-math.ts";

test("cubicBezier pins its endpoints and rises monotonically", () => {
  const ease = cubicBezier(0.8, 0, 0.2, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  let previous = 0;
  for (let i = 1; i <= 20; i++) {
    const value = ease(i / 20);
    assert.ok(value >= previous, `not monotonic at ${i / 20}`);
    previous = value;
  }
});

test("cubicBezier with a linear control pair is the identity", () => {
  const linear = cubicBezier(0, 0, 1, 1);
  assert.ok(Math.abs(linear(0.37) - 0.37) < 1e-9);
});

test("sampleKeys interpolates between keyframes with the given ease", () => {
  const keys = [
    { at: 0, amplitude: 1.5, scale: 1 },
    { at: 0.5, amplitude: 1, scale: 3 },
    { at: 1, amplitude: 1.5, scale: 3 },
  ];
  const identity = (x: number) => x;
  assert.deepEqual(sampleKeys(keys, 0.25, identity), { amplitude: 1.25, scale: 2 });
  assert.deepEqual(sampleKeys(keys, 0, identity), { amplitude: 1.5, scale: 1 });
  assert.deepEqual(sampleKeys(keys, 1, identity), { amplitude: 1.5, scale: 3 });
  assert.deepEqual(sampleKeys([], 0.5, identity), { amplitude: 0, scale: 1 });
});

test("breathAt walks in, holds, then out across two durations", () => {
  const d = 4;
  assert.deepEqual(breathAt(0, d), { x: 0, stage: 0 });
  assert.deepEqual(breathAt(d / 4, d), { x: 0.25, stage: 0 });
  assert.deepEqual(breathAt(d / 2, d), { x: 0.5, stage: 1 });
  assert.deepEqual(breathAt((7 * d) / 4, d), { x: 0.25, stage: 2 });
});

test("pointerPose maps corners and clamps outside the box", () => {
  assert.deepEqual(pointerPose(0, 0, [0, 5], [0.15, 8]), { amplitude: 0, scale: 0.15 });
  assert.deepEqual(pointerPose(1, 1, [0, 5], [0.15, 8]), { amplitude: 5, scale: 8 });
  assert.deepEqual(pointerPose(-1, 2, [0, 5], [0.15, 8]), { amplitude: 0, scale: 8 });
  assert.deepEqual(pointerPose(0.5, 0.5, [0, 5], [0.15, 8]), { amplitude: 2.5, scale: 4.075 });
});

test("damp holds still at zero time and snaps with a dead rate", () => {
  assert.equal(damp(1, 5, 7, 0), 1);
  assert.equal(damp(1, 5, 0, 1), 5);
  const moved = damp(1, 5, 7, 0.1);
  assert.ok(moved > 1 && moved < 5);
});

test("petalTransform places, scales, and turns petal zero exactly", () => {
  assert.equal(
    petalTransform(0, 6, 30, 17, { amplitude: 1.5, scale: 1 }, 100),
    "translate(129.90px, -75.00px) scale(1.0000) rotate(-13.00deg)",
  );
  assert.match(
    petalTransform(0, 6, 30, 17, { amplitude: 1, scale: -2 }, 100),
    /scale\(0\.0000\)/,
  );
});

test("petalSize honours fixed sizes and clamps auto sizes", () => {
  assert.equal(petalSize(120, 800, 600), 120);
  assert.equal(petalSize(0, 800, 600), 1);
  assert.equal(petalSize("auto", 0, 0), 100);
  assert.equal(petalSize("auto", 900, 600), 78);
  assert.equal(petalSize("auto", 4000, 3000), 140);
  assert.equal(petalSize("auto", 200, 200), 36);
});
