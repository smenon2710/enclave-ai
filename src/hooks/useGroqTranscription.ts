"use client";

import { useCallback, useState } from "react";
import { transcribeAudio } from "@/lib/groq/client";
import type { TranscriptSegment } from "@/lib/stt/types";
import type { AudioWindow } from "@/lib/audio/types";

// Unlike the old local-whisper era's single Worker/queue, there's nothing to
// serialize through here — Groq requests are independent, stateless HTTP calls,
// so mic and participants windows (and even overlapping windows within one
// channel, on a slow connection) can be in flight concurrently. Ordering in
// the UI comes from re-sorting segments by `start` after every insert, not
// from request order.
let windowCounter = 0;

export function useGroqTranscription(apiKey: string, model: string) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Number of transcribeAudio() calls dispatched but not yet settled — lets
  // callers show a "still finalizing" state after Stop instead of assuming
  // the transcript is complete the instant recording stops (the very last
  // window is delivered asynchronously by capture.ts's onstop handler,
  // which can fire after stopMeeting() has already resolved).
  const [pendingRequestCount, setPendingRequestCount] = useState(0);

  const pushWindow = useCallback(
    (window: AudioWindow) => {
      if (!apiKey) {
        // No key configured -- nothing to send. page.tsx gates Start on
        // having a key, so this is defensive, not the expected path.
        return;
      }

      const ext = window.blob.type.includes("mp4") ? "mp4" : "webm";
      windowCounter += 1;
      const filename = `chunk-${windowCounter}.${ext}`;

      setPendingRequestCount((c) => c + 1);
      transcribeAudio({ apiKey, model, audioBlob: window.blob, filename })
        .then((rawSegments) => {
          setErrorMessage(null); // a later success clears an earlier transient blip
          if (rawSegments.length === 0) return;
          const newSegments: TranscriptSegment[] = rawSegments.map((seg) => ({
            channel: window.channel,
            start: window.offsetSeconds + seg.start,
            end: window.offsetSeconds + seg.end,
            text: seg.text,
          }));
          setSegments((prev) => [...prev, ...newSegments].sort((a, b) => a.start - b.start));
        })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : "Transcription failed");
        })
        .finally(() => setPendingRequestCount((c) => c - 1));
    },
    [apiKey, model]
  );

  const reset = useCallback(() => {
    setSegments([]);
    setErrorMessage(null);
    setPendingRequestCount(0);
  }, []);

  return { segments, errorMessage, pendingRequestCount, pushWindow, reset };
}
