import type { NextConfig } from "next";

// No special headers needed anymore — the COOP/COEP cross-origin isolation
// headers here previously existed for SharedArrayBuffer (multi-threaded
// whisper.cpp WASM). That entire local-transcription pipeline was removed
// when this app moved to Groq's cloud API for both mic and Participants
// audio (see plan.md's migration note) — nothing in the app needs
// SharedArrayBuffer anymore.
const nextConfig: NextConfig = {};

export default nextConfig;
