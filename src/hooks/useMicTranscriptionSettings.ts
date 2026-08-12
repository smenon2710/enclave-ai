"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "enclave-ai:force-local-mic";

type Listener = () => void;
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Overrides the automatic cloud/local pick from useMicEngine (see
 * useWebSpeechTranscription.ts) to always use local whisper.cpp for the mic
 * channel too. Two real reasons found from real-user testing to want this:
 * (1) the Web Speech API has no way to accept a deviceId or MediaStream, so
 * it silently ignores this app's own microphone picker and always uses
 * whatever it resolves internally as "the" mic — whisper.cpp's getUserMedia
 * path does respect the picker; (2) it's a full local-only opt-out for a
 * sensitive call, since Web Speech sends your voice off-device.
 */
export function useForceLocalMic() {
  const forceLocal = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setForceLocal = useCallback((value: boolean) => {
    if (value) {
      localStorage.setItem(STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    emitChange();
  }, []);

  return { forceLocal, setForceLocal };
}
