"use client";

import { useEffect, useState } from "react";
import { fetchAvailableModels, type OpenRouterModel } from "@/lib/openrouter/models";

interface SettingsModalProps {
  onClose: () => void;
  apiKey: string;
  model: string;
  onApiKeyChange: (value: string) => void;
  onModelChange: (value: string) => void;
}

/** Parent only mounts this while open, so draft state below initializes fresh from current props each time — no sync-on-open effect needed. */
export function SettingsModal({ onClose, apiKey, model, onApiKeyChange, onModelChange }: SettingsModalProps) {
  const [draftKey, setDraftKey] = useState(apiKey);
  const [draftModel, setDraftModel] = useState(model);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

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
        <h2 className="text-lg font-semibold text-black dark:text-zinc-50">OpenRouter settings</h2>
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

        <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Model
          <input
            list="openrouter-models"
            value={draftModel}
            onChange={(e) => setDraftModel(e.target.value)}
            placeholder="openai/gpt-4o-mini"
            className="mt-1 w-full rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm dark:border-white/10"
          />
          <datalist id="openrouter-models">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </datalist>
        </label>
        {modelsError && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Couldn&apos;t load the model list ({modelsError}) — you can still type a model ID
            directly.
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
