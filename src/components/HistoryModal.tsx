"use client";

import { useRef, useState } from "react";
import type { MeetingRecord } from "@/lib/history/types";
import { downloadTextFile, toJson, toMarkdown, toPlainText } from "@/lib/history/export";
import { useStorageQuota } from "@/hooks/useStorageQuota";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-black/10 bg-white p-5 shadow-lg dark:border-white/10 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">History</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-black/10 px-3 py-1 text-sm dark:border-white/10"
          >
            Close
          </button>
        </div>

        {quotaRatio !== null && quotaRatio > 0.8 && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Browser storage is {Math.round(quotaRatio * 100)}% full — export a backup soon.
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or transcript…"
            className="min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-3 py-1.5 text-sm dark:border-white/10"
          />
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={handleExportAll}
              disabled={meetings.length === 0}
              className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-white/10"
            >
              Export all
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium dark:border-white/10"
            >
              Import
            </button>
            <button
              type="button"
              onClick={handleDeleteAll}
              disabled={meetings.length === 0}
              className="rounded-full border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-40 dark:border-red-900 dark:text-red-400"
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
        {importError && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{importError}</p>
        )}

        <div className="mt-3 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-400">
              {meetings.length === 0 ? "No meetings yet." : "No meetings match your search."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.map((meeting) => {
                const isExpanded = expandedId === meeting.id;
                return (
                  <li
                    key={meeting.id}
                    className="rounded-lg border border-black/10 dark:border-white/10"
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : meeting.id)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                          {meeting.title}
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {formatDuration(meeting.durationSeconds)} · {meeting.segments.length} segments
                          {meeting.summary ? " · summarized" : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-zinc-400">{isExpanded ? "▲" : "▼"}</span>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-black/10 px-3 py-3 dark:border-white/10">
                        <div className="mb-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              downloadTextFile(`${meeting.title}.md`, toMarkdown(meeting), "text/markdown")
                            }
                            className="rounded-full border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                          >
                            Export .md
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              downloadTextFile(`${meeting.title}.txt`, toPlainText(meeting), "text/plain")
                            }
                            className="rounded-full border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
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
                            className="rounded-full border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                          >
                            Export .json
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(meeting.id)}
                            className="rounded-full border border-red-300 px-2.5 py-1 text-xs text-red-600 dark:border-red-900 dark:text-red-400"
                          >
                            Delete
                          </button>
                        </div>

                        {meeting.summary && (
                          <div className="mb-3">
                            <h3 className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                              Summary
                            </h3>
                            <pre className="whitespace-pre-wrap font-sans text-sm text-zinc-800 dark:text-zinc-200">
                              {meeting.summary}
                            </pre>
                          </div>
                        )}

                        <h3 className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                          Transcript
                        </h3>
                        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto text-sm">
                          {meeting.segments
                            .slice()
                            .sort((a, b) => a.start - b.start)
                            .map((seg, i) => (
                              <div key={`${seg.channel}-${seg.start}-${i}`}>
                                <span
                                  className={
                                    seg.channel === "mic"
                                      ? "font-medium text-emerald-700 dark:text-emerald-400"
                                      : "font-medium text-sky-700 dark:text-sky-400"
                                  }
                                >
                                  {seg.channel === "mic" ? "You: " : "Participants: "}
                                </span>
                                <span className="text-zinc-800 dark:text-zinc-200">{seg.text}</span>
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
