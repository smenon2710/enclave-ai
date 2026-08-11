# Enclave AI

Browser-based, privacy-first meeting assistant. No install, no server-side
audio or LLM processing — see `plan.md` for the full architecture.

## Status

**Phase 1 (capture pipeline):** done. Mic (`getUserMedia`) and participants
(`getDisplayMedia` tab/system audio) capture, piped through an
`AudioWorkletNode` and resampled to 16kHz mono PCM in-memory.

**Phase 2 (client-side transcription):** done, single-threaded — see
plan.md §4.7. `whisper.cpp` compiled to WASM (`public/wasm/whisper/`, build
instructions in `wasm-build/`) runs in a dedicated Worker
(`public/workers/whisper-worker.js`), transcribing both channels locally.
Model weights fetch from Hugging Face on first use and cache in IndexedDB.

**Phase 3 (OpenRouter summarization):** done. Settings modal for your own
OpenRouter API key + model (stored in `localStorage`, sent straight to
OpenRouter — never through a server we control). Generates a structured
Markdown summary (Executive Briefing / Key Decisions / Action Items /
Unresolved Questions) from the transcript. No key = transcription still
works fully; summarization shows a prompt to add one instead of failing.

**Phase 4 (history & persistence):** done. Meetings auto-save to IndexedDB
(via `idb`) when you stop recording — transcript, summary, timestamps. The
History panel (button next to Settings) lists past meetings with search,
per-meeting export (Markdown/TXT/JSON), and an "Export All" backup you can
"Import" back in (round-trip verified). Raw audio is never written to
storage, only text. A quota warning shows if browser storage crosses 80%.

**Phase 5 (polish & PWA):** done. A small pulsing "Recording" indicator next
to Start/Stop. Installable as a PWA (`public/manifest.json`) with a
hand-rolled service worker (`public/sw.js`) — no `next-pwa`/Workbox, since
those assume webpack build hooks that don't line up cleanly with Next.js
16's Turbopack build. **Verified offline against a production build**
(`next build && next start` — dev mode's chunk hashes aren't stable enough
to cache meaningfully): load once online, then go fully offline — the app
still loads, the model loads from its IndexedDB cache, and a full
record → transcribe cycle works with zero network calls. Responsive pass
done at a 375px viewport, including a real overflow bug found and fixed in
the History modal's toolbar.

All five roadmap phases are now built and verified end-to-end.

## Getting Started

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Click "Start meeting":
it'll ask for microphone access, then prompt you to share a tab/screen with
audio for the "participants" channel (Chrome/Edge only — see `plan.md` §4
for why). Once the transcription model finishes downloading, a live
transcript appears for both channels.

Cross-origin isolation headers (`COOP`/`COEP`) are configured in
`next.config.ts`, ready for when the WASM build goes multi-threaded (see
`wasm-build/README.md`).

To point at a local model file instead of fetching from Hugging Face every
reload during development, set `NEXT_PUBLIC_WHISPER_MODEL_URL` in
`.env.local`.

To test offline/PWA behavior, use a production build (`npm run build && npm
run start`) — `npm run dev`'s Turbopack HMR chunk names change between
requests, so the service worker can't cache them meaningfully and offline
mode will appear broken in dev even though it works in production.
