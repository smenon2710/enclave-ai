"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { listMicrophones, type MicrophoneOption } from "@/lib/audio/sources";

const STORAGE_KEY = "enclave-ai:mic-device-id";

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
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

function getServerSnapshot(): string {
  return "";
}

export function useMicrophoneDevice() {
  const deviceId = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [devices, setDevices] = useState<MicrophoneOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadInitial() {
      const list = await listMicrophones();
      if (!cancelled) setDevices(list);
    }
    loadInitial();

    function handleDeviceChange() {
      listMicrophones().then((list) => setDevices(list));
    }

    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
    };
  }, []);

  // Device labels are blank until permission is granted once — call this
  // right after the first successful getUserMedia so labels populate
  // without the user needing to reload the page.
  const refreshDevices = useCallback(() => {
    listMicrophones().then(setDevices);
  }, []);

  const setDeviceId = useCallback((value: string) => {
    if (value) {
      localStorage.setItem(STORAGE_KEY, value);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    emitChange();
  }, []);

  return { deviceId, devices, setDeviceId, refreshDevices };
}
