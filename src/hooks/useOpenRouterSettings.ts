"use client";

import { useCallback, useSyncExternalStore } from "react";

const API_KEY_STORAGE_KEY = "enclave-ai:openrouter-api-key";
const MODEL_STORAGE_KEY = "enclave-ai:openrouter-model";
// OpenRouter's own free-tier auto-router — always $0, self-maintaining
// (picks from whatever free models are currently available rather than us
// hardcoding a specific model ID that could get deprecated/renamed).
export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";

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
  return localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_OPENROUTER_MODEL;
}

function getApiKeyServerSnapshot(): string {
  return "";
}

function getModelServerSnapshot(): string {
  return DEFAULT_OPENROUTER_MODEL;
}

/**
 * localStorage is browser-only, so this uses useSyncExternalStore rather
 * than a read-in-effect: it lets the server/first-client-render both render
 * the same snapshot (avoiding a hydration mismatch) and then syncs to the
 * real value, without the extra render pass a `useEffect` + `setState`
 * would add.
 */
export function useOpenRouterSettings() {
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
    localStorage.setItem(MODEL_STORAGE_KEY, value || DEFAULT_OPENROUTER_MODEL);
    emitChange();
  }, []);

  return { apiKey, model, setApiKey, setModel, hasApiKey: apiKey.trim().length > 0 };
}
