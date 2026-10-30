/** Pure math for the Breath Bloom petals. No React, no JSX, so unit tests
 * can import it under node:test. The component in breath-bloom.tsx owns
 * the animation loop; this file only answers geometry questions. */

export type BloomKey = {
  /** Position on the timeline, 0..1. */
  at: number;
  /** Distance of each petal from the centre, in petal sizes. */
  amplitude: number;
  /** Petal scale, 1 = `size`. */
  scale: number;
};

export type BloomPose = { amplitude: number; scale: number };

type Ease = (x: number) => number;
export type Range = [number, number];

// #region bloom
/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cl = (v: number) => Math.min(1, Math.max(0, v));
  const ax1 = cl(x1);
  const ax2 = cl(x2);
  const curve = (a: number, b: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // x(t) is monotonic once the control x's are clamped to 0..1, so bisection
    // always lands; 32 halvings is far past a pixel.
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 32; i++) {
      if (curve(ax1, ax2, t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return curve(y1, y2, t);
  };
}

/** Pose at linear position x (0..1) along the keyframes, eased per segment. */
export function sampleKeys(keys: BloomKey[], x: number, ease: Ease) {
  if (!keys.length) return { amplitude: 0, scale: 1 };
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (x <= first.at) return { amplitude: first.amplitude, scale: first.scale };
  if (x >= last.at) return { amplitude: last.amplitude, scale: last.scale };
  let i = 0;
  while (i < keys.length - 2 && x > keys[i + 1].at) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.at - a.at;
  const e = span > 0 ? ease((x - a.at) / span) : 1;
  return {
    amplitude: a.amplitude + (b.amplitude - a.amplitude) * e,
    scale: a.scale + (b.scale - a.scale) * e,
  };
}

/**
 * Where the breath is at time t: the timeline runs forward then back
 * (`alternate`), so one full breath is two durations. Stage 0 is breathing in
 * (forward, first half of the keys), 1 is the hold at the far end, 2 is
 * breathing out (backward, first half).
 */
export function breathAt(t: number, duration: number) {
  const d = duration > 0 ? duration : 1;
  const u = (((t / d) % 2) + 2) % 2;
  const forward = u < 1;
  const x = forward ? u : 2 - u;
  const stage = x >= 0.5 ? 1 : forward ? 0 : 2;
  return { x: x, stage: stage };
}

/** Pointer position (0..1 in the box) to a pose. */
export function pointerPose(px: number, py: number, amp: Range, scale: Range) {
  const cx = Math.min(1, Math.max(0, px));
  const cy = Math.min(1, Math.max(0, py));
  return {
    amplitude: amp[0] + (amp[1] - amp[0]) * cx,
    scale: scale[0] + (scale[1] - scale[0]) * cy,
  };
}

/** Frame-rate independent ease toward a target. */
export function damp(current: number, target: number, rate: number, dt: number) {
  if (!(rate > 0)) return target;
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Petal i of n on a ring: pushed out along its angle, scaled, then turned. */
export function petalTransform(i: number, n: number, ring: number, tilt: number, pose: BloomPose, size: number) {
  const deg = (360 / Math.max(1, n)) * i + ring;
  const rad = (deg * Math.PI) / 180;
  const r = pose.amplitude * size;
  const x = Math.cos(rad) * r;
  const y = -Math.sin(rad) * r;
  const s = Math.max(0, pose.scale);
  return (
    "translate(" + x.toFixed(2) + "px, " + y.toFixed(2) + "px) scale(" + s.toFixed(4) + ") rotate(" +
    (tilt - deg).toFixed(2) + "deg)"
  );
}

/** "auto" sizes the petal from the box's short side, within sane bounds. */
export function petalSize(size: number | "auto", width: number, height: number) {
  if (typeof size === "number") return Math.max(1, size);
  const short = Math.min(width, height);
  if (!(short > 0)) return 100;
  return Math.min(140, Math.max(36, short * 0.13));
}
// #endregion
