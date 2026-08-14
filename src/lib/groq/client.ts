export interface GroqSegment {
  start: number;
  end: number;
  text: string;
}

interface RawGroqSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
}

interface GroqVerboseJsonResponse {
  text: string;
  segments?: RawGroqSegment[];
}

// Matches whisper.cpp's own internal default (no_speech_thold) — same
// filtering logic this app used during its local-whisper era, since Groq's
// whisper-large-v3 family exhibits the same style of non-speech bracket-tag
// hallucinations ("[BLANK_AUDIO]", "[MUSIC]") on silent/non-speech audio.
const NO_SPEECH_PROB_THRESHOLD = 0.6;
const NON_SPEECH_TAG_RE = /^[[(][^\n]*[\])]$/;

function isRealSpeech(seg: RawGroqSegment): boolean {
  const text = seg.text.trim();
  if (text.length === 0) return false;
  if ((seg.no_speech_prob ?? 0) > NO_SPEECH_PROB_THRESHOLD) return false;
  if (NON_SPEECH_TAG_RE.test(text)) return false;
  return true;
}

export interface TranscribeAudioOptions {
  apiKey: string;
  model: string;
  audioBlob: Blob;
  filename: string;
}

/**
 * Called directly from the browser — the user's key never touches a server
 * we control, same BYOK pattern as OpenRouter (src/lib/openrouter/client.ts).
 * One call = one recorded window (see src/lib/audio/capture.ts's
 * stop/restart MediaRecorder cycle) — segment start/end below are relative
 * to that window's own start, not the meeting's; callers add their own
 * window offset (see useGroqTranscription.ts).
 */
export async function transcribeAudio({
  apiKey,
  model,
  audioBlob,
  filename,
}: TranscribeAudioOptions): Promise<GroqSegment[]> {
  const formData = new FormData();
  formData.append("file", audioBlob, filename);
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  formData.append("language", "en");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Groq request failed (${response.status}): ${body.slice(0, 300) || response.statusText}`
    );
  }

  const data: GroqVerboseJsonResponse = await response.json();

  if (data.segments && data.segments.length > 0) {
    return data.segments.filter(isRealSpeech).map((seg) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
    }));
  }

  // Defensive fallback: some short/simple clips can come back with a
  // top-level `text` but no `segments` array even under verbose_json.
  // Treat the whole response as one segment spanning the clip.
  const text = data.text?.trim();
  if (!text || NON_SPEECH_TAG_RE.test(text)) return [];
  return [{ start: 0, end: 0, text }];
}
