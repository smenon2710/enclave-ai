"use client";

import { useEffect, useState } from "react";
import { fetchAvailableModels, type OpenRouterModel } from "@/lib/openrouter/models";
import { GROQ_MODELS } from "@/lib/groq/models";
import { DEFAULT_OPENROUTER_MODEL } from "@/hooks/useOpenRouterSettings";

interface SettingsModalProps {
  onClose: () => void;
  apiKey: string;
  model: string;
  onApiKeyChange: (value: string) => void;
  onModelChange: (value: string) => void;
  groqApiKey: string;
  groqModel: string;
  onGroqApiKeyChange: (value: string) => void;
  onGroqModelChange: (value: string) => void;
}

/** Parent only mounts this while open, so draft state below initializes fresh from current props each time — no sync-on-open effect needed. */
export function SettingsModal({
  onClose,
  apiKey,
  model,
  onApiKeyChange,
  onModelChange,
  groqApiKey,
  groqModel,
  onGroqApiKeyChange,
  onGroqModelChange,
}: SettingsModalProps) {
  const [draftKey, setDraftKey] = useState(apiKey);
  const [draftModel, setDraftModel] = useState(model);
  const [draftGroqKey, setDraftGroqKey] = useState(groqApiKey);
  const [draftGroqModel, setDraftGroqModel] = useState(groqModel);
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
    onGroqApiKeyChange(draftGroqKey.trim());
    onGroqModelChange(draftGroqModel);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md border border-hairline bg-panel p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Settings</h2>

        <div className="mt-4">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-signal-amber" aria-hidden />
            <h3 className="text-sm font-semibold text-foreground">Groq — transcription</h3>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Required — both your mic and Participants audio are transcribed via Groq&apos;s cloud
            API. Stored only in this browser (localStorage) and sent directly to Groq, never
            through a server we control.
          </p>

          <label className="mt-3 block text-xs font-medium text-foreground/80">
            API key
            <input
              type="password"
              value={draftGroqKey}
              onChange={(e) => setDraftGroqKey(e.target.value)}
              placeholder="gsk_..."
              autoComplete="off"
              className="mt-1 w-full border border-hairline bg-transparent px-3 py-2 text-sm text-foreground"
            />
          </label>

          <p className="mt-3 text-xs font-medium text-foreground/80">Model</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {GROQ_MODELS.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm text-foreground/90">
                <input
                  type="radio"
                  name="groq-model"
                  value={m.id}
                  checked={draftGroqModel === m.id}
                  onChange={() => setDraftGroqModel(m.id)}
                  className="accent-signal-amber"
                />
                {m.label}
              </label>
            ))}
          </div>
        </div>

        <hr className="my-5 border-hairline" />

        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-signal-cyan" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">OpenRouter — summary &amp; ask</h3>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          Optional — enables Summary and Ask. Stored only in this browser (localStorage) and sent
          directly to OpenRouter — never through a server we control.
        </p>

        <label className="mt-4 block text-xs font-medium text-foreground/80">
          API key
          <input
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="sk-or-..."
            autoComplete="off"
            className="mt-1 w-full border border-hairline bg-transparent px-3 py-2 text-sm text-foreground"
          />
        </label>

        <div className="mt-4 flex items-center justify-between">
          <label className="text-xs font-medium text-foreground/80">Model</label>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={freeOnly}
                onChange={(e) => setFreeOnly(e.target.checked)}
                className="accent-signal-cyan"
              />
              Free only
            </label>
            <button
              type="button"
              onClick={() => setDraftModel(DEFAULT_OPENROUTER_MODEL)}
              className="text-xs text-muted underline underline-offset-2 hover:text-foreground"
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
          className="mt-1 w-full border border-hairline bg-transparent px-3 py-2 text-sm text-foreground"
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
          <p className="mt-1.5 text-xs text-signal-amber">
            Couldn&apos;t load the model list ({modelsError}) — you can still type a model ID
            directly.
          </p>
        )}
        {!modelsError &&
          models.length > 0 &&
          draftModel.trim().length > 0 &&
          !models.some((m) => m.id === draftModel.trim()) && (
            <p className="mt-1.5 text-xs text-signal-amber">
              &quot;{draftModel.trim()}&quot; doesn&apos;t match any known OpenRouter model ID —
              check for typos, or pick one from the list above.
            </p>
          )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-hairline px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="bg-signal-amber px-4 py-2 text-sm font-semibold text-signal-amber-ink transition-opacity hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
