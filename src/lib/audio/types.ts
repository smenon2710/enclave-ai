export type AudioChannelLabel = "mic" | "participants";

export interface PCMChunk {
  channel: AudioChannelLabel;
  samples: Float32Array;
  timestamp: number;
}
