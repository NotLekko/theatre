// The "JARVIS treatment": studio-style processing that gives a synthetic voice the
// polished, faintly digital sheen of the assistant in the films. Everything here works
// on mono float samples in [-1, 1].

export const FX_PRESETS = ["film", "helmet", "clean"] as const;
export type FxPreset = (typeof FX_PRESETS)[number];

export function isFxPreset(value: string): value is FxPreset {
  return (FX_PRESETS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Biquad filters (Robert Bristow-Johnson's audio EQ cookbook)

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

type FilterKind = "highpass" | "lowpass" | "peaking" | "highshelf";

function biquad(kind: FilterKind, freq: number, sampleRate: number, q = Math.SQRT1_2, gainDb = 0): Biquad {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (kind) {
    case "highpass":
      [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    case "lowpass":
      [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    case "peaking":
      [b0, b1, b2] = [1 + alpha * A, -2 * cos, 1 - alpha * A];
      [a0, a1, a2] = [1 + alpha / A, -2 * cos, 1 - alpha / A];
      break;
    case "highshelf": {
      const root = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + root);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - root);
      a0 = A + 1 - (A - 1) * cos + root;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - root;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filter(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const out = f.b0 * x[i]! + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = out;
    y[i] = out;
  }
  return y;
}

// ---------------------------------------------------------------------------
// Time-based effects

/** Mixes in copies delayed by a few milliseconds that drift slowly: a subtle synthetic doubling. */
function doubler(x: Float32Array, sampleRate: number, voices: Array<{ delayMs: number; depthMs: number; rateHz: number; mix: number }>): Float32Array {
  const y = Float32Array.from(x);
  for (const v of voices) {
    for (let i = 0; i < x.length; i++) {
      const delay = ((v.delayMs + v.depthMs * Math.sin((2 * Math.PI * v.rateHz * i) / sampleRate)) * sampleRate) / 1000;
      const pos = i - delay;
      if (pos < 0) continue;
      const j = Math.floor(pos);
      const frac = pos - j;
      const delayed = x[j]! * (1 - frac) + (x[j + 1] ?? 0) * frac;
      y[i] = y[i]! + v.mix * delayed;
    }
  }
  return y;
}

/** A small, bright room: four damped comb filters into two all-passes (Schroeder). */
function room(x: Float32Array, sampleRate: number, { wet, decay, tailSeconds }: { wet: number; decay: number; tailSeconds: number }): Float32Array {
  const length = x.length + Math.round(tailSeconds * sampleRate);
  const input = new Float32Array(length);
  const preDelay = Math.round(0.006 * sampleRate);
  input.set(x.subarray(0, Math.max(0, length - preDelay)), preDelay);
  const wetSignal = new Float32Array(length);

  for (const ms of [23.1, 27.7, 31.9, 35.3]) {
    const n = Math.round((ms * sampleRate) / 1000);
    const line = new Float32Array(n);
    let index = 0;
    let damped = 0;
    for (let i = 0; i < length; i++) {
      const out = line[index]!;
      damped = out * 0.7 + damped * 0.3; // high frequencies die away faster
      line[index] = input[i]! + damped * decay;
      index = (index + 1) % n;
      wetSignal[i] = wetSignal[i]! + out * 0.25;
    }
  }
  let signal = wetSignal;
  for (const [ms, gain] of [[5.0, 0.6], [1.7, 0.6]] as const) {
    const n = Math.round((ms * sampleRate) / 1000);
    const line = new Float32Array(n);
    let index = 0;
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const buffered = line[index]!;
      const v = signal[i]! + buffered * gain;
      out[i] = buffered - v * gain;
      line[index] = v;
      index = (index + 1) % n;
    }
    signal = out;
  }

  const y = new Float32Array(length);
  for (let i = 0; i < length; i++) y[i] = (x[i] ?? 0) + wet * signal[i]!;
  return y;
}

/** Gentle saturation that tames peaks, then scales the loudest peak to `peak`. */
function finish(x: Float32Array, drive: number, peak: number): Float32Array {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  if (max === 0) return x;
  const y = new Float32Array(x.length);
  const norm = Math.tanh(drive);
  let newMax = 0;
  for (let i = 0; i < x.length; i++) {
    y[i] = Math.tanh((drive * x[i]!) / max) / norm;
    newMax = Math.max(newMax, Math.abs(y[i]!));
  }
  for (let i = 0; i < y.length; i++) y[i] = (y[i]! / newMax) * peak;
  return y;
}

const PEAK = 0.89; // -1 dBFS

/**
 * Applies a preset. `film` is the default voice: a cleaned-up low end, a lift in presence
 * and air, a faint modulated doubling and a little room. `helmet` is JARVIS inside the
 * suit: narrower, drier and slightly driven. `clean` only sets the level.
 */
export function applyFx(samples: Float32Array, sampleRate: number, preset: FxPreset): Float32Array {
  let x = samples;
  switch (preset) {
    case "clean":
      return finish(x, 0.01, PEAK);
    case "film":
      x = filter(x, biquad("highpass", 90, sampleRate));
      x = filter(x, biquad("peaking", 250, sampleRate, 1, -2));
      x = filter(x, biquad("peaking", 3000, sampleRate, 0.9, 3));
      x = filter(x, biquad("highshelf", Math.min(7000, sampleRate * 0.3), sampleRate, Math.SQRT1_2, 2));
      x = doubler(x, sampleRate, [
        { delayMs: 9, depthMs: 0.8, rateHz: 0.4, mix: 0.14 },
        { delayMs: 17, depthMs: 1.1, rateHz: 0.27, mix: 0.07 },
      ]);
      x = room(x, sampleRate, { wet: 0.09, decay: 0.55, tailSeconds: 0.35 });
      return finish(x, 1.2, PEAK);
    case "helmet":
      x = filter(x, biquad("highpass", 220, sampleRate));
      x = filter(x, biquad("lowpass", Math.min(5500, sampleRate * 0.45), sampleRate));
      x = filter(x, biquad("peaking", 1800, sampleRate, 1, 4));
      x = doubler(x, sampleRate, [{ delayMs: 11, depthMs: 1, rateHz: 0.5, mix: 0.2 }]);
      x = room(x, sampleRate, { wet: 0.04, decay: 0.4, tailSeconds: 0.15 });
      return finish(x, 2, PEAK);
  }
}
