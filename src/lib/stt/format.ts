import type { TranscriptSegment } from "./types";

export function formatTranscriptForPrompt(segments: TranscriptSegment[]): string {
  return segments
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((seg) => {
      const minutes = Math.floor(seg.start / 60);
      const seconds = Math.floor(seg.start % 60);
      const timestamp = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
      const speaker = seg.channel === "mic" ? "You" : "Participants";
      return `[${timestamp}] ${speaker}: ${seg.text}`;
    })
    .join("\n");
}
