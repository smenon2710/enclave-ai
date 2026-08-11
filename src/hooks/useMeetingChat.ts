"use client";

import { useCallback, useRef, useState } from "react";
import { askAboutMeeting, type ChatMessage } from "@/lib/openrouter/client";
import { formatTranscriptForPrompt } from "@/lib/stt/format";
import type { TranscriptSegment } from "@/lib/stt/types";

export type ChatStatus = "idle" | "loading" | "error";

export function useMeetingChat() {
  const messagesRef = useRef<ChatMessage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const ask = useCallback(
    async (segments: TranscriptSegment[], apiKey: string, model: string, question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return;

      const priorHistory = messagesRef.current;
      messagesRef.current = [...priorHistory, { role: "user", content: trimmed }];
      setMessages(messagesRef.current);
      setStatus("loading");
      setErrorMessage(null);

      try {
        const transcriptText = formatTranscriptForPrompt(segments);
        const answer = await askAboutMeeting({
          apiKey,
          model,
          transcriptText,
          history: priorHistory,
          question: trimmed,
        });
        messagesRef.current = [...messagesRef.current, { role: "assistant", content: answer }];
        setMessages(messagesRef.current);
        setStatus("idle");
      } catch (error) {
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : "Failed to get an answer");
      }
    },
    []
  );

  const reset = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
    setStatus("idle");
    setErrorMessage(null);
  }, []);

  return { messages, status, errorMessage, ask, reset };
}
