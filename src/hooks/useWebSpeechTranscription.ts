"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  getSpeechRecognitionConstructor,
  isWebSpeechSupported,
  type SpeechRecognition,
  type SpeechRecognitionErrorEvent,
  type SpeechRecognitionEvent,
} from "@/lib/stt/webSpeechTypes";
import type { TranscriptSegment } from "@/lib/stt/types";

export type WebSpeechStatus = "idle" | "listening" | "error";

export { isWebSpeechSupported };

function subscribeNever(): () => void {
  // Browser capability doesn't change mid-session — no real external
  // updates to subscribe to, this just satisfies useSyncExternalStore's API.
  return () => {};
}

function getMicEngineSnapshot(): "cloud" | "local" {
  return isWebSpeechSupported() ? "cloud" : "local";
}

function getMicEngineServerSnapshot(): "cloud" | "local" {
  return "local";
}

/**
 * "cloud" (Web Speech API) is preferred when available; "local" (whisper.cpp,
 * same engine as Participants) is the fallback in browsers without it.
 * useSyncExternalStore avoids the hydration mismatch a useState+useEffect
 * read of `window`/`navigator` would hit (server can't know browser
 * capabilities) without the extra render pass an effect+setState costs.
 */
export function useMicEngine(): "cloud" | "local" {
  return useSyncExternalStore(subscribeNever, getMicEngineSnapshot, getMicEngineServerSnapshot);
}

// The API can accept .start() without throwing and then never fire *any*
// event (not even onstart) — observed in headless/sandboxed Chromium, which
// has no working path to the cloud recognition service. If that happens in
// a real user's browser too (e.g. no connectivity), silence would otherwise
// look exactly like "still listening" forever with no indication anything's
// wrong. This watchdog turns that into a visible error instead.
const STARTUP_WATCHDOG_MS = 10000;

/**
 * Wraps the Web Speech API for the mic ("You") channel only — the API has
 * no way to accept a custom MediaStream, so it can't be pointed at the
 * captured tab/system audio for the "Participants" channel (that stays on
 * whisper.cpp). Audio sent through this path goes to the browser vendor's
 * cloud recognition service (Google, in Chrome) — unlike the whisper.cpp
 * path, it does not stay on-device.
 */
export function useWebSpeechTranscription() {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shouldRunRef = useRef(false);
  const startTimeRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors interimText so onend (a plain DOM event handler, not a React
  // effect) can read the latest value synchronously — see onend below.
  const interimTextRef = useRef("");

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState("");
  const [status, setStatus] = useState<WebSpeechStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      shouldRunRef.current = false;
      recognitionRef.current?.abort();
      setStatus("error");
      setErrorMessage(
        "Speech recognition isn't responding — check your internet connection (it requires one) and try again."
      );
    }, STARTUP_WATCHDOG_MS);
  }, [clearWatchdog]);

  /**
   * `meetingEpochMs` should be the same wall-clock origin passed to whisper
   * transcription (see useMeetingRecorder's startMeeting return value) —
   * without it, segments here would be timestamped from whenever this
   * function happens to be called, which can be well after the meeting
   * actually started (mic + participants permission prompts run first),
   * throwing off merge order against the Participants channel. Falls back
   * to "now" only if no shared origin is available.
   */
  const start = useCallback((meetingEpochMs?: number) => {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) {
      setStatus("error");
      setErrorMessage("Web Speech API isn't supported in this browser.");
      return;
    }

    shouldRunRef.current = true;
    startTimeRef.current = meetingEpochMs ?? Date.now();

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => clearWatchdog();

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      clearWatchdog();
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript.trim() ?? "";
        if (result.isFinal) {
          if (text) {
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            setSegments((prev) => [...prev, { channel: "mic", start: elapsed, end: elapsed, text }]);
          }
        } else {
          interim += text;
        }
      }
      interimTextRef.current = interim;
      setInterimText(interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech"/"aborted" are routine (e.g. silence, or our own restart
      // in onend below) — not real failures, don't surface them as errors.
      if (event.error === "no-speech" || event.error === "aborted") return;
      clearWatchdog();
      setErrorMessage(`Speech recognition error: ${event.error}`);
    };

    recognition.onend = () => {
      // Chrome can end a recognition "turn" (continuous=true notwithstanding
      // — see the restart below) while a short utterance is still sitting as
      // *interim*, never having reached isFinal. onresult's isFinal branch
      // is the only place segments get created, so that text would
      // otherwise vanish with zero trace — a real user reported exactly
      // this: brief interjections ("OK") never appearing in "You:" at all.
      // Salvage it as a best-effort final segment before restarting/idling.
      if (interimTextRef.current) {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        const text = interimTextRef.current;
        interimTextRef.current = "";
        setSegments((prev) => [...prev, { channel: "mic", start: elapsed, end: elapsed, text }]);
        setInterimText("");
      }

      if (shouldRunRef.current) {
        // Chrome stops continuous recognition periodically on its own even
        // with continuous=true — restart to sustain it through a meeting.
        try {
          armWatchdog();
          recognition.start();
        } catch {
          // Already running or a transient restart race — ignore.
        }
      } else {
        clearWatchdog();
        setStatus("idle");
      }
    };

    recognitionRef.current = recognition;
    setStatus("listening");
    setErrorMessage(null);
    armWatchdog();
    recognition.start();
  }, [armWatchdog, clearWatchdog]);

  const stop = useCallback(() => {
    shouldRunRef.current = false;
    clearWatchdog();
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setInterimText("");
  }, [clearWatchdog]);

  const reset = useCallback(() => {
    interimTextRef.current = "";
    setSegments([]);
    setInterimText("");
    setErrorMessage(null);
  }, []);

  return { segments, interimText, status, errorMessage, start, stop, reset };
}
