"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_GROQ_MODEL_ID } from "@/lib/groq/models";

const API_KEY_STORAGE_KEY = "enclave-ai:groq-api-key";
const MODEL_STORAGE_KEY = "enclave-ai:groq-model";

type Listener = () => void;
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getApiKeySnapshot(): string {
  return localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
}

function getModelSnapshot(): string {
  return localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_GROQ_MODEL_ID;
}

function getApiKeyServerSnapshot(): string {
  return "";
}

function getModelServerSnapshot(): string {
  return DEFAULT_GROQ_MODEL_ID;
}

/**
 * Both transcription channels (mic + Participants) now go through Groq —
 * this key is required for the app to do anything at all, unlike
 * OpenRouter's key which only gates summarization. Same BYOK pattern:
 * localStorage only, sent directly to Groq from the browser, never through
 * a server this app operates. useSyncExternalStore avoids the hydration
 * mismatch a useState+useEffect read of localStorage would hit.
 */
export function useGroqSettings() {
  const apiKey = useSyncExternalStore(subscribe, getApiKeySnapshot, getApiKeyServerSnapshot);
  const model = useSyncExternalStore(subscribe, getModelSnapshot, getModelServerSnapshot);

  const setApiKey = useCallback((value: string) => {
    if (value) {
      localStorage.setItem(API_KEY_STORAGE_KEY, value);
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
    emitChange();
  }, []);

  const setModel = useCallback((value: string) => {
    localStorage.setItem(MODEL_STORAGE_KEY, value || DEFAULT_GROQ_MODEL_ID);
    emitChange();
  }, []);

  return { apiKey, model, setApiKey, setModel, hasApiKey: apiKey.trim().length > 0 };
}
