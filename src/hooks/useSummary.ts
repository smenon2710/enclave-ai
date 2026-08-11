"use client";

import { useCallback, useState } from "react";
import { summarizeTranscript } from "@/lib/openrouter/client";
import { formatTranscriptForPrompt } from "@/lib/stt/format";
import type { TranscriptSegment } from "@/lib/stt/types";

export type SummaryStatus = "idle" | "loading" | "ready" | "error";

export function useSummary() {
  const [status, setStatus] = useState<SummaryStatus>("idle");
  const [summary, setSummary] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const generate = useCallback(
    async (segments: TranscriptSegment[], apiKey: string, model: string) => {
      setStatus("loading");
      setErrorMessage(null);
      try {
        const transcriptText = formatTranscriptForPrompt(segments);
        const result = await summarizeTranscript({ apiKey, model, transcriptText });
        setSummary(result);
        setStatus("ready");
      } catch (error) {
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Summarization failed");
      }
    },
    []
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setSummary(null);
    setErrorMessage(null);
  }, []);

  return { status, summary, errorMessage, generate, reset };
}
