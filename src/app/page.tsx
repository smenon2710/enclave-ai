"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMeetingRecorder, type ChannelStats } from "@/hooks/useMeetingRecorder";
import { useTranscription } from "@/hooks/useTranscription";
import { useWebSpeechTranscription, useMicEngine } from "@/hooks/useWebSpeechTranscription";
import { useOpenRouterSettings } from "@/hooks/useOpenRouterSettings";
import { useSummary } from "@/hooks/useSummary";
import { useMeetingChat } from "@/hooks/useMeetingChat";
import { useMeetingHistory } from "@/hooks/useMeetingHistory";
import { useMicrophoneDevice } from "@/hooks/useMicrophoneDevice";
import { useSttModelSettings } from "@/hooks/useSttModelSettings";
import { useForceLocalMic } from "@/hooks/useMicTranscriptionSettings";
import { getWhisperModelUrl } from "@/lib/stt/models";
import type { PCMChunk } from "@/lib/audio/types";
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
        {stats.chunkCount} chunks · {stats.sampleCount.toLocaleString()} samples @16kHz
      </div>
    </div>
  );
}

function ModelStatusBanner({
  status,
  progress,
  errorMessage,
}: {
  status: ReturnType<typeof useTranscription>["modelStatus"];
  progress: ReturnType<typeof useTranscription>["downloadProgress"];
  errorMessage: string | null;
}) {
  if (status === "ready") return null;

  if (status === "error") {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        Local (Participants) transcription model failed to load{errorMessage ? `: ${errorMessage}` : "."}
      </div>
    );
  }

  const percent =
    progress?.totalBytes && progress.totalBytes > 0
      ? Math.round((progress.loadedBytes / progress.totalBytes) * 100)
      : null;

  return (
    <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
      {status === "downloading"
        ? `Downloading local transcription model (for Participants)${percent !== null ? ` (${percent}%)` : "…"}`
        : status === "initializing"
          ? "Initializing whisper.cpp (WASM)…"
          : "Loading local transcription model…"}
    </div>
  );
}

