# Enclave AI

Browser-based, privacy-first meeting assistant. No install, no server-side
audio or LLM processing — see `plan.md` for the full architecture.

## Status

**Phase 1 (capture pipeline):** done. Mic (`getUserMedia`) and participants
(`getDisplayMedia` tab/system audio) capture, piped through an
`AudioWorkletNode` and resampled to 16kHz mono PCM in-memory.

**Phase 2 (client-side transcription):** done, multi-threaded with a
single-threaded fallback — see plan.md §4.7. `whisper.cpp` compiled to WASM
(`public/wasm/whisper/`, build instructions in `wasm-build/`) runs in a
dedicated Worker (`public/workers/whisper-worker.js`), transcribing both
channels locally. Model weights fetch from Hugging Face on first use and
cache in IndexedDB. A watchdog in `WhisperEngine.transcribe()` detects a
stuck multi-threaded worker and automatically restarts single-threaded
rather than freezing — whether threading actually helps latency in a given
browser is still being verified in the wild.

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

**Post-launch fixes & additions (from real-device testing feedback):**
- **Delete history**: "Delete all" in the History panel, alongside the existing per-meeting delete.
- **Mic capture reliability**: fixed a real bug where the `AudioContext` was created *after* the mic-permission prompt, which can silently lose the browser's required user-gesture association and leave audio capture dead with zero error shown. Now primed before the permission prompt, with a visible error if it still fails. Also added a microphone device picker (Settings-adjacent, shows once multiple inputs are detected) for when the OS/browser default input isn't the one you're actually speaking into.
- **Transcription accuracy**: added a model-quality picker (`tiny.en` fast/default vs `base.en` more accurate) — the default `tiny.en` trades accuracy for speed and download size, which is fine on clean audio but degrades on real mic conditions.
- **Latency**: audio capture itself has zero latency (it's 100% client-side; Vercel hosting only serves the initial static files) — the delay is the transcription pipeline. Two changes: reduced the fixed buffering window from 5s to 3s (small cost to per-chunk context/accuracy), and re-enabled multi-threaded WASM (previously disabled because it hung in this project's sandboxed build/test environment specifically — never confirmed broken in a real browser) with an automatic watchdog fallback to single-threaded if a worker gets stuck, so trying threading again can't leave the app frozen. See `wasm-build/README.md` for the full story.
- **Free-tier OpenRouter models**: default model changed to `openrouter/free` (OpenRouter's self-maintaining free-tier router), and the Settings model picker has a "Free only" filter (checked by default) so testing never touches a paid model by accident.
- **Ask (Otter-style Q&A)**: a chat panel below Summary — ask questions about the current/just-finished meeting ("what did we decide?", "what are my action items?") and get answers grounded only in that meeting's transcript, with multi-turn follow-up support. Currently scoped to the active meeting only; asking questions about a past meeting from History isn't wired up yet.

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
`next.config.ts` — required for the multi-threaded WASM build's
`SharedArrayBuffer` usage (see `wasm-build/README.md`).

To point at a local model file instead of fetching from Hugging Face every
reload during development, set `NEXT_PUBLIC_WHISPER_MODEL_URL` in
`.env.local`. Note this overrides the in-app model picker entirely (it takes
priority over whatever's selected in Settings) — don't leave it set if
you're testing the tiny.en/base.en switcher.

To test offline/PWA behavior, use a production build (`npm run build && npm
run start`) — `npm run dev`'s Turbopack HMR chunk names change between
requests, so the service worker can't cache them meaningfully and offline
mode will appear broken in dev even though it works in production.
