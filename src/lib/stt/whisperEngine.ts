import type { AudioChannelLabel } from "@/lib/audio/types";
import type { TranscriptSegment } from "./types";

interface RawSegment {
  start: number;
  end: number;
  text: string;
  noSpeechProb: number;
}

// Matches whisper.cpp's own internal default (no_speech_thold) — segments
// this "confident" that there's no speech are near-certainly a hallucinated
// bracket tag ("[BLANK_AUDIO]") or garbage, not real content worth keeping.
const NO_SPEECH_PROB_THRESHOLD = 0.6;

// Defense in depth alongside the probability check: whisper's non-speech
// annotations ("[BLANK_AUDIO]", "[MUSIC]", "(silence)", etc.) are
// consistently a single bracket/paren-wrapped tag with nothing else in the
// segment — real transcribed speech essentially never looks like that.
// Catches cases the probability alone misses (e.g. it's confident there's
// *some* non-speech audio like music, which isn't the same thing as "no
// speech" in whisper's own scoring).
const NON_SPEECH_TAG_RE = /^[[(][^\n]*[\])]$/;

function isRealSpeech(seg: RawSegment): boolean {
  const text = seg.text.trim();
  if (text.length === 0) return false;
  if (seg.noSpeechProb > NO_SPEECH_PROB_THRESHOLD) return false;
  if (NON_SPEECH_TAG_RE.test(text)) return false;
  return true;
}

type WorkerOutMessage =
  | { type: "ready" }
  | { type: "model-loaded"; ok: boolean }
  | {
      type: "transcribe-done";
      jobId: string;
      channel: AudioChannelLabel;
      segments: RawSegment[];
    }
  | { type: "error"; message: string; jobId?: string };

export interface TranscribeOptions {
  channel: AudioChannelLabel;
  audio: Float32Array;
  offsetSeconds: number;
  nthreads?: number;
}

interface PendingJob {
  resolve: (segments: TranscriptSegment[]) => void;
  reject: (err: Error) => void;
  offsetSeconds: number;
}

// Generous headroom above any observed real transcription time for a single
// ~3s window (single-threaded CPU inference of that much audio typically
// finishes in a few seconds) — this exists specifically to catch a stuck
// multi-threaded WASM worker, which in some environments hangs forever with
// zero error (see plan.md §4.7). A false-positive timeout just costs one
// transcription window; a real hang with no timeout would freeze the app.
const TRANSCRIBE_TIMEOUT_MS = 25000;

/** Thrown when a transcribe() call hits TRANSCRIBE_TIMEOUT_MS — signals the
 * worker is stuck and the caller should treat this engine as dead. */
export class EngineTimeoutError extends Error {
  constructor() {
    super("Transcription worker stopped responding (multi-threaded WASM hang)");
    this.name = "EngineTimeoutError";
  }
}

/** Thin wrapper around the whisper.cpp WASM Worker — see public/workers/whisper-worker.js. */
export class WhisperEngine {
  private worker: Worker;
  private readyPromise: Promise<void>;
  private jobCounter = 0;
  private pendingJobs = new Map<string, PendingJob>();
  private dead = false;
  // transcribe() runs synchronously inside the worker (see whisper-worker.js)
  // and blocks its event loop for the job's duration, so this queue just
  // serializes calls instead of piling up postMessage calls the worker can't
  // act on concurrently.
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.worker = new Worker("/workers/whisper-worker.js");
    this.readyPromise = new Promise((resolve) => {
      const onMessage = (event: MessageEvent<WorkerOutMessage>) => {
        if (event.data.type === "ready") {
          this.worker.removeEventListener("message", onMessage);
          resolve();
        }
      };
      this.worker.addEventListener("message", onMessage);
    });
    this.worker.addEventListener("message", (event) =>
      this.handleMessage(event.data as WorkerOutMessage)
    );
  }

  private handleMessage(msg: WorkerOutMessage): void {
    if (msg.type === "transcribe-done") {
      const job = this.pendingJobs.get(msg.jobId);
      if (!job) return;
      this.pendingJobs.delete(msg.jobId);
      job.resolve(
        msg.segments
          .filter(isRealSpeech)
          .map((seg) => ({
            channel: msg.channel,
            start: job.offsetSeconds + seg.start,
            end: job.offsetSeconds + seg.end,
            text: seg.text.trim(),
          }))
      );
    } else if (msg.type === "error" && msg.jobId) {
      const job = this.pendingJobs.get(msg.jobId);
      if (!job) return;
      this.pendingJobs.delete(msg.jobId);
      job.reject(new Error(msg.message));
    }
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async loadModel(modelBytes: ArrayBuffer): Promise<void> {
    await this.ready();
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerOutMessage>) => {
        if (event.data.type === "model-loaded") {
          this.worker.removeEventListener("message", onMessage);
          if (event.data.ok) resolve();
          else reject(new Error("Failed to initialize whisper context"));
        } else if (event.data.type === "error") {
          this.worker.removeEventListener("message", onMessage);
          reject(new Error(event.data.message));
        }
      };
      this.worker.addEventListener("message", onMessage);
      this.worker.postMessage({ type: "load-model", modelBytes }, [modelBytes]);
    });
  }

  transcribe(options: TranscribeOptions): Promise<TranscriptSegment[]> {
    if (this.dead) {
      return Promise.reject(new EngineTimeoutError());
    }

    const jobId = `job-${++this.jobCounter}`;
    const run = () =>
      new Promise<TranscriptSegment[]>((resolve, reject) => {
        this.pendingJobs.set(jobId, {
          resolve,
          reject,
          offsetSeconds: options.offsetSeconds,
        });
        this.worker.postMessage({
          type: "transcribe",
          jobId,
          channel: options.channel,
          audio: options.audio,
          nthreads: options.nthreads ?? 1,
        });
      });

    const withTimeout = this.queue.then(
      () =>
        new Promise<TranscriptSegment[]>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingJobs.delete(jobId);
            this.dead = true;
            this.worker.terminate(); // the worker's JS thread is stuck (see TRANSCRIBE_TIMEOUT_MS) — nothing running in it can respond to a message, so kill it outright
            reject(new EngineTimeoutError());
          }, TRANSCRIBE_TIMEOUT_MS);

          run().then(
            (segments) => {
              clearTimeout(timer);
              resolve(segments);
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            }
          );
        })
    );

    this.queue = withTimeout.catch(() => undefined);
    return withTimeout;
  }

  terminate(): void {
    this.dead = true;
    this.worker.terminate();
  }
}
