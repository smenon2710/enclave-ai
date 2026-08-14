"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MeetingAudioCapture } from "@/lib/audio/capture";
import {
  getMicStream,
  getParticipantsStream,
  isDisplayAudioCaptureSupported,
} from "@/lib/audio/sources";
import type { AudioChannelLabel, AudioWindow } from "@/lib/audio/types";

export type MeetingStatus =
  | "idle"
  | "requesting-mic"
  | "requesting-participants"
  | "recording"
  | "stopped"
  | "error";

export interface ChannelStats {
  windowsSent: number;
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

const EMPTY_CHANNEL_STATS: ChannelStats = { windowsSent: 0, level: 0 };

export function useMeetingRecorder(onAudioWindow?: (window: AudioWindow) => void) {
  const captureRef = useRef<MeetingAudioCapture | null>(null);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onAudioWindowRef = useRef(onAudioWindow);
  onAudioWindowRef.current = onAudioWindow;

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

  const handleLevel = useCallback((channel: AudioChannelLabel, level: number) => {
    setState((prev) => ({ ...prev, [channel]: { ...prev[channel], level } }));
  }, []);

  const handleWindow = useCallback((window: AudioWindow) => {
    onAudioWindowRef.current?.(window);
    setState((prev) => ({
      ...prev,
      [window.channel]: {
        ...prev[window.channel],
        windowsSent: prev[window.channel].windowsSent + 1,
      },
    }));
  }, []);

  // Surfaces a channel's capture loop dying unexpectedly (see capture.ts's
  // bounded start-retry) as a real, visible error rather than silently
  // going quiet — matches this app's established pattern of never letting a
  // capture failure fail silently (e.g. the AudioContext-suspended and
  // Web-Speech-watchdog fixes from earlier).
  const handleCaptureError = useCallback((message: string) => {
    setState((prev) => ({ ...prev, errorMessage: message }));
  }, []);

  /**
   * Clears a finished meeting's stats back to the pre-meeting idle state
   * without touching permissions/capture — distinct from startMeeting, which
   * immediately re-prompts. Lets the UI go back to a blank "ready" screen on
   * demand rather than only ever resetting as a side effect of starting the
   * next recording.
   */
  const resetToIdle = useCallback(() => {
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
    // Single wall-clock origin for the whole meeting, captured before any
    // async gap (permission prompts etc). Every audio window's offsetSeconds
    // (see capture.ts) is measured against this same instant instead of each
    // channel starting its own clock whenever it happens to actually begin
    // capturing — participants capture in particular can start well after
    // mic, once the share-picker dialog resolves.
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
      await capture.prime(meetingEpochMs);
      const micStream = await getMicStream(micDeviceId);
      await capture.addChannel(
        "mic",
        micStream,
        (level) => handleLevel("mic", level),
        handleWindow,
        handleCaptureError
      );
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
        await capture.addChannel(
          "participants",
          participantsStream,
          (level) => handleLevel("participants", level),
          handleWindow,
          handleCaptureError
        );
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
  }, [handleLevel, handleWindow, handleCaptureError]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      captureRef.current?.stopAll();
    };
  }, []);

  return { state, startMeeting, stopMeeting, resetToIdle };
}
