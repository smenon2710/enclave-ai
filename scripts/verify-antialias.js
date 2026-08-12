#!/usr/bin/env node
// Regression test for the anti-aliasing fix in public/worklets/pcm-processor.js
// (added after a real user reported garbled Participants transcription — the
// downsampler was decimating 48kHz -> 16kHz via linear interpolation with no
// low-pass filter first, aliasing content above 16kHz's 8kHz Nyquist straight
// into the speech band). Mirrors that file's Biquad + resample math exactly,
// so if pcm-processor.js's filter constants or resample logic ever change,
// update both places together.
//
// Run: node scripts/verify-antialias.js (or `npm run test:dsp`)

const SOURCE_RATE = 48000;
const TARGET_RATE = 16000;
const CUTOFF_HZ = 7000;

class Biquad {
  constructor(sourceSampleRate, cutoffHz, q) {
    const w0 = (2 * Math.PI * cutoffHz) / sourceSampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cosw0 = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = (1 - cosw0) / 2 / a0;
    this.b1 = (1 - cosw0) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  process(x0) {
    const y0 = this.b0 * x0 + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x0;
    this.y2 = this.y1; this.y1 = y0;
    return y0;
  }
}

function resample(sourceSamples, sourceRate, filterStages) {
  const resampleRatio = sourceRate / TARGET_RATE;
  let samples = sourceSamples;
  if (filterStages) {
    samples = new Float64Array(sourceSamples.length);
    for (let n = 0; n < sourceSamples.length; n++) {
      let s = sourceSamples[n];
      for (const stage of filterStages) s = stage.process(s);
      samples[n] = s;
    }
  }

  const out = [];
  let i = 0;
  while (i < samples.length) {
    const idx = Math.floor(i);
    const frac = i - idx;
    const s0 = samples[idx] ?? 0;
    const s1 = samples[idx + 1] ?? s0;
    out.push(s0 + (s1 - s0) * frac);
    i += resampleRatio;
  }
  return out;
}

// Mirrors PCMWorkletProcessor's constructor exactly: filtering is only
// engaged when resampleRatio > 1 (real downsampling, aliasing risk) — a
// device already at/below the target rate skips it entirely.
function downsampleAsShipped(sourceSamples, sourceRate) {
  const resampleRatio = sourceRate / TARGET_RATE;
  const filterStages =
    resampleRatio > 1
      ? [new Biquad(sourceRate, CUTOFF_HZ, Math.SQRT1_2), new Biquad(sourceRate, CUTOFF_HZ, Math.SQRT1_2)]
      : null;
  return resample(sourceSamples, sourceRate, filterStages);
}

// Reference baseline representing the pre-fix code (always skips filtering)
// — used only to quantify the improvement in tests 1/2, not to exercise the
// shipped branch logic itself (see downsampleAsShipped/test 3 for that).
function downsampleUnfiltered(sourceSamples, sourceRate) {
  return resample(sourceSamples, sourceRate, null);
}

// N chosen so targetFreq lands exactly on an FFT bin (k integer) to avoid
// spectral leakage that would make amplitude estimates noisy.
function goertzelAmplitude(samples, targetFreq, sampleRate) {
  const N = samples.length;
  const k = Math.round((N * targetFreq) / sampleRate);
  const w = (2 * Math.PI * k) / N;
  const cosine = Math.cos(w), sine = Math.sin(w), coeff = 2 * cosine;
  let q0 = 0, q1 = 0, q2 = 0;
  for (let i = 0; i < N; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1; q1 = q0;
  }
  const real = q1 - q2 * cosine, imag = q2 * sine;
  return (2 * Math.sqrt(real * real + imag * imag)) / N;
}

function tone(freqHz, durationSec, sampleRate, amplitude = 1) {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

function toDb(amp) {
  return 20 * Math.log10(Math.max(amp, 1e-12));
}

const analyzeWindow = (arr) => arr.slice(2000, 2000 + 3200); // skip filter transient/edges

let failures = 0;
function check(label, condition, detail) {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

// --- Test 1: a 12kHz source component (real, capturable content below the
// source's own 24kHz Nyquist -- e.g. sibilance/consonant harmonics) aliases
// to |12000 - 16000| = 4000Hz once naively decimated to 16kHz, landing
// squarely in the speech band. That's the exact bug that was reported.
{
  const signal = tone(12000, 0.5, SOURCE_RATE);
  const ampUnfiltered = goertzelAmplitude(analyzeWindow(downsampleUnfiltered(signal, SOURCE_RATE)), 4000, TARGET_RATE);
  const ampFiltered = goertzelAmplitude(analyzeWindow(downsampleAsShipped(signal, SOURCE_RATE)), 4000, TARGET_RATE);
  const suppressionDb = toDb(ampUnfiltered) - toDb(ampFiltered);
  check(
    "12kHz source no longer aliases into 4kHz speech band",
    suppressionDb >= 15,
    `${suppressionDb.toFixed(1)} dB suppression (want >= 15 dB)`
  );
}

// --- Test 2: real speech content (1kHz, well below the 7kHz cutoff) must
// survive the filter close to untouched -- the fix must not trade "no more
// aliasing" for "duller real speech."
{
  const signal = tone(1000, 0.5, SOURCE_RATE);
  const ampUnfiltered = goertzelAmplitude(analyzeWindow(downsampleUnfiltered(signal, SOURCE_RATE)), 1000, TARGET_RATE);
  const ampFiltered = goertzelAmplitude(analyzeWindow(downsampleAsShipped(signal, SOURCE_RATE)), 1000, TARGET_RATE);
  const attenuationDb = toDb(ampUnfiltered) - toDb(ampFiltered);
  check(
    "1kHz speech-band content passes through essentially unattenuated",
    attenuationDb < 1,
    `${attenuationDb.toFixed(2)} dB attenuation (want < 1 dB)`
  );
}

// --- Test 3: content already at/below the target rate must skip filtering
// entirely (no aliasing risk, and filtering would needlessly cut real
// content) -- guards the resampleRatio > 1 branch in pcm-processor.js.
{
  const signal = tone(1000, 0.5, TARGET_RATE); // sourceRate === TARGET_RATE -> resampleRatio === 1
  const identity = downsampleAsShipped(signal, TARGET_RATE);
  const maxDiff = Math.max(...identity.map((v, i) => Math.abs(v - signal[i])));
  check("resampleRatio<=1 skips filtering entirely (passthrough)", maxDiff < 1e-9, `max diff ${maxDiff}`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
