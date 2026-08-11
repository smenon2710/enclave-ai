"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WhisperEngine, EngineTimeoutError } from "@/lib/stt/whisperEngine";
import { loadModel, type ModelFetchProgress } from "@/lib/stt/modelStore";
import type { TranscriptSegment } from "@/lib/stt/types";
import type { AudioChannelLabel, PCMChunk } from "@/lib/audio/types";

const SAMPLE_RATE = 16000;
// Window size trades latency against transcription quality: a shorter
// window means less audio buffered (and thus less wait) before whisper.cpp
// even starts on a chunk, but also less context per inference call and more
// frequent chunk-boundary cuts (see plan.md §4.9). 3s balances "captured
// speech shows up reasonably fast" against not fragmenting too aggressively.
const WINDOW_SAMPLES = SAMPLE_RATE * 3;

export type ModelStatus = "idle" | "downloading" | "initializing" | "ready" | "error";

// Cap auto-restarts so a persistently broken engine surfaces a stable error
// instead of silently retrying (each cycle costs ~25s+ for the watchdog to
// fire) forever.
const MAX_AUTO_RESTARTS = 2;

export function useTranscription(modelUrl: string) {
  const engineRef = useRef<WhisperEngine | null>(null);
  const restartAttemptsRef = useRef(0);
  const [restartToken, setRestartToken] = useState(0);

  const windowBuffers = useRef<Record<AudioChannelLabel, Float32Array[]>>({
    mic: [],
    participants: [],
  });
  const windowSampleCount = useRef<Record<AudioChannelLabel, number>>({
    mic: 0,
    participants: 0,
  });
  const windowStart = useRef<Record<AudioChannelLabel, number>>({
    mic: 0,
    participants: 0,
  });

  const [modelStatus, setModelStatus] = useState<ModelStatus>("idle");
  const [downloadProgress, setDownloadProgress] = useState<ModelFetchProgress | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setModelStatus("downloading");
      setDownloadProgress(null);
      // Deliberately not clearing errorMessage here: when this re-runs after
      // an EngineTimeoutError restart (see flushWindow's catch below), the
      // "restarting single-threaded" notice needs to stay visible through
      // the whole re-init, not flash and vanish the instant it starts.
      // Cleared below only once we're actually back to a working state.
      try {
        const modelBytes = await loadModel(modelUrl, (progress) => {
          if (!cancelled) setDownloadProgress(progress);
        });
        if (cancelled) return;

        setModelStatus("initializing");
        const engine = new WhisperEngine();
        await engine.loadModel(modelBytes);
        if (cancelled) {
          engine.terminate();
          return;
        }
        engineRef.current = engine;
        restartAttemptsRef.current = 0; // fresh budget once actually recovered
        setModelStatus("ready");
        setErrorMessage(null);
      } catch (error) {
        if (!cancelled) {
          setModelStatus("error");
          setErrorMessage(error instanceof Error ? error.message : "Failed to load model");
        }
      }
    }

    init();
    return () => {
      cancelled = true;
      engineRef.current?.terminate();
      engineRef.current = null;
    };
  }, [modelUrl, restartToken]);

  const flushWindow = useCallback((channel: AudioChannelLabel) => {
    const engine = engineRef.current;
    const parts = windowBuffers.current[channel];
    const sampleCount = windowSampleCount.current[channel];
    if (!engine || parts.length === 0 || sampleCount === 0) return;

    const audio = new Float32Array(sampleCount);
    let offset = 0;
    for (const part of parts) {
      audio.set(part, offset);
      offset += part.length;
    }
    const offsetSeconds = windowStart.current[channel];

    windowBuffers.current[channel] = [];
    windowSampleCount.current[channel] = 0;
    windowStart.current[channel] = offsetSeconds + audio.length / SAMPLE_RATE;

    engine
      .transcribe({ channel, audio, offsetSeconds })
      .then((newSegments) => {
        if (newSegments.length === 0) return;
        setSegments((prev) => [...prev, ...newSegments].sort((a, b) => a.start - b.start));
      })
      .catch((error) => {
        if (error instanceof EngineTimeoutError && restartAttemptsRef.current < MAX_AUTO_RESTARTS) {
          restartAttemptsRef.current += 1;
          setErrorMessage("Local transcription stopped responding — restarting…");
          setRestartToken((t) => t + 1);
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : "Transcription failed");
      });
  }, []);

  const pushChunk = useCallback(
    (chunk: PCMChunk) => {
      windowBuffers.current[chunk.channel].push(chunk.samples);
      windowSampleCount.current[chunk.channel] += chunk.samples.length;
      if (windowSampleCount.current[chunk.channel] >= WINDOW_SAMPLES) {
        flushWindow(chunk.channel);
      }
    },
    [flushWindow]
  );

  const flushAll = useCallback(() => {
    flushWindow("mic");
    flushWindow("participants");
  }, [flushWindow]);

  const reset = useCallback(() => {
    windowBuffers.current = { mic: [], participants: [] };
    windowSampleCount.current = { mic: 0, participants: 0 };
    windowStart.current = { mic: 0, participants: 0 };
    setSegments([]);
    setErrorMessage(null);
  }, []);

  return { modelStatus, downloadProgress, segments, errorMessage, pushChunk, flushAll, reset };
}
