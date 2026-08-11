"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MeetingAudioCapture } from "@/lib/audio/capture";
import {
  getMicStream,
  getParticipantsStream,
  isDisplayAudioCaptureSupported,
} from "@/lib/audio/sources";
import type { AudioChannelLabel, PCMChunk } from "@/lib/audio/types";

export type MeetingStatus =
  | "idle"
  | "requesting-mic"
  | "requesting-participants"
  | "recording"
  | "stopped"
  | "error";

export interface ChannelStats {
  chunkCount: number;
  sampleCount: number;
  level: number;
}

export interface MeetingRecorderState {
  status: MeetingStatus;
  errorMessage: string | null;
  participantsSupported: boolean;
  participantsActive: boolean;
  mic: ChannelStats;
  participants: ChannelStats;
  elapsedSeconds: number;
}

const EMPTY_CHANNEL_STATS: ChannelStats = { chunkCount: 0, sampleCount: 0, level: 0 };

function rms(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function useMeetingRecorder(onPCMChunk?: (chunk: PCMChunk) => void) {
  const captureRef = useRef<MeetingAudioCapture | null>(null);
  const chunksRef = useRef<Record<AudioChannelLabel, PCMChunk[]>>({
    mic: [],
    participants: [],
  });
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onPCMChunkRef = useRef(onPCMChunk);
  onPCMChunkRef.current = onPCMChunk;

  // Assume support until proven otherwise so SSR and the client's first
  // render agree — the real check only runs client-side (see effect below),
  // since `navigator` doesn't exist during SSR.
  const [state, setState] = useState<MeetingRecorderState>({
    status: "idle",
    errorMessage: null,
    participantsSupported: true,
    participantsActive: false,
    mic: EMPTY_CHANNEL_STATS,
    participants: EMPTY_CHANNEL_STATS,
    elapsedSeconds: 0,
  });

  useEffect(() => {
    setState((prev) => ({
      ...prev,
      participantsSupported: isDisplayAudioCaptureSupported(),
    }));
  }, []);

  const handleChunk = useCallback((chunk: PCMChunk) => {
    chunksRef.current[chunk.channel].push(chunk);
    onPCMChunkRef.current?.(chunk);
    const level = rms(chunk.samples);
    setState((prev) => ({
      ...prev,
      [chunk.channel]: {
        chunkCount: prev[chunk.channel].chunkCount + 1,
        sampleCount: prev[chunk.channel].sampleCount + chunk.samples.length,
        level,
      },
    }));
  }, []);

  /**
   * Clears a finished meeting's stats back to the pre-meeting idle state
   * without touching permissions/capture — distinct from startMeeting, which
   * immediately re-prompts. Lets the UI go back to a blank "ready" screen on
   * demand rather than only ever resetting as a side effect of starting the
   * next recording.
   */
  const resetToIdle = useCallback(() => {
    chunksRef.current = { mic: [], participants: [] };
    setState((prev) => ({
      ...prev,
      status: "idle",
      errorMessage: null,
      participantsActive: false,
      mic: EMPTY_CHANNEL_STATS,
      participants: EMPTY_CHANNEL_STATS,
      elapsedSeconds: 0,
    }));
  }, []);

  const stopMeeting = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (captureRef.current) {
      await captureRef.current.stopAll();
      captureRef.current = null;
    }
    setState((prev) => ({ ...prev, status: "stopped", participantsActive: false }));
  }, []);

  const startMeeting = useCallback(async (micDeviceId?: string): Promise<number | null> => {
    chunksRef.current = { mic: [], participants: [] };
    // Single wall-clock origin for the whole meeting, captured before any
    // async gap (permission prompts etc). The AudioContext created inside
    // capture.prime() right below effectively starts its own currentTime
    // clock at this same instant, so whisper-transcribed segments (which use
    // that clock — see useTranscription.ts) and Web Speech segments (which
    // need this epoch passed in explicitly — see page.tsx) end up on a
    // single shared timeline instead of each channel/engine starting its
    // own clock at 0 whenever it happens to actually begin capturing.
    const meetingEpochMs = Date.now();
    setState((prev) => ({
      ...prev,
      status: "requesting-mic",
      errorMessage: null,
      mic: EMPTY_CHANNEL_STATS,
      participants: EMPTY_CHANNEL_STATS,
      participantsActive: false,
      elapsedSeconds: 0,
    }));

    const capture = new MeetingAudioCapture();
    captureRef.current = capture;

    try {
      // Create/resume the AudioContext before the getUserMedia await below —
      // doing it after would risk losing the click's user-gesture
      // association, which can leave the context silently suspended (see
      // MeetingAudioCapture.prime).
      await capture.prime();
      const micStream = await getMicStream(micDeviceId);
      await capture.addChannel("mic", micStream, handleChunk);
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: "error",
        errorMessage:
          error instanceof Error
            ? `Microphone access failed: ${error.message}`
            : "Microphone access failed.",
      }));
      return null;
    }

    setState((prev) => ({ ...prev, status: "requesting-participants" }));

    try {
      const participantsStream = await getParticipantsStream();
      if (participantsStream) {
        await capture.addChannel("participants", participantsStream, handleChunk);
        setState((prev) => ({ ...prev, participantsActive: true }));
      }
    } catch {
      // User declined/cancelled the share dialog — continue mic-only.
    }

    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setState((prev) => ({
        ...prev,
        elapsedSeconds: Math.floor((Date.now() - startTimeRef.current) / 1000),
      }));
    }, 1000);

    setState((prev) => ({ ...prev, status: "recording" }));
    return meetingEpochMs;
  }, [handleChunk]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      captureRef.current?.stopAll();
    };
  }, []);

  return { state, startMeeting, stopMeeting, resetToIdle };
}
