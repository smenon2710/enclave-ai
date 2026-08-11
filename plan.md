# Implementation Plan: Browser-Based Privacy-First Meeting Assistant ($0 Stack)

## Overview
This document outlines the architecture, technology stack, and execution roadmap for a **browser-based, no-install meeting recording and summarization app** — an in-browser alternative to Otter.ai and Fathom.

It runs entirely as a static/SSR web app (hosted free on Vercel), captures meeting audio via standard browser APIs, transcribes it fully client-side (no audio ever leaves the device), stores history locally in the browser, and — only if the user opts in — sends the finished transcript to an LLM of their choice via their own OpenRouter API key for summarization.

---

## 1. Key Principles & Value Proposition

* **$0 Operating Cost (to you):** Static Next.js app on Vercel's free tier. No servers, no database, no per-user compute cost. LLM usage is billed to the *user's own* OpenRouter key, not to you.
* **No Install, Works Anywhere:** Runs in any modern browser — share a link, no download, no OS-specific build.
* **Transcription Stays Local:** Speech-to-text runs client-side via WASM (Whisper). Audio and transcript text never touch a server you control.
* **Bring Your Own LLM:** Users paste their own OpenRouter API key and pick a model. No key = transcription and history still work; only summarization is disabled.
* **History Lives With the User:** Meeting history is stored in the browser (IndexedDB), not on a server — private by default, but device-local (see §6 for the tradeoff).

---

## 2. Technical Stack ($0 Stack)

