"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMeetingRecorder, type ChannelStats } from "@/hooks/useMeetingRecorder";
import { useGroqTranscription } from "@/hooks/useGroqTranscription";
import { useGroqSettings } from "@/hooks/useGroqSettings";
import { useOpenRouterSettings } from "@/hooks/useOpenRouterSettings";
import { useSummary } from "@/hooks/useSummary";
import { useMeetingChat } from "@/hooks/useMeetingChat";
import { useMeetingHistory } from "@/hooks/useMeetingHistory";
import { useMicrophoneDevice } from "@/hooks/useMicrophoneDevice";
import type { AudioWindow } from "@/lib/audio/types";
import { SettingsModal } from "@/components/SettingsModal";
import { HistoryModal } from "@/components/HistoryModal";
import { MeetingChat } from "@/components/MeetingChat";

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function LevelMeter({ label, active, stats }: { label: string; active: boolean; stats: ChannelStats }) {
  const widthPercent = Math.min(100, Math.round(stats.level * 400));
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <div className="flex items-center justify-between text-sm font-medium">
        <span>{label}</span>
        <span className={active ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}>
          {active ? "live" : "inactive"}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-100"
          style={{ width: `${active ? widthPercent : 0}%` }}
        />
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">
        {stats.windowsSent} window{stats.windowsSent === 1 ? "" : "s"} sent to Groq
      </div>
    </div>
  );
}

