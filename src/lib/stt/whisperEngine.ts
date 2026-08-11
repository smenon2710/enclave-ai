import type { AudioChannelLabel } from "@/lib/audio/types";
import type { TranscriptSegment } from "./types";

interface RawSegment {
  start: number;
  end: number;
  text: string;
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

/** Thin wrapper around the whisper.cpp WASM Worker — see public/workers/whisper-worker.js. */
export class WhisperEngine {
  private worker: Worker;
  private readyPromise: Promise<void>;
  private jobCounter = 0;
  private pendingJobs = new Map<string, PendingJob>();
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
        msg.segments.map((seg) => ({
          channel: msg.channel,
          start: job.offsetSeconds + seg.start,
          end: job.offsetSeconds + seg.end,
          text: seg.text,
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

    const result = this.queue.then(run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  terminate(): void {
    this.worker.terminate();
  }
}