| Layer | Component | Choice |
| :--- | :--- | :--- |
| **Framework** | App & Hosting | **Next.js**, deployed on **Vercel** (free tier) |
| **Audio Capture** | Mic Input (You) | `getUserMedia` → **`AudioWorkletNode`** for raw PCM extraction (dedicated real-time audio thread, not main thread) |
| **Audio Capture** | Remote/System Audio | `getDisplayMedia({ audio: true })` (tab/screen share) → same `AudioWorkletNode` pipeline |
| **STT Engine** | Speech-to-Text | **`whisper.cpp` compiled to WASM** (C++/`ggml`, WASM SIMD + pthreads), run synchronously in a dedicated Worker, with a watchdog that falls back to single-threaded on a stuck worker — see §4.7. |
| **Diarization** | Speaker Separation | None in v1 — remote audio is a single "Participants" stream (see §4). Future: WASM speaker-embedding model (ONNX-WASM-SIMD or Rust/`wasm-bindgen`), not a JS reimplementation. |
| **Summarization** | LLM | **OpenRouter API**, user-supplied key, user-selectable model |
| **Storage** | Meeting History | **IndexedDB** (via `idb` — thin promise wrapper, no query layer; matches the pattern used elsewhere in this codebase's sibling projects), browser-local, no backend |

**Where "low-level" applies, and where it deliberately doesn't:** audio capture and STT inference are the compute-heavy hot paths, so they get the lowest-level tooling the browser allows (`AudioWorklet` for audio, C++/WASM for inference). Transcript merging, IndexedDB access, and UI state stay in TypeScript — they're not performance-bound, and pushing them into Rust/WASM would add build complexity without a measurable benefit.

---

## 3. Audio Pipeline Architecture

```
        ┌──────────────────┐              ┌───────────────────────────┐
        │ getUserMedia     │              │ getDisplayMedia            │
        │ (Mic → "You")    │              │ (Tab/System → "Participants")│
        └────────┬─────────┘              └──────────────┬────────────┘
                 │                                        │
                 ▼                                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │        AudioWorklet: raw PCM, resampled to 16kHz mono      │
        └───────────────────────────┬───────────────────────────────┘
                                    ▼
        ┌───────────────────────────────────────────────────────────┐
        │   Worker: whisper.cpp (C++/ggml → WASM, SIMD + threads)    │
        │        Chunked transcription, both streams, timestamped    │
        └───────────────────────────┬───────────────────────────────┘
                                    ▼
                       ┌────────────────────────┐
                       │ Chronological Transcript│
                       │ (single JS clock — both │
                       │ streams inherently synced)│
                       └────────────┬────────────┘
                                    ▼
              ┌─────────────────────────────────────────┐
              │ IndexedDB: save transcript + metadata    │
              └─────────────────┬─────────────────────────┘
                                ▼ (only if user has an OpenRouter key)
                       ┌────────────────────────┐
                       │ OpenRouter (user's key)│
                       │ Structured Summary      │
                       └────────────┬────────────┘
                                    ▼
                       ┌────────────────────────┐
                       │ IndexedDB: save summary │
                       └────────────────────────┘
```

One upside of moving to the browser: both audio streams are captured in the same JS runtime on the same clock, so the timestamp-drift problem the native desktop version would have had (reconciling two separate hardware audio devices) doesn't apply here — merge-by-timestamp is straightforward.

---

## 4. Constraints Introduced by the Browser Pivot

These are real limitations of the platform, not implementation gaps — worth being explicit about:

1. **Remote-audio capture requires a per-meeting consent dialog.** Browsers don't allow silent, background system-audio capture. Each meeting, the user must explicitly share a tab/screen with "share audio" checked. This is *more* consent-visible than the original desktop plan, which is good for the two-party-consent legal angle (see §7), but means the UX is "share a tab" every time, not "record silently in the background."
2. **Tab/system audio sharing is Chrome/Edge only in practice.** Safari does not support system/tab audio sharing via `getDisplayMedia`; Firefox support is inconsistent. Mic-only capture (`getUserMedia`) works everywhere. The app should detect capability and gracefully degrade to mic-only mode with a clear message on unsupported browsers.
3. **No real speaker diarization in v1.** `pyannote.audio` (Python/PyTorch) has no solid WASM equivalent today. Remote audio is transcribed as one "Participants" stream rather than split into Speaker 1/2/3. Flag this as a known v1 limitation; revisit if a WASM speaker-embedding model matures.
4. **IndexedDB has storage quotas and no redundancy.** Clearing browser data/cache deletes meeting history permanently — there is no cloud backup by design (per your choice of local-only history). The app must offer an explicit "Export All" backup feature so this isn't a silent data-loss trap.
5. **Whisper model download happens client-side on first use.** Even `tiny.en`/`base.en` are tens of MB; this should be cached (via Service Worker/PWA) so it's a one-time cost, not a re-download every session.
6. **Multi-threaded `whisper.cpp` WASM needs `SharedArrayBuffer`, which needs cross-origin isolation.** Vercel must serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers (`next.config.js`/`vercel.json`) — already wired in Phase 1. Without them, `whisper.cpp` still runs, just single-threaded and slower.
7. **Multi-threaded (`USE_PTHREADS=1`) build re-enabled, with a watchdog fallback — not fully verified yet.** Originally shipped single-threaded because the pthreads build hung indefinitely in this project's sandboxed dev/build environment (reproduced across two Emscripten versions, in both plain Node and headless Chromium). Re-enabled multi-threading in response to real-user latency complaints, since that hang was never confirmed to happen in a normal, non-sandboxed browser — only in the build sandbox. To make that bet safe: `WhisperEngine.transcribe()` (`src/lib/stt/whisperEngine.ts`) races every call against a 25s timeout; on timeout it terminates the stuck worker (throws `EngineTimeoutError`) and `useTranscription.ts` catches that specifically, drops to `nthreads=1`, and forces a full re-init — degrading to the previously-verified single-threaded path instead of freezing the app forever. This fallback path was itself verified end-to-end in the sandboxed environment (which reliably reproduces the original hang): watchdog fires, worker is killed, engine restarts single-threaded, transcription resumes correctly. **What's still unverified:** whether multi-threading actually improves latency in a real user's browser — that can only be confirmed by using the app for real and checking whether the "restarting single-threaded" message ever appears (if it does, threading failed there too and the fallback caught it; if it doesn't, threading is working).
8. **The upstream WASM binding was replaced with a custom one.** The stock `emscripten.cpp` (upstream's own whisper.wasm demo) dispatches transcription via a detached `std::thread` purely to make the call non-blocking for a browser main-thread caller, and reports results by parsing `printf`-formatted timestamp lines (`[HH:MM:SS.mmm --> ...]`) off stdout — there's no structured completion callback. Since this binding is only ever called from inside a dedicated Worker (already off the main thread), the outer dispatch thread was unnecessary complexity, and it was also the exact mechanism that hung (see #7). The custom binding (`public/wasm/whisper` build config, source in the scratchpad's `whisper.cpp/examples/whisper.wasm/emscripten.cpp`) runs `whisper_full` synchronously and returns structured `{start, end, text}` segments via the real `whisper_full_get_segment_*` API — more robust than text-scraping regardless of the threading outcome.
9. **Fixed-size transcription windows cut mid-sentence.** Whisper gets no context across window boundaries, so text that spans a chunk boundary comes out truncated/garbled at the edges (observed in testing: "We are checking that with --" / "We are checking that we're" — same audio, two different truncated results from mic vs. participants chunking slightly out of phase). Window reduced from 5s to 3s after real-user latency feedback, which trims max buffering delay but makes boundary-cutting slightly more frequent, not less. A real fix is VAD-based segmentation or overlapping windows, not naive fixed-size chunking — still an open follow-up.

---

## 5. Execution Roadmap

### Phase 1: Capture + Scaffold (Week 1) — done
- Scaffold Next.js app, deploy to Vercel; configure COOP/COEP headers for cross-origin isolation.
- Implement `getUserMedia` (mic) and `getDisplayMedia` (tab/system audio) capture, piped through an `AudioWorkletNode` for raw PCM extraction and resampling, with capability detection and mic-only fallback.
- **Milestone:** Record a test meeting in Chrome with both streams captured as raw 16kHz PCM in-memory. ✓ verified in-browser.

### Phase 2: Client-Side Transcription (Weeks 2–3) — done (single-threaded; see §4.7)
- Compile `whisper.cpp` to WASM via Emscripten (custom synchronous binding, see §4.8), load `ggml-tiny.en.bin`, run in a dedicated Worker (`public/workers/whisper-worker.js`, WASM at `public/wasm/whisper/libmain.js`).
- Model fetched from Hugging Face at runtime and cached in IndexedDB (`src/lib/stt/modelStore.ts`) — one-time download, not bundled in the repo.
- Fixed 3s rolling windows per channel (`src/hooks/useTranscription.ts`, reduced from 5s after real-user latency feedback), chunked/near-real-time rather than true streaming — see §4.9 for the chunk-boundary quality tradeoff.
- Merge Channel 1 ("You") and Channel 2 ("Participants") into one chronological transcript, rendered live in `src/app/page.tsx`.
- **Milestone:** Real speech transcribed correctly end-to-end in Chrome (verified with synthesized TTS audio via `--use-file-for-fake-audio-capture`), matching the source text.
- **Not done yet:** multi-threaded pthreads build (§4.7), Service Worker caching of the WASM binary itself (model weights are cached; the ~1.4MB WASM/JS bundle currently re-downloads each session via normal HTTP cache).

### Phase 3: OpenRouter Summarization (Week 4) — done
- Settings modal (`src/components/SettingsModal.tsx`): OpenRouter API key input (stored in `localStorage` via `src/hooks/useOpenRouterSettings.ts`, using `useSyncExternalStore` rather than a read-in-effect — avoids both the hydration mismatch and the extra render pass an effect+setState would add), model picker backed by OpenRouter's live `/models` endpoint (no key required to list) with free-text override.
- Summarization prompts (`src/lib/openrouter/client.ts`): Executive Briefing, Key Decisions Made, Action Items & Task Assignments, Unresolved Questions — called directly from the browser to `openrouter.ai`, never through a server we control.
- Graceful no-key state: transcription and history work fully; summarization shows an "add your key to enable" prompt instead of failing. Verified with a real (intentionally invalid) key end-to-end — request reaches OpenRouter, 401 comes back, renders as a clean error instead of crashing.
- **Not done yet:** the summary isn't persisted anywhere (Phase 4 will save it alongside the transcript in IndexedDB) — right now it only lives in component state and is lost on refresh.

### Phase 4: History & Persistence (Week 5) — done
- IndexedDB schema (`src/lib/history/db.ts`, via `idb`) for meetings: id, title, timestamps, transcript segments, summary, and which model generated it.
- Auto-save on stop (`src/app/page.tsx`): upserts the meeting record whenever segments/summary change after recording stops, rather than trying to pinpoint exactly when async transcription/summarization settle — covers `flushAll`'s late-arriving final window and a summary generated afterward without a race condition.
- History modal (`src/components/HistoryModal.tsx`): list + search (title and transcript text) + inline per-meeting detail view (expand/collapse, no separate route).
- Export options (Markdown, TXT, JSON) per meeting, plus "Export All" (single JSON backup) and "Import" to restore it — round-tripped and verified.
- Storage-quota handling: `navigator.storage.estimate()` warns above 80% usage. Raw audio was never written to IndexedDB in the first place (only transcript text + summary) — the "option to not retain raw audio" from the original bullet was already true by construction, not something that needed a toggle.

### Phase 5: Polish & PWA (Week 6) — done
- Minimal recording-status indicator: a small pulsing dot + "Recording" next to the Start/Stop control (`src/app/page.tsx`) — personal-use cue only, not participant-facing consent UI (see §7).
- PWA setup (`public/manifest.json`, `public/sw.js`, `src/components/ServiceWorkerRegister.tsx`, icons in `public/icons/`): hand-rolled rather than a build-plugin (next-pwa/Workbox precache generators assume webpack build hooks that don't line up cleanly with Next.js 16's Turbopack build) — precaches the stable-path WASM/worker assets, then opportunistically caches every other same-origin GET response as it's fetched (cache-first, background revalidate), since content-hashed JS chunk names have no fixed list to precache ahead of time.
- **Verified against a production build** (`next build && next start` — `next dev`'s Turbopack HMR chunk names aren't stable across reloads, so offline caching can't be meaningfully tested against dev mode): loaded once online, then fully offline — page hydrated, WASM worker loaded, model loaded from the IndexedDB cache with zero network calls, and a full record → transcribe cycle produced correct real-speech transcript text, satisfying the Offline Transcription Test (§8.2).
- Responsive pass: verified at a 375px mobile viewport. Found and fixed a real overflow bug in the History modal's toolbar (search input + Export/Import buttons had no wrap behavior and blew past the modal's width) — now stacks on narrow screens, single row from `sm:` up.

---

## 6. Storage & Privacy Model

* Transcripts, summaries, and metadata live in IndexedDB, scoped to the browser/device. No account, no login, no server-side database.
* The OpenRouter API key lives in `localStorage`, sent only to OpenRouter directly from the browser — never proxied through a server you operate.
* Tradeoff of local-only history (chosen over cloud sync): no cross-device access, and browser data clears (private browsing, "clear site data", browser reinstall) wipe history. Mitigate with a prominent, easy "Export All" action rather than silently accepting the data-loss risk.

---

## 7. Legal / Consent Note

This is a personal-use tool: no participant-facing consent UI is in scope (§5, Phase 5's recording indicator is a cue for you, not something the other party ever sees — and nothing in this architecture reaches their screen regardless). Recording-consent law is jurisdiction-dependent — some places are one-party consent (yours is enough), others require all parties' consent regardless of what any app displays. That's on you to handle outside the app; not something the app tracks or enforces.

---

## 8. Verification & Test Suite

1. **Browser Compatibility Matrix:** Confirm full dual-channel capture on Chrome/Edge; confirm graceful mic-only fallback on Safari/Firefox.
2. **Offline Transcription Test:** Disconnect internet after the Whisper model is cached; confirm a full record → transcribe → save cycle works with zero network calls.
3. **No-Key Summarization Test:** Confirm the app functions fully (record, transcribe, save, export) with no OpenRouter key set, and summarization clearly prompts for a key instead of erroring.
4. **Persistence Test:** Record a meeting, reload the page and restart the browser, confirm history is intact in IndexedDB.
5. **Export/Backup Test:** Confirm "Export All" produces a complete, re-importable backup of meeting history.
6. **Storage Quota Test:** Simulate near-quota IndexedDB usage and confirm the app warns rather than silently failing to save.
