export type AudioChannelLabel = "mic" | "participants";

// One completed, self-contained audio file from a MediaRecorder stop/start
// cycle (see capture.ts), ready to upload to Groq for transcription.
export interface AudioWindow {
  channel: AudioChannelLabel;
  blob: Blob;
  // Seconds since the shared meeting epoch (see useMeetingRecorder.ts's
  // startMeeting) when this window's recording started — not seconds since
  // this channel started, which would reintroduce the exact cross-channel
  // mistiming bug fixed in plan.md §4.12 (participants capture begins later
  // than mic, once the share-picker dialog resolves).
  offsetSeconds: number;
}
