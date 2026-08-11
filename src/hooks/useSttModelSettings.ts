"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_WHISPER_MODEL_ID } from "@/lib/stt/models";

const STORAGE_KEY = "enclave-ai:whisper-model-id";

type Listener = () => void;
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_WHISPER_MODEL_ID;
}

function getServerSnapshot(): string {
  return DEFAULT_WHISPER_MODEL_ID;
}

export function useSttModelSettings() {
  const modelId = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setModelId = useCallback((value: string) => {
    localStorage.setItem(STORAGE_KEY, value);
    emitChange();
  }, []);

  return { modelId, setModelId };
}
