import type { AudioChannelLabel, AudioWindow } from "./types";

// Groq's turbo model claims ~216x realtime, so unlike the old local-whisper
// pipeline, inference speed is no longer the constraint on window size —
// network round-trip and "how fresh should the live transcript feel" are.
// Larger windows also give the model more context per call, meaning fewer
// mid-sentence chunk-boundary cuts (a real, previously-unresolved
// limitation of the old fixed-window local pipeline — see plan.md §4.9).
const WINDOW_MS = 10000;
const LEVEL_POLL_MS = 100;

// Tried roughly in order of preference — Opus/WebM is small and universally
// supported in Chrome/Edge (this app's primary dual-channel target); mp4/aac
// covers Safari, which doesn't support webm recording.
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return ""; // let the browser pick its own default
}

function rms(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

interface ChannelCapture {
  stream: MediaStream;
  sourceNode: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  levelPollTimer: ReturnType<typeof setInterval>;
  shouldContinue: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  recorder: MediaRecorder | null;
}

/**
 * Owns a single AudioContext shared by both channels, used only for level
 * metering (AnalyserNode) — the actual recorded audio comes from a separate
 * MediaRecorder per channel, wrapping the same raw MediaStream directly.
 * Every ~10s (WINDOW_MS), each channel's MediaRecorder is stopped (flushing
 * one complete, self-contained audio file via onWindow) and immediately
 * restarted — MediaRecorder's periodic `dataavailable` chunks aren't
 * independently decodable on their own, only a full stop/start cycle
 * produces a file Groq's per-request transcription endpoint can accept.
 */
export class MeetingAudioCapture {
  private context: AudioContext | null = null;
  private channels = new Map<AudioChannelLabel, ChannelCapture>();
  private meetingEpochMs = 0;

  private async ensureContext(): Promise<AudioContext> {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
    }
    if (this.context.state === "suspended") {
      // Browsers only auto-resume within a user gesture; if this call landed
      // after an await (e.g. a permission prompt) the gesture can be lost
      // and resume() silently no-ops, leaving the context suspended forever
      // with zero error. One retry covers the common case; if it's still
      // suspended, surface it instead of failing silently.
      await this.context.resume();
      let state = this.context.state as AudioContextState;
      if (state === "suspended") {
        await this.context.resume();
        state = this.context.state as AudioContextState;
      }
      if (state !== "running") {
        throw new Error(
          "Browser blocked audio playback (AudioContext stayed suspended). Try clicking Start meeting again."
        );
      }
    }
    return this.context;
  }

  /**
   * Creates (or resumes) the AudioContext as early as possible in the
   * Start-meeting flow, before any `await` breaks the click's user-gesture
   * association — call this synchronously at the top of the click handler,
   * ahead of getUserMedia's permission-prompt await. `meetingEpochMs` is the
   * shared clock origin (see useMeetingRecorder.ts) every window's
   * offsetSeconds is measured against.
   */
  async prime(meetingEpochMs: number): Promise<void> {
    this.meetingEpochMs = meetingEpochMs;
    await this.ensureContext();
  }

  async addChannel(
    label: AudioChannelLabel,
    stream: MediaStream,
    onLevel: (level: number) => void,
    onWindow: (window: AudioWindow) => void,
    onError: (message: string) => void
  ): Promise<void> {
    const context = await this.ensureContext();
    const sourceNode = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    sourceNode.connect(analyser);

    const timeDomainData = new Float32Array(analyser.fftSize);
    const levelPollTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(timeDomainData);
      onLevel(rms(timeDomainData));
    }, LEVEL_POLL_MS);

    const channel: ChannelCapture = {
      stream,
      sourceNode,
      analyser,
      levelPollTimer,
      shouldContinue: true,
      restartTimer: null,
      recorder: null,
    };
    this.channels.set(label, channel);

    const mimeType = pickSupportedMimeType();
    const MAX_START_RETRIES = 3;

    const startWindow = (retryCount = 0) => {
      if (!channel.shouldContinue) return;

      const chunks: Blob[] = [];
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const windowStartMs = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onstop = () => {
        if (chunks.length > 0) {
          onWindow({
            channel: label,
            blob: new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }),
            offsetSeconds: (windowStartMs - this.meetingEpochMs) / 1000,
          });
        }
        if (channel.shouldContinue) {
          // Deferred to the next task rather than called synchronously here
          // — starting a new MediaRecorder on the same stream immediately
          // inside the previous one's onstop threw NotSupportedError during
          // testing with Chrome's synthetic fake-audio-device (a
          // single-consumer test-harness limitation, confirmed absent with
          // a real microphone stream across 4+ consecutive windows) —
          // deferring to the next task is cheap and removes that risk
          // entirely regardless of its real-world likelihood.
          setTimeout(() => startWindow(), 0);
        } else {
          // Deferred until here (rather than done synchronously in
          // removeChannel) so the stream's tracks stay alive until the
          // recorder has actually finished flushing this final partial
          // window — stopping them earlier risks racing MediaRecorder's own
          // teardown and losing that last bit of audio.
          channel.stream.getTracks().forEach((track) => track.stop());
        }
      };

      channel.recorder = recorder;
      try {
        recorder.start();
      } catch (error) {
        // Bounded retries, then a visible error instead of silently letting
        // this channel's capture loop die forever on a transient failure —
        // same defense-in-depth spirit as this app's other capture-error
        // handling (e.g. the AudioContext-suspended retry in ensureContext).
        if (retryCount < MAX_START_RETRIES) {
          setTimeout(() => startWindow(retryCount + 1), 250);
        } else {
          onError(
            `Recording stopped unexpectedly on the ${label} channel: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        return;
      }

      channel.restartTimer = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, WINDOW_MS);
    };

    startWindow();
  }

  removeChannel(label: AudioChannelLabel): void {
    const channel = this.channels.get(label);
    if (!channel) return;

    // Set before stop() so onstop's restart check sees it and the last
    // partial window still flushes via the same onstop path (no separate
    // "flush" call needed — unlike the old whisper pipeline's flushAll()).
    channel.shouldContinue = false;
    if (channel.restartTimer) clearTimeout(channel.restartTimer);
    clearInterval(channel.levelPollTimer);
    channel.sourceNode.disconnect();
    channel.analyser.disconnect();

    if (channel.recorder && channel.recorder.state !== "inactive") {
      channel.recorder.stop(); // onstop flushes the last window, then stops the stream's tracks itself (see above)
    } else {
      channel.stream.getTracks().forEach((track) => track.stop());
    }

    this.channels.delete(label);
  }

  async stopAll(): Promise<void> {
    for (const label of Array.from(this.channels.keys())) {
      this.removeChannel(label);
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }
}