export default function Home() {
  const groqSettings = useGroqSettings();
  const transcription = useGroqTranscription(groqSettings.apiKey, groqSettings.model);
  const openRouter = useOpenRouterSettings();
  const summary = useSummary();
  const chat = useMeetingChat();
  const {
    meetings,
    save: saveMeetingToHistory,
    remove: removeMeetingFromHistory,
    removeAll: removeAllMeetingHistory,
    importAll: importMeetingHistory,
  } = useMeetingHistory();
  const { deviceId: micDeviceId, devices: micDevices, setDeviceId: setMicDeviceId, refreshDevices } =
    useMicrophoneDevice();

  const handleAudioWindow = useCallback(
    (window: AudioWindow) => {
      transcription.pushWindow(window);
    },
    [transcription]
  );

  const { state, startMeeting, stopMeeting, resetToIdle } = useMeetingRecorder(handleAudioWindow);
  const isRecording = state.status === "recording";
  const isBusy = state.status === "requesting-mic" || state.status === "requesting-participants";
  // Groq requests are independent per ~10s window (see capture.ts) rather
  // than serialized through one blocking local engine, so this should
  // normally clear within a few seconds of Stop — but the very last window
  // is still delivered asynchronously (capture.ts's onstop fires after
  // stopMeeting() has already resolved), so Summary/Ask still need to wait
  // for it rather than assume the transcript is complete the instant
  // recording stops.
  const isFinalizingTranscript = state.status === "stopped" && transcription.pendingRequestCount > 0;
  // Surfaces exactly how long finalizing actually takes. Reset to 0 happens
  // in handleStop (a real event handler, not here) — this project's lint
  // rules (React Compiler purity) forbid both reading Date.now() during
  // render and calling setState synchronously in an effect body, so this
  // effect only manages the ticking interval once finalizing is already
  // known to be underway.
  const [finalizingElapsedSeconds, setFinalizingElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!isFinalizingTranscript) return;
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setFinalizingElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isFinalizingTranscript]);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const currentMeetingRef = useRef<{ id: string; startedAt: number } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const allSegments = transcription.segments;

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [allSegments.length]);

  // Upserts the current meeting into history whenever it changes after
  // stopping — covers late-arriving segments from the final window and a
  // summary generated afterward, without needing to track exactly when
  // async transcription/summarization settle.
  useEffect(() => {
    if (state.status !== "stopped") return;
    if (!currentMeetingRef.current) return;
    if (allSegments.length === 0) return;
    const { id, startedAt } = currentMeetingRef.current;
    void saveMeetingToHistory({
      id,
      title: `Meeting — ${new Date(startedAt).toLocaleString()}`,
      startedAt,
      durationSeconds: state.elapsedSeconds,
      segments: allSegments,
      summary: summary.summary,
      summaryModel: summary.summary ? openRouter.model : null,
    });
  }, [
    state.status,
    state.elapsedSeconds,
    allSegments,
    summary.summary,
    openRouter.model,
    saveMeetingToHistory,
  ]);

  const handleStart = async () => {
    currentMeetingRef.current = { id: crypto.randomUUID(), startedAt: Date.now() };
    transcription.reset();
    summary.reset();
    chat.reset();
    await startMeeting(micDeviceId || undefined);
    refreshDevices(); // labels are blank pre-permission; populate now that it's granted
  };

  const handleStop = async () => {
    setFinalizingElapsedSeconds(0);
    await stopMeeting();
  };

  // Clears a finished meeting's transcript/summary/chat back to a blank
  // "ready" screen without prompting for mic/participants permissions again
  // — a deliberate, separate action from Start (which resets the same state
  // as a side effect of immediately starting the next recording).
  const handleNewMeeting = () => {
    currentMeetingRef.current = null;
    transcription.reset();
    summary.reset();
    chat.reset();
    resetToIdle();
  };

  const handleGenerateSummary = () => {
    void summary.generate(allSegments, openRouter.apiKey, openRouter.model);
  };

  const handleAsk = (question: string) => {
    void chat.ask(allSegments, openRouter.apiKey, openRouter.model, question);
  };

  // Purely cosmetic: whether to render the wrapping banner container at all,
  // so it doesn't leave an empty gapped div when nothing needs showing. Each
  // banner below still applies its own (more specific) condition.
  const hasBanners =
    !groqSettings.hasApiKey ||
    !!transcription.errorMessage ||
    !state.participantsSupported ||
    (state.status === "error" && !!state.errorMessage);

  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-4 font-sans dark:bg-black sm:px-6">
      <main className="flex w-full max-w-6xl flex-col gap-6 py-8 sm:py-12">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
              Enclave AI
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Both your voice and Participants&apos; audio are transcribed via Groq&apos;s cloud
              API using your own key — audio leaves this device for transcription. History and
              your keys still never touch a server we control.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setIsHistoryOpen(true)}
              className="rounded-full border border-black/10 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-black/5 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/5"
            >
              History
            </button>
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="rounded-full border border-black/10 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-black/5 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/5"
            >
              Settings
            </button>
          </div>
        </div>

        {hasBanners && (
          <div className="flex flex-col gap-2">
            {!groqSettings.hasApiKey && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Add your Groq API key in Settings to enable transcription — required for both mic
                and Participants audio.
              </div>
            )}

            {transcription.errorMessage && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {transcription.errorMessage}
              </div>
            )}

            {!state.participantsSupported && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                This browser doesn&apos;t support tab/system audio sharing — you&apos;ll only be
                able to capture your microphone. Use Chrome or Edge for full dual-channel capture.
              </div>
            )}

            {state.status === "error" && state.errorMessage && (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                {state.errorMessage}
              </div>
            )}
          </div>
        )}

        {/* Session controls — mic picker, start/stop/new-meeting, and the
            live level meters live together in one panel so the "control the
            live session" concerns are visually grouped and separate from the
            transcript/summary/ask content below. */}
        <div className="flex flex-col gap-4 rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-950 sm:p-5">
          {state.participantsSupported && !isRecording && (
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              Starting will also prompt you to share a tab/screen — that&apos;s the browser&apos;s
              only way to hand a page access to audio playing on your device (the other people on
              the call). Only its audio track is used; the video track is discarded immediately
              and never recorded, transcribed, or sent anywhere.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {!isRecording ? (
              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={isBusy || !groqSettings.hasApiKey}
                className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
              >
                {state.status === "requesting-mic"
                  ? "Requesting microphone…"
                  : state.status === "requesting-participants"
                    ? "Requesting participants audio…"
                    : "Start meeting"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="rounded-full border border-red-300 px-5 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
              >
                Stop meeting
              </button>
            )}

            {state.status === "stopped" && (
              <button
                type="button"
                onClick={handleNewMeeting}
                className="rounded-full border border-black/10 px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-black/5 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/5"
              >
                New meeting
              </button>
            )}

            {isRecording && (
              <span className="flex items-center gap-1.5 text-sm font-medium text-red-600 dark:text-red-400">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
                Recording
              </span>
            )}
            {(isRecording || state.status === "stopped") && (
              <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">
                {formatElapsed(state.elapsedSeconds)}
              </span>
            )}

            {micDevices.length > 1 && !isRecording && (
              <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400 sm:ml-auto">
                Microphone
                <select
                  value={micDeviceId}
                  onChange={(e) => setMicDeviceId(e.target.value)}
                  className="min-w-0 max-w-56 rounded-md border border-black/10 bg-transparent px-2 py-1 text-sm dark:border-white/10"
                >
                  <option value="">Browser default</option>
                  {micDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <LevelMeter label="You (mic) — Groq" active={isRecording} stats={state.mic} />
            <LevelMeter
              label="Participants (tab/system) — Groq"
              active={isRecording && state.participantsActive}
              stats={state.participants}
            />
          </div>
        </div>

        {/* Transcript is the main, wide content; Summary/Ask form a sidebar
            on large screens (sticky, so they stay visible while scrolling a
            long transcript) and stack below it on narrow screens. */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Transcript</h2>
              {allSegments.length > 0 && (
                <span className="text-xs text-zinc-400">{allSegments.length} segments</span>
              )}
            </div>
            <div className="h-[24rem] overflow-y-auto rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-zinc-950 lg:h-[32rem]">
              {allSegments.length === 0 ? (
                <p className="text-sm text-zinc-400">
                  {isRecording
                    ? "Listening… each ~10s window appears here once Groq transcribes it."
                    : "Start a meeting to see a live transcript."}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {allSegments.map((segment, i) => (
                    <div key={`${segment.channel}-${segment.start}-${i}`} className="text-sm">
                      <span className="mr-2 font-mono text-xs text-zinc-400">
                        {formatTimestamp(segment.start)}
                      </span>
                      <span
                        className={
                          segment.channel === "mic"
                            ? "font-medium text-emerald-700 dark:text-emerald-400"
                            : "font-medium text-sky-700 dark:text-sky-400"
                        }
                      >
                        {segment.channel === "mic" ? "You: " : "Participants: "}
                      </span>
                      <span className="text-zinc-800 dark:text-zinc-200">{segment.text}</span>
                    </div>
                  ))}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-6 lg:sticky lg:top-6">
            {isFinalizingTranscript && (
              <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
                Finalizing transcript — waiting on the last audio window(s) still processing (
                {finalizingElapsedSeconds}s and counting). Summary and Ask are disabled until this
                settles so they don&apos;t run against a partial transcript.
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Summary</h2>
                <button
                  type="button"
                  onClick={handleGenerateSummary}
                  disabled={
                    !openRouter.hasApiKey ||
                    allSegments.length === 0 ||
                    summary.status === "loading" ||
                    isFinalizingTranscript
                  }
                  className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-black/5 disabled:opacity-40 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/5"
                >
                  {summary.status === "loading" ? "Generating…" : "Generate summary"}
                </button>
              </div>

              <div className="max-h-80 overflow-y-auto rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-zinc-950">
                {!openRouter.hasApiKey ? (
                  <p className="text-sm text-zinc-400">
                    Add your OpenRouter API key in Settings to enable summaries.
                  </p>
                ) : summary.status === "error" ? (
                  <p className="text-sm text-red-600 dark:text-red-400">{summary.errorMessage}</p>
                ) : summary.status === "idle" ? (
                  <p className="text-sm text-zinc-400">
                    {allSegments.length === 0
                      ? "Record a meeting, then generate a summary."
                      : "Ready when you are."}
                  </p>
                ) : summary.status === "loading" ? (
                  <p className="text-sm text-zinc-400">Asking {openRouter.model}…</p>
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-zinc-800 dark:text-zinc-200">
                    {summary.summary}
                  </pre>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Ask</h2>
              <div className="rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-zinc-950">
                <MeetingChat
                  hasApiKey={openRouter.hasApiKey}
                  messages={chat.messages}
                  status={chat.status}
                  errorMessage={chat.errorMessage}
                  disabled={allSegments.length === 0 || isFinalizingTranscript}
                  onAsk={handleAsk}
                />
              </div>
            </div>
          </div>
        </div>
      </main>

      {isSettingsOpen && (
        <SettingsModal
          onClose={() => setIsSettingsOpen(false)}
          apiKey={openRouter.apiKey}
          model={openRouter.model}
          onApiKeyChange={openRouter.setApiKey}
          onModelChange={openRouter.setModel}
          groqApiKey={groqSettings.apiKey}
          groqModel={groqSettings.model}
          onGroqApiKeyChange={groqSettings.setApiKey}
          onGroqModelChange={groqSettings.setModel}
        />
      )}

      {isHistoryOpen && (
        <HistoryModal
          onClose={() => setIsHistoryOpen(false)}
          meetings={meetings}
          onDelete={(id) => void removeMeetingFromHistory(id)}
          onDeleteAll={() => void removeAllMeetingHistory()}
          onImport={importMeetingHistory}
        />
      )}
    </div>
  );
}
