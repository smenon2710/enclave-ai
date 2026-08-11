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
      await this.context.resume();
    }
    if (!this.moduleLoaded) {
      this.moduleLoaded = this.context.audioWorklet.addModule(WORKLET_URL);
    }
    await this.moduleLoaded;
    return this.context;
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
