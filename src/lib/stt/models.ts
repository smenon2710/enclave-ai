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

export const DEFAULT_WHISPER_MODEL_ID = "tiny.en";

export function getWhisperModelUrl(id: string): string {
  return WHISPER_MODELS.find((m) => m.id === id)?.url ?? WHISPER_MODELS[0].url;
}
