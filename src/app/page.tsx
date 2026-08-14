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

const METER_TICKS = 28;

function LevelMeter({ label, active, stats }: { label: string; active: boolean; stats: ChannelStats }) {
  const widthPercent = Math.min(100, Math.round(stats.level * 400));
  const litTicks = active ? Math.round((widthPercent / 100) * METER_TICKS) : 0;

  return (
    <div className="flex flex-col gap-3 border border-hairline bg-panel p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          {label}
        </span>
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${active ? "bg-signal-cyan" : "bg-hairline"}`}
        />
      </div>
      <div className="flex items-center gap-3">
        <div className="flex h-4 flex-1 gap-[2px]">
          {Array.from({ length: METER_TICKS }).map((_, i) => (
            <div
              key={i}
              className={`flex-1 transition-colors duration-100 ${
                i < litTicks ? "bg-signal-cyan" : "bg-panel-raised"
              }`}
            />
          ))}
        </div>
        <span className="w-7 shrink-0 text-right font-mono text-xs text-muted">
          {active ? widthPercent : 0}
        </span>
      </div>
      <div className="font-mono text-[11px] text-muted">
        {stats.windowsSent.toString().padStart(2, "0")} window{stats.windowsSent === 1 ? "" : "s"} sent to
        Groq
      </div>
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "amber" | "red" | "cyan";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "red"
      ? "border-l-signal-red"
      : tone === "cyan"
        ? "border-l-signal-cyan"
        : "border-l-signal-amber";
  return (
    <div className={`border border-hairline border-l-2 ${toneClass} bg-panel p-3 text-sm text-foreground/90`}>
      {children}
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
    <div className="flex flex-1 flex-col bg-background font-sans">
      <header className="sticky top-0 z-10 w-full border-b border-hairline bg-panel/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-4">
            <h1 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-foreground">
              Enclave AI
            </h1>
            {isRecording ? (
              <span className="flex items-center gap-1.5 font-mono text-xs text-signal-amber">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-amber" />
                REC {formatElapsed(state.elapsedSeconds)}
              </span>
            ) : state.status === "stopped" ? (
              <span className="font-mono text-xs text-muted">{formatElapsed(state.elapsedSeconds)}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setIsHistoryOpen(true)}
              className="border border-hairline px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              History
            </button>
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="border border-hairline px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              Settings
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        {hasBanners && (
          <div className="flex flex-col gap-2">
            {!groqSettings.hasApiKey && (
              <Banner tone="amber">
                Add your Groq API key in Settings to enable transcription — required for both mic
                and Participants audio.
              </Banner>
            )}

            {transcription.errorMessage && <Banner tone="amber">{transcription.errorMessage}</Banner>}

            {!state.participantsSupported && (
              <Banner tone="amber">
                This browser doesn&apos;t support tab/system audio sharing — you&apos;ll only be
                able to capture your microphone. Use Chrome or Edge for full dual-channel capture.
              </Banner>
            )}

            {state.status === "error" && state.errorMessage && (
              <Banner tone="red">{state.errorMessage}</Banner>
            )}
          </div>
        )}

        {/* Session controls — mic picker, start/stop/new-meeting, and the
            live level meters live together in one panel so the "control the
            live session" concerns are visually grouped and separate from the
            transcript/summary/ask content below. */}
        <div className="flex flex-col gap-4 border border-hairline bg-panel p-4 sm:p-5">
          {state.participantsSupported && !isRecording && (
            <p className="max-w-3xl text-xs leading-relaxed text-muted">
              Starting will also prompt you to share a tab/screen — that&apos;s the browser&apos;s
              only way to hand a page access to audio playing on your device (the other people on
              the call). Only its audio track is used; the video track is discarded immediately
              and never recorded, transcribed, or sent anywhere. Both channels are transcribed via
              Groq using your own key.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {!isRecording ? (
              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={isBusy || !groqSettings.hasApiKey}
                className="bg-signal-amber px-5 py-2.5 text-sm font-semibold text-signal-amber-ink transition-opacity hover:opacity-90 disabled:opacity-40"
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
                className="border border-signal-red px-5 py-2.5 text-sm font-semibold text-signal-red transition-colors hover:bg-signal-red/10"
              >
                Stop meeting
              </button>
            )}

            {state.status === "stopped" && (
              <button
                type="button"
                onClick={handleNewMeeting}
                className="border border-hairline px-5 py-2.5 text-sm font-medium text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                New meeting
              </button>
            )}

            {micDevices.length > 1 && !isRecording && (
              <label className="flex items-center gap-2 text-xs text-muted sm:ml-auto">
                Microphone
                <select
                  value={micDeviceId}
                  onChange={(e) => setMicDeviceId(e.target.value)}
                  className="min-w-0 max-w-56 border border-hairline bg-transparent px-2 py-1.5 text-xs text-foreground"
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
            <LevelMeter label="You — Mic" active={isRecording} stats={state.mic} />
            <LevelMeter
              label="Participants — Tab/System"
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
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                Transcript
              </h2>
              {allSegments.length > 0 && (
                <span className="font-mono text-[11px] text-muted">{allSegments.length} segments</span>
              )}
            </div>
            <div className="h-[24rem] overflow-y-auto border border-hairline bg-panel p-3 lg:h-[32rem]">
              {allSegments.length === 0 ? (
                <p className="text-sm text-muted">
                  {isRecording
                    ? "Listening… each ~10s window appears here once Groq transcribes it."
                    : "Start a meeting to see a live transcript."}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {allSegments.map((segment, i) => (
                    <div key={`${segment.channel}-${segment.start}-${i}`} className="text-sm">
                      <span className="mr-2 font-mono text-xs text-muted">
                        {formatTimestamp(segment.start)}
                      </span>
                      <span
                        className={
                          segment.channel === "mic"
                            ? "font-semibold text-signal-cyan"
                            : "font-semibold text-foreground/70"
                        }
                      >
                        {segment.channel === "mic" ? "You: " : "Participants: "}
                      </span>
                      <span className="text-foreground/90">{segment.text}</span>
                    </div>
                  ))}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-6 lg:sticky lg:top-20">
            {isFinalizingTranscript && (
              <Banner tone="cyan">
                Finalizing transcript — waiting on the last audio window(s) still processing (
                {finalizingElapsedSeconds}s and counting). Summary and Ask are disabled until this
                settles so they don&apos;t run against a partial transcript.
              </Banner>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  Summary
                </h2>
                <button
                  type="button"
                  onClick={handleGenerateSummary}
                  disabled={
                    !openRouter.hasApiKey ||
                    allSegments.length === 0 ||
                    summary.status === "loading" ||
                    isFinalizingTranscript
                  }
                  className="border border-hairline px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
                >
                  {summary.status === "loading" ? "Generating…" : "Generate summary"}
                </button>
              </div>

              <div className="max-h-80 overflow-y-auto border border-hairline bg-panel p-3">
                {!openRouter.hasApiKey ? (
                  <p className="text-sm text-muted">
                    Add your OpenRouter API key in Settings to enable summaries.
                  </p>
                ) : summary.status === "error" ? (
                  <p className="text-sm text-signal-red">{summary.errorMessage}</p>
                ) : summary.status === "idle" ? (
                  <p className="text-sm text-muted">
                    {allSegments.length === 0
                      ? "Record a meeting, then generate a summary."
                      : "Ready when you are."}
                  </p>
                ) : summary.status === "loading" ? (
                  <p className="text-sm text-muted">Asking {openRouter.model}…</p>
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-foreground/90">
                    {summary.summary}
                  </pre>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Ask</h2>
              <div className="border border-hairline bg-panel p-3">
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
