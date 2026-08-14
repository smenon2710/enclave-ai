export interface GroqModelOption {
  id: string;
  label: string;
}

export const GROQ_MODELS: GroqModelOption[] = [
  { id: "whisper-large-v3-turbo", label: "Fast (whisper-large-v3-turbo, ~$0.04/hr of audio)" },
  { id: "whisper-large-v3", label: "Most accurate (whisper-large-v3, ~$0.11/hr of audio)" },
];

// Fast + cheap default, matching this app's existing pattern (tiny.en,
// openrouter/free) of defaulting to the fast/cheap option.
export const DEFAULT_GROQ_MODEL_ID = "whisper-large-v3-turbo";
