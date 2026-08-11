"use client";

import { useEffect, useState } from "react";
import { fetchAvailableModels, type OpenRouterModel } from "@/lib/openrouter/models";
import { WHISPER_MODELS } from "@/lib/stt/models";
import { DEFAULT_OPENROUTER_MODEL } from "@/hooks/useOpenRouterSettings";

interface SettingsModalProps {
  onClose: () => void;
  apiKey: string;
  model: string;
  onApiKeyChange: (value: string) => void;
  onModelChange: (value: string) => void;
  sttModelId: string;
  onSttModelChange: (value: string) => void;
}

/** Parent only mounts this while open, so draft state below initializes fresh from current props each time — no sync-on-open effect needed. */
export function SettingsModal({
  onClose,
  apiKey,
  model,
  onApiKeyChange,
  onModelChange,
  sttModelId,
  onSttModelChange,
}: SettingsModalProps) {
  const [draftKey, setDraftKey] = useState(apiKey);
  const [draftModel, setDraftModel] = useState(model);
  const [draftSttModelId, setDraftSttModelId] = useState(sttModelId);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [freeOnly, setFreeOnly] = useState(true);

  const visibleModels = freeOnly ? models.filter((m) => m.isFree) : models;

  useEffect(() => {
    fetchAvailableModels()
      .then(setModels)
      .catch((error) =>
        setModelsError(error instanceof Error ? error.message : "Failed to load model list")
      );
  }, []);

  const handleSave = () => {
    onApiKeyChange(draftKey.trim());
    onModelChange(draftModel.trim());
    onSttModelChange(draftSttModelId);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-black/10 bg-white p-5 shadow-lg dark:border-white/10 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Settings</h2>

        <div className="mt-4">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Transcription model
          </p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Bigger models are noticeably more accurate on real speech, at the cost of a larger
            one-time download. Switching re-downloads (or loads from cache) and restarts the
            transcription engine.
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {WHISPER_MODELS.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="stt-model"
                  value={m.id}
                  checked={draftSttModelId === m.id}
                  onChange={() => setDraftSttModelId(m.id)}
                />
                {m.label}
              </label>
            ))}
          </div>
        </div>

        <hr className="my-4 border-black/10 dark:border-white/10" />

        <h3 className="text-sm font-semibold text-black dark:text-zinc-50">OpenRouter</h3>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Stored only in this browser (localStorage) and sent directly to OpenRouter — never
          through a server we control.
        </p>

        <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          API key
          <input
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="sk-or-..."
            autoComplete="off"
            className="mt-1 w-full rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm dark:border-white/10"
          />
        </label>

        <div className="mt-4 flex items-center justify-between">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Model</label>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={freeOnly}
                onChange={(e) => setFreeOnly(e.target.checked)}
              />
              Free only
            </label>
            <button
              type="button"
              onClick={() => setDraftModel(DEFAULT_OPENROUTER_MODEL)}
              className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              Reset to default
            </button>
          </div>
        </div>
        <input
          list="openrouter-models"
          value={draftModel}
          onChange={(e) => setDraftModel(e.target.value)}
          placeholder="openrouter/free"
          className="mt-1 w-full rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm dark:border-white/10"
        />
        <datalist id="openrouter-models">
          {visibleModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.isFree ? " (free)" : ""}
            </option>
          ))}
        </datalist>
        {modelsError && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Couldn&apos;t load the model list ({modelsError}) — you can still type a model ID
            directly.
          </p>
        )}
        {!modelsError &&
          models.length > 0 &&
          draftModel.trim().length > 0 &&
          !models.some((m) => m.id === draftModel.trim()) && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              &quot;{draftModel.trim()}&quot; doesn&apos;t match any known OpenRouter model ID —
              check for typos, or pick one from the list above.
            </p>
          )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-black/10 px-4 py-2 text-sm dark:border-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
