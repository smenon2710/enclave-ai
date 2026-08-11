import type { AudioChannelLabel, PCMChunk } from "./types";

const WORKLET_URL = "/worklets/pcm-processor.js";
const WORKLET_NAME = "pcm-worklet-processor";

interface ChannelCapture {
  stream: MediaStream;
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
}

/**
 * Owns a single AudioContext shared by both channels so mic and
 * participants audio are timestamped on the same clock — that's what lets
 * the transcript merge step (Phase 2) skip cross-device clock reconciliation.
 */
export class MeetingAudioCapture {
  private context: AudioContext | null = null;
  private moduleLoaded: Promise<void> | null = null;
  private channels = new Map<AudioChannelLabel, ChannelCapture>();

  private async ensureContext(): Promise<AudioContext> {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
      this.moduleLoaded = null;
    }
    if (this.context.state === "suspended") {
      // Browsers only auto-resume within a user gesture; if this call landed
      // after an await (e.g. a permission prompt) the gesture can be lost
      // and resume() silently no-ops, leaving the context suspended forever
      // with zero error — the worklet just never processes audio. One retry
      // covers the common case; if it's still suspended, surface it instead
      // of failing silently. (state re-read fresh each time — TS narrows the
      // literal type per-check, but the underlying value can change under us.)
      // TS narrows `this.context.state` to the "suspended" literal from the
      // outer check and doesn't invalidate that across the opaque resume()
      // calls, so each re-read needs an explicit widen back to the full
      // union — the runtime value genuinely can be any of the four states.
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
    if (!this.moduleLoaded) {
      this.moduleLoaded = this.context.audioWorklet.addModule(WORKLET_URL);
    }
    await this.moduleLoaded;
    return this.context;
  }

  /**
   * Creates (or resumes) the AudioContext as early as possible in the
   * Start-meeting flow, before any `await` breaks the click's user-gesture
   * association — call this synchronously at the top of the click handler,
   * ahead of getUserMedia's permission-prompt await.
   */
  async prime(): Promise<void> {
    await this.ensureContext();
  }

  async addChannel(
    label: AudioChannelLabel,
    stream: MediaStream,
    onChunk: (chunk: PCMChunk) => void
  ): Promise<void> {
    const context = await this.ensureContext();
    const sourceNode = context.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(context, WORKLET_NAME, {
      processorOptions: { channelLabel: label },
    });

    workletNode.port.onmessage = (event: MessageEvent<PCMChunk>) => {
      onChunk(event.data);
    };

    sourceNode.connect(workletNode);
    this.channels.set(label, { stream, sourceNode, workletNode });
  }

  removeChannel(label: AudioChannelLabel): void {
    const channel = this.channels.get(label);
    if (!channel) return;

    channel.sourceNode.disconnect();
    channel.workletNode.disconnect();
    channel.workletNode.port.onmessage = null;
    channel.stream.getTracks().forEach((track) => track.stop());
    this.channels.delete(label);
  }

  async stopAll(): Promise<void> {
    for (const label of Array.from(this.channels.keys())) {
      this.removeChannel(label);
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.moduleLoaded = null;
    }
  }
}
