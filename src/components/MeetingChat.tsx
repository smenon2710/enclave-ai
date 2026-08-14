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
      <p className="text-sm text-muted">
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
          <p className="text-sm text-muted">
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
                  ? "self-end max-w-[85%] bg-foreground px-3 py-1.5 text-sm text-background"
                  : "self-start max-w-[85%] bg-panel-raised px-3 py-1.5 text-sm text-foreground/90"
              }
            >
              {m.content}
            </div>
          ))
        )}
        {status === "loading" && <p className="text-sm text-muted">Thinking…</p>}
      </div>

      {status === "error" && errorMessage && <p className="text-sm text-signal-red">{errorMessage}</p>}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask a question…"
          disabled={disabled}
          className="min-w-0 flex-1 border border-hairline bg-transparent px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || status === "loading" || !draft.trim()}
          className="shrink-0 border border-hairline px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}
