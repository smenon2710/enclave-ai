const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SIZE = 4096;

// Linear-interpolation downsample only — no anti-aliasing filter. Fine for
// speech/WASM-STT input at this stage; revisit if aliasing artifacts show up
// once whisper.cpp is wired in (Phase 2).
class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channelLabel = options.processorOptions?.channelLabel ?? "unknown";
    this.resampleRatio = sampleRate / TARGET_SAMPLE_RATE;
    this.fractionalIndex = 0;
    this.outBuffer = [];
  }

  process(inputs) {
    const input = inputs[0];
    const channelData = input && input[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }

    let i = this.fractionalIndex;
    while (i < channelData.length) {
      const idx = Math.floor(i);
      const frac = i - idx;
      const s0 = channelData[idx] ?? 0;
      const s1 = channelData[idx + 1] ?? s0;
      this.outBuffer.push(s0 + (s1 - s0) * frac);
      i += this.resampleRatio;
    }
    this.fractionalIndex = i - channelData.length;

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
