import type { AudioChannelLabel } from "@/lib/audio/types";

export interface TranscriptSegment {
  channel: AudioChannelLabel;
  start: number;
  end: number;
  text: string;
}