export default function Home() {
  const sttModel = useSttModelSettings();
  // The env override exists for local dev convenience (point at a local
  // model file instead of re-downloading from Hugging Face every reload)
  // and takes priority over the Settings picker.
  const modelUrl = process.env.NEXT_PUBLIC_WHISPER_MODEL_URL ?? getWhisperModelUrl(sttModel.modelId);
  const transcription = useTranscription(modelUrl);
  const webSpeech = useWebSpeechTranscription();
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

  // "cloud" (Web Speech API — fast, but your voice is sent to the browser
  // vendor's recognition service) when available, else "local" (whisper.cpp,
  // same engine as Participants). The Settings toggle below can force
  // "local" even when the cloud path is available — Web Speech has no way
  // to accept a deviceId or MediaStream, so it silently ignores the
  // microphone picker above and always captures whatever it resolves
  // internally as "the" mic; whisper.cpp's getUserMedia path does respect it.
  const forceLocalMic = useForceLocalMic();
  const detectedMicEngine = useMicEngine();
  const micEngine = forceLocalMic.forceLocal ? "local" : detectedMicEngine;

  const handlePCMChunk = useCallback(
    (chunk: PCMChunk) => {
      // Mic audio only goes to whisper when Web Speech isn't handling it —
      // otherwise Web Speech handles mic transcription and whisper only
      // processes Participants (which Web Speech can't capture at all, see
      // useWebSpeechTranscription.ts).
      if (chunk.channel === "participants" || micEngine === "local") {
        transcription.pushChunk(chunk);
      }
    },
    [transcription, micEngine]
  );

  const { state, startMeeting, stopMeeting, resetToIdle } = useMeetingRecorder(handlePCMChunk);
  const isRecording = state.status === "recording";
  const isBusy = state.status === "requesting-mic" || state.status === "requesting-participants";
  // WhisperEngine serializes transcribe() calls through one queue — if live
  // transcription falls behind real-time during a long/busy call, a backlog
  // can still be draining after Stop is clicked (flushAll just adds two more
  // jobs to the end of it). Summary/Ask should wait for it, not run against
  // a transcript that's still missing its last stretch. Scoped to "stopped"
  // only — pendingJobCount is also nonzero continuously *during* normal live
  // recording (a window is always in flight), where "finalizing" would be a
  // misleading label and there's no reason to block Summary/Ask anyway.
  const isFinalizingTranscript = state.status === "stopped" && transcription.pendingJobCount > 0;
  // Surfaces exactly how long finalizing actually takes (a real user
  // reported it feeling slow, with no way to tell how slow) — ticks while
  // isFinalizingTranscript is true, resets once it clears.
  // Reset to 0 happens in handleStop (a real event handler, not here) — this
  // project's lint rules (React Compiler purity) forbid both reading Date.now()
  // during render and calling setState synchronously in an effect body, so
  // this effect only manages the ticking interval once finalizing is
  // already known to be underway.
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

  // Merges the two independent transcription sources into one chronological
  // transcript for display, History, Summary, and Ask — mic segments come
  // from whichever of Web Speech/whisper is actually handling that channel
  // this session (see micEngine above); Participants always comes from
  // whisper, since Web Speech has no way to listen to that stream at all.
  const allSegments = useMemo(
    () => [...transcription.segments, ...webSpeech.segments].sort((a, b) => a.start - b.start),
    [transcription.segments, webSpeech.segments]
  );

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [allSegments.length]);

  // Upserts the current meeting into history whenever it changes after
  // stopping — covers late-arriving segments from flushAll's final window
  // and a summary generated afterward, without needing to track exactly
  // when async transcription/summarization settle.
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
    webSpeech.reset();
    summary.reset();
    chat.reset();
    const meetingEpochMs = await startMeeting(micDeviceId || undefined);
    // null means mic capture itself failed (see useMeetingRecorder) — don't
    // start cloud speech recognition against a meeting that never began, and
    // don't pass along a missing epoch that would make its timestamps drift
    // from whisper's.
    if (meetingEpochMs !== null && micEngine === "cloud") webSpeech.start(meetingEpochMs);
    refreshDevices(); // labels are blank pre-permission; populate now that it's granted
  };

  const handleStop = async () => {
    setFinalizingElapsedSeconds(0);
    await stopMeeting();
    transcription.flushAll();
    webSpeech.stop();
  };

  // Clears a finished meeting's transcript/summary/chat back to a blank
  // "ready" screen without prompting for mic/participants permissions again
  // — a deliberate, separate action from Start (which resets the same state
  // as a side effect of immediately starting the next recording).
  const handleNewMeeting = () => {
    currentMeetingRef.current = null;
    transcription.reset();
    webSpeech.reset();
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
    transcription.modelStatus !== "ready" ||
    !!transcription.errorMessage ||
    !!webSpeech.errorMessage ||
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
              {micEngine === "cloud"
                ? "Your voice is transcribed via your browser's cloud speech service (fast, but sent off-device). Participants' audio stays fully local via on-device Whisper."
                : "Runs entirely in this browser — audio, transcription, and history never leave your device."}
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
            <ModelStatusBanner
              status={transcription.modelStatus}
              progress={transcription.downloadProgress}
              errorMessage={transcription.errorMessage}
            />

            {transcription.modelStatus !== "error" && transcription.errorMessage && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {transcription.errorMessage}
              </div>
            )}

            {webSpeech.errorMessage && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {webSpeech.errorMessage}
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
                disabled={isBusy || transcription.modelStatus !== "ready"}
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
            <LevelMeter
              label={`You (mic) — ${micEngine === "cloud" ? "cloud" : "local"}`}
              active={isRecording}
              stats={state.mic}
            />
            <LevelMeter
              label="Participants (tab/system) — local"
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
              {allSegments.length === 0 && !webSpeech.interimText ? (
                <p className="text-sm text-zinc-400">
                  {isRecording ? "Listening…" : "Start a meeting to see a live transcript."}
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
                  {webSpeech.interimText && (
                    <div className="text-sm italic text-zinc-400">
                      <span className="mr-2 font-mono text-xs text-zinc-400">…</span>
                      <span className="font-medium text-emerald-700/70 dark:text-emerald-400/70">
                        You:{" "}
                      </span>
                      {webSpeech.interimText}
                    </div>
                  )}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-6 lg:sticky lg:top-6">
            {isFinalizingTranscript && (
              <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
                Finalizing transcript — still processing the last bit of local audio (
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
          sttModelId={sttModel.modelId}
          onSttModelChange={sttModel.setModelId}
          forceLocalMic={forceLocalMic.forceLocal}
          onForceLocalMicChange={forceLocalMic.setForceLocal}
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
