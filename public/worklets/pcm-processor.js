const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SIZE = 4096;
// Comfortably below TARGET_SAMPLE_RATE's 8kHz Nyquist, leaving rolloff
// margin rather than placing the cutoff right at the edge.
const ANTI_ALIAS_CUTOFF_HZ = 7000;

// Standard RBJ Audio EQ Cookbook low-pass biquad.
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
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x0) {
    const y0 =
      this.b0 * x0 + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x0;
    this.y2 = this.y1;
    this.y1 = y0;
    return y0;
  }
}

// Downsamples via linear interpolation, preceded by a cascaded low-pass
// filter (two biquad stages, ~24dB/octave combined — one stage's 12dB/octave
// rolloff still leaves too much energy above Nyquist for a ~3x downsample
// ratio, the common 48kHz -> 16kHz case). Without this, content above
// TARGET_SAMPLE_RATE's 8kHz Nyquist aliases straight into the speech band
// during decimation: inaudible as distortion to someone listening to the
// original, unfiltered audio live, but real corrupted energy that
// whisper.cpp actually receives and transcribes from — a real user reported
// exactly this split (audio "sounds fine" live, transcript is garbled).
class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channelLabel = options.processorOptions?.channelLabel ?? "unknown";
    this.resampleRatio = sampleRate / TARGET_SAMPLE_RATE;
    this.fractionalIndex = 0;
    this.outBuffer = [];
    // Skip filtering entirely if the source is already at/below the target
    // rate (rare, but there's no aliasing risk from decimation to guard
    // against there, and filtering would just needlessly cut real content).
    this.filterStages =
      this.resampleRatio > 1
        ? [
            new Biquad(sampleRate, ANTI_ALIAS_CUTOFF_HZ, Math.SQRT1_2),
            new Biquad(sampleRate, ANTI_ALIAS_CUTOFF_HZ, Math.SQRT1_2),
          ]
        : null;
  }

  process(inputs) {
    const input = inputs[0];
    const channelData = input && input[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }

    let samples = channelData;
    if (this.filterStages) {
      samples = new Float32Array(channelData.length);
      for (let n = 0; n < channelData.length; n++) {
        let s = channelData[n];
        for (const stage of this.filterStages) s = stage.process(s);
        samples[n] = s;
      }
    }

    let i = this.fractionalIndex;
    while (i < samples.length) {
      const idx = Math.floor(i);
      const frac = i - idx;
      const s0 = samples[idx] ?? 0;
      const s1 = samples[idx + 1] ?? s0;
      this.outBuffer.push(s0 + (s1 - s0) * frac);
      i += this.resampleRatio;
    }
    this.fractionalIndex = i - samples.length;

    if (this.outBuffer.length >= CHUNK_SIZE) {
      const chunk = new Float32Array(this.outBuffer.splice(0, this.outBuffer.length));
      this.port.postMessage(
        { channel: this.channelLabel, samples: chunk, timestamp: currentTime },
        [chunk.buffer]
      );
    }

    return true;
  }
}

registerProcessor("pcm-worklet-processor", PCMWorkletProcessor);
