export interface WhisperModelOption {
  id: string;
  label: string;
  url: string;
}

export const WHISPER_MODELS: WhisperModelOption[] = [
  {
    id: "tiny.en",
    label: "Fast (tiny.en, ~75MB download)",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
  },
  {
    id: "base.en",
    label: "Accurate (base.en, ~148MB download)",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  },
];

// tiny.en, not base.en: base.en was tried as the default (now that mic
// transcription defaults to Web Speech, this setting mostly only governs
// Participants accuracy, so the old latency trade-off seemed gone) but a
// direct timing probe measured a single ~3s window taking ~25.7s with
// base.en — past TRANSCRIBE_TIMEOUT_MS (whisperEngine.ts), meaning it can
// trip the "stopped responding" watchdog on close to every window rather
// than just being slower. That's a worse failure mode than tiny.en's lower
// accuracy (repeated restarts producing near-zero transcript, not a more
// accurate one), so tiny.en stays the default; base.en remains available as
// a manual Settings opt-in for faster hardware. See plan.md §4.14.
export const DEFAULT_WHISPER_MODEL_ID = "tiny.en";

export function getWhisperModelUrl(id: string): string {
  return WHISPER_MODELS.find((m) => m.id === id)?.url ?? WHISPER_MODELS[0].url;
}
