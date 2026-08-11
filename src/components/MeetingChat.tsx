"use client";

import { useState, type FormEvent } from "react";
import type { ChatMessage } from "@/lib/openrouter/client";
import type { ChatStatus } from "@/hooks/useMeetingChat";

interface MeetingChatProps {
  hasApiKey: boolean;
  messages: ChatMessage[];
  status: ChatStatus;
  errorMessage: string | null;
  disabled: boolean;
  onAsk: (question: string) => void;
}

export function MeetingChat({
  hasApiKey,
  messages,
  status,
  errorMessage,
  disabled,
  onAsk,
}: MeetingChatProps) {
  const [draft, setDraft] = useState("");

  if (!hasApiKey) {
    return (
      <p className="text-sm text-zinc-400">
        Add your OpenRouter API key in Settings to ask questions about this meeting.
      </p>
    );
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || status === "loading") return;
    onAsk(draft);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-400">
            {disabled
              ? "Record a meeting, then ask questions about it."
              : `Ask anything about this meeting — e.g. "what did we decide?" or "what are my action items?"`}
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "self-end max-w-[85%] rounded-lg bg-foreground px-3 py-1.5 text-sm text-background"
                  : "self-start max-w-[85%] rounded-lg bg-black/5 px-3 py-1.5 text-sm text-zinc-800 dark:bg-white/10 dark:text-zinc-200"
              }
            >
              {m.content}
            </div>
          ))
        )}
        {status === "loading" && <p className="text-sm text-zinc-400">Thinking…</p>}
      </div>

      {status === "error" && errorMessage && (
        <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask a question…"
          disabled={disabled}
          className="min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/10"
        />
        <button
          type="submit"
          disabled={disabled || status === "loading" || !draft.trim()}
          className="shrink-0 rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-white/10"
        >
          Ask
        </button>
      </form>
    </div>
  );
}
