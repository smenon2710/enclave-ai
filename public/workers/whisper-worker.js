// Classic (non-module) Worker wrapping whisper.cpp compiled to WASM
// (public/wasm/whisper/libmain.js — built from ggml-org/whisper.cpp via
// Emscripten, see plan.md Phase 2). Uses a custom binding (transcribe) that
// runs whisper_full synchronously and returns structured segments directly,
// rather than the upstream demo's approach of dispatching via an outer
// std::thread and scraping printf output for timestamps.

let readyResolve;
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});

self.Module = {
  printErr: (text) => console.log("[whisper]", text),
  onRuntimeInitialized: () => {
    readyResolve();
    self.postMessage({ type: "ready" });
  },
};

importScripts("/wasm/whisper/libmain.js");

let ctxHandle = 0;

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === "load-model") {
    await ready;
    try {
      self.Module.FS.writeFile("model.bin", new Uint8Array(msg.modelBytes));
      ctxHandle = self.Module.init("model.bin");
      self.postMessage({ type: "model-loaded", ok: ctxHandle !== 0 });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error) });
    }
    return;
  }

  if (msg.type === "transcribe") {
    if (!ctxHandle) {
      self.postMessage({
        type: "error",
        jobId: msg.jobId,
        message: "Model not loaded",
      });
      return;
    }
    try {
      // Blocks this worker's event loop for the duration of the job — fine,
      // this worker is already off the main/UI thread. Thread count is
      // fixed at 1: the WASM build has no pthread support (disabled after a
      // real user confirmed the multi-threaded build hangs even outside
      // this project's sandboxed test environment — see plan.md §4.7),
      // so anything higher would be a no-op anyway.
      // audioCtx caps the encoder's context to roughly the actual audio
      // length instead of the model's full ~30s default -- see
      // wasm-build/emscripten.cpp and useTranscription.ts's computeAudioCtx.
      // 0 (unset) falls back to the WASM binding's own default (full context).
      const segments = self.Module.transcribe(ctxHandle, msg.audio, "en", 1, false, msg.audioCtx ?? 0);
      self.postMessage({
        type: "transcribe-done",
        jobId: msg.jobId,
        channel: msg.channel,
        segments,
      });
    } catch (error) {
      self.postMessage({ type: "error", jobId: msg.jobId, message: String(error) });
    }
  }
};
