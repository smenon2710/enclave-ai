"use client";

import { useRef, useState } from "react";
import type { MeetingRecord } from "@/lib/history/types";
import { downloadTextFile, toJson, toMarkdown, toPlainText } from "@/lib/history/export";
import { useStorageQuota } from "@/hooks/useStorageQuota";
import { MarkdownSummary } from "@/components/MarkdownSummary";

interface HistoryModalProps {
  onClose: () => void;
  meetings: MeetingRecord[];
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  onImport: (records: MeetingRecord[]) => Promise<void>;
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function HistoryModal({
  onClose,
  meetings,
  onDelete,
  onDeleteAll,
  onImport,
}: HistoryModalProps) {
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const quotaRatio = useStorageQuota();

  const filtered = meetings.filter((meeting) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (meeting.title.toLowerCase().includes(q)) return true;
    return meeting.segments.some((seg) => seg.text.toLowerCase().includes(q));
  });

  const handleExportAll = () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      meetings,
    };
    downloadTextFile(
      `enclave-ai-backup-${Date.now()}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  };

  const handleDeleteAll = () => {
    if (
      confirm(
        `Delete all ${meetings.length} meeting${meetings.length === 1 ? "" : "s"}? This can't be undone — export a backup first if you want to keep them.`
      )
    ) {
      onDeleteAll();
    }
  };

  const handleImportFile = async (file: File) => {
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const records: unknown = Array.isArray(parsed?.meetings) ? parsed.meetings : parsed;
      if (!Array.isArray(records)) {
        throw new Error("Not a valid Enclave AI backup file");
      }
      await onImport(records as MeetingRecord[]);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col border border-hairline bg-panel p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">History</h2>
          <button
            type="button"
            onClick={onClose}
            className="border border-hairline px-3 py-1 text-xs font-medium text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            Close
          </button>
        </div>

        {quotaRatio !== null && quotaRatio > 0.8 && (
          <div className="mt-3 border border-hairline border-l-2 border-l-signal-amber bg-panel p-2 text-xs text-foreground/90">
            Browser storage is {Math.round(quotaRatio * 100)}% full — export a backup soon.
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or transcript…"
            className="min-w-0 flex-1 border border-hairline bg-transparent px-3 py-1.5 text-sm text-foreground"
          />
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={handleExportAll}
              disabled={meetings.length === 0}
              className="border border-hairline px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
            >
              Export all
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="border border-hairline px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              Import
            </button>
            <button
              type="button"
              onClick={handleDeleteAll}
              disabled={meetings.length === 0}
              className="border border-signal-red px-3 py-1.5 text-xs font-medium text-signal-red transition-colors hover:bg-signal-red/10 disabled:opacity-40"
            >
              Delete all
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
              e.target.value = "";
            }}
          />
        </div>
        {importError && <p className="mt-1.5 text-xs text-signal-red">{importError}</p>}

        <div className="mt-4 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              {meetings.length === 0 ? "No meetings yet." : "No meetings match your search."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.map((meeting) => {
                const isExpanded = expandedId === meeting.id;
                return (
                  <li key={meeting.id} className="border border-hairline">
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : meeting.id)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{meeting.title}</p>
                        <p className="font-mono text-xs text-muted">
                          {formatDuration(meeting.durationSeconds)} · {meeting.segments.length} segments
                          {meeting.summary ? " · summarized" : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted">{isExpanded ? "▲" : "▼"}</span>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-hairline px-3 py-3">
                        <div className="mb-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              downloadTextFile(`${meeting.title}.md`, toMarkdown(meeting), "text/markdown")
                            }
                            className="border border-hairline px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
                          >
                            Export .md
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              downloadTextFile(`${meeting.title}.txt`, toPlainText(meeting), "text/plain")
                            }
                            className="border border-hairline px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
                          >
                            Export .txt
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              downloadTextFile(
                                `${meeting.title}.json`,
                                toJson(meeting),
                                "application/json"
                              )
                            }
                            className="border border-hairline px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
                          >
                            Export .json
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(meeting.id)}
                            className="border border-signal-red px-2.5 py-1 text-xs text-signal-red transition-colors hover:bg-signal-red/10"
                          >
                            Delete
                          </button>
                        </div>

                        {meeting.summary && (
                          <div className="mb-3">
                            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                              Summary
                            </h3>
                            <MarkdownSummary text={meeting.summary} />
                          </div>
                        )}

                        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                          Transcript
                        </h3>
                        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto text-sm">
                          {meeting.segments
                            .slice()
                            .sort((a, b) => a.start - b.start)
                            .map((seg, i) => (
                              <div
                                key={`${seg.channel}-${seg.start}-${i}`}
                                className="leading-relaxed"
                              >
                                <span
                                  className={
                                    seg.channel === "mic"
                                      ? "font-semibold text-signal-cyan"
                                      : "font-semibold text-foreground/70"
                                  }
                                >
                                  {seg.channel === "mic" ? "You: " : "Participants: "}
                                </span>
                                <span className="text-foreground/90">{seg.text}</span>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
