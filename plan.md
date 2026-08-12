# Implementation Plan: Browser-Based Privacy-First Meeting Assistant ($0 Stack)

## Overview
This document outlines the architecture, technology stack, and execution roadmap for a **browser-based, no-install meeting recording and summarization app** — an in-browser alternative to Otter.ai and Fathom.

It runs entirely as a static/SSR web app (hosted free on Vercel), captures meeting audio via standard browser APIs, stores history locally in the browser, and — only if the user opts in — sends the finished transcript to an LLM of their choice via their own OpenRouter API key for summarization.

**Transcription is a hybrid, not fully local, as of the real-user latency/accuracy feedback documented in §4.10.** Your own voice (mic) is transcribed via the browser's cloud speech service (Web Speech API — fast, accurate, but that audio leaves the device) when available, falling back to the local whisper.cpp WASM engine otherwise. Participants' audio (tab/system capture) always stays on-device via whisper.cpp, because the Web Speech API has no way to listen to anything but the microphone. See §4.10 for why, and §6 for the updated privacy model.

---

## 1. Key Principles & Value Proposition

* **$0 Operating Cost (to you):** Static Next.js app on Vercel's free tier. No servers, no database, no per-user compute cost. LLM usage is billed to the *user's own* OpenRouter key, not to you.
* **No Install, Works Anywhere:** Runs in any modern browser — share a link, no download, no OS-specific build.
* **Transcription Stays Local — for Participants; hybrid for your own voice.** Speech-to-text never touches a server *we* control either way. Participants' audio always runs client-side via WASM Whisper. Your own mic audio runs through the browser's cloud speech service when available (see §4.10) — that audio does leave your device, to the browser vendor's recognition service, not to us.
* **Bring Your Own LLM:** Users paste their own OpenRouter API key and pick a model. No key = transcription and history still work; only summarization is disabled.
* **History Lives With the User:** Meeting history is stored in the browser (IndexedDB), not on a server — private by default, but device-local (see §6 for the tradeoff).

---

## 2. Technical Stack ($0 Stack)

| Layer | Component | Choice |
| :--- | :--- | :--- |
| **Framework** | App & Hosting | **Next.js**, deployed on **Vercel** (free tier) |
| **Audio Capture** | Mic Input (You) | `getUserMedia` → **`AudioWorkletNode`** for raw PCM extraction (dedicated real-time audio thread, not main thread) |
| **Audio Capture** | Remote/System Audio | `getDisplayMedia({ audio: true })` (tab/screen share) → same `AudioWorkletNode` pipeline |
| **STT Engine** | Participants (always) | **`whisper.cpp` compiled to WASM** (C++/`ggml`, WASM SIMD + pthreads), run synchronously in a dedicated Worker, with a watchdog that falls back to single-threaded on a stuck worker — see §4.7. |
| **STT Engine** | Mic / "You" (preferred) | **Web Speech API** (`SpeechRecognition`) — cloud recognition via the browser vendor, fast/accurate, requires internet, Chrome/Edge-family only. Falls back to the whisper.cpp engine above when unsupported. See §4.10. |
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
        ┌────────┴────────┐                               │
        ▼                 ▼                                ▼
┌───────────────┐  ┌──────────────┐            ┌───────────────────────┐
│ Web Speech API│  │ AudioWorklet │            │      AudioWorklet      │
│ (cloud, if    │  │ (PCM, for    │            │  (raw PCM, resampled   │
│  available)   │  │  level meter │            │      to 16kHz mono)    │
└───────┬───────┘  │  only)       │            └───────────┬───────────┘
        │          └──────────────┘                        ▼
        │                                     ┌───────────────────────────┐
        │      (falls back to whisper.cpp     │  Worker: whisper.cpp      │
        │       below when Web Speech is       │  (C++/ggml → WASM,        │
        │       unsupported)                   │   SIMD + threads)         │
        │                                     │  Chunked, timestamped      │
        │                                     └─────────────┬─────────────┘
        ▼                                                    ▼
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

One upside of moving to the browser: both audio streams are captured in the same JS runtime on the same clock, so the timestamp-drift problem the native desktop version would have had (reconciling two separate hardware audio devices) doesn't apply here — merge-by-timestamp is straightforward. This holds even for the Web Speech path: its segments are timestamped using elapsed-time-since-meeting-start at the moment each final result arrives (Web Speech gives no word-level timing of its own), same clock as everything else.

Note the mic channel's `AudioWorkletNode` still runs even when Web Speech handles transcription — it's kept purely for the live level meter, since Web Speech manages its own internal audio capture with no hook to expose levels.

---

## 4. Constraints Introduced by the Browser Pivot

These are real limitations of the platform, not implementation gaps — worth being explicit about:

1. **Remote-audio capture requires a per-meeting consent dialog.** Browsers don't allow silent, background system-audio capture. Each meeting, the user must explicitly share a tab/screen with "share audio" checked. This is *more* consent-visible than the original desktop plan, which is good for the two-party-consent legal angle (see §7), but means the UX is "share a tab" every time, not "record silently in the background."
2. **Tab/system audio sharing is Chrome/Edge only in practice.** Safari does not support system/tab audio sharing via `getDisplayMedia`; Firefox support is inconsistent. Mic-only capture (`getUserMedia`) works everywhere. The app should detect capability and gracefully degrade to mic-only mode with a clear message on unsupported browsers.
3. **No real speaker diarization in v1.** `pyannote.audio` (Python/PyTorch) has no solid WASM equivalent today. Remote audio is transcribed as one "Participants" stream rather than split into Speaker 1/2/3. Flag this as a known v1 limitation; revisit if a WASM speaker-embedding model matures.
4. **IndexedDB has storage quotas and no redundancy.** Clearing browser data/cache deletes meeting history permanently — there is no cloud backup by design (per your choice of local-only history). The app must offer an explicit "Export All" backup feature so this isn't a silent data-loss trap.
5. **Whisper model download happens client-side on first use.** Even `tiny.en`/`base.en` are tens of MB; this should be cached (via Service Worker/PWA) so it's a one-time cost, not a re-download every session.
6. **Multi-threaded `whisper.cpp` WASM needs `SharedArrayBuffer`, which needs cross-origin isolation.** Vercel must serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers (`next.config.js`/`vercel.json`) — already wired in Phase 1. Without them, `whisper.cpp` still runs, just single-threaded and slower.
7. **Multi-threaded (`USE_PTHREADS=1`) was tried, confirmed to hang in a real browser, and reverted — single-threaded is the shipped state.** Originally shipped single-threaded because the pthreads build hung indefinitely in this project's sandboxed dev/build environment (reproduced across two Emscripten versions, in both plain Node and headless Chromium — never confirmed broken in a normal browser, just untested there). Re-enabled multi-threading in response to real-user latency complaints, betting the hang was sandbox-specific, with a watchdog safety net (`WhisperEngine.transcribe()` races every call against a 25s timeout; on timeout it terminates the stuck worker and throws `EngineTimeoutError`, `useTranscription.ts` catches it and forces a full re-init) so a hang anywhere would degrade to single-threaded instead of freezing the app. **The bet didn't pay off: a real user hit the identical hang in their actual browser** (the watchdog message appeared during real use, confirming the fallback worked exactly as designed — but also confirming the hang isn't sandbox-specific after all). Pthreads disabled again — see `wasm-build/README.md` for the full history and why re-enabling again would need real investigation, not just flipping the flag. The watchdog stays in place as general-purpose defense-in-depth (capped at 2 auto-restarts, `useTranscription.ts`) against any stuck worker, not specifically a pthreads one.
8. **The upstream WASM binding was replaced with a custom one.** The stock `emscripten.cpp` (upstream's own whisper.wasm demo) dispatches transcription via a detached `std::thread` purely to make the call non-blocking for a browser main-thread caller, and reports results by parsing `printf`-formatted timestamp lines (`[HH:MM:SS.mmm --> ...]`) off stdout — there's no structured completion callback. Since this binding is only ever called from inside a dedicated Worker (already off the main thread), the outer dispatch thread was unnecessary complexity, and it was also the exact mechanism that hung (see #7). The custom binding (`public/wasm/whisper` build config, source in the scratchpad's `whisper.cpp/examples/whisper.wasm/emscripten.cpp`) runs `whisper_full` synchronously and returns structured `{start, end, text, noSpeechProb}` segments via the real `whisper_full_get_segment_*` API — more robust than text-scraping regardless of the threading outcome. `noSpeechProb` added later, see #11.
9. **Fixed-size transcription windows cut mid-sentence.** Whisper gets no context across window boundaries, so text that spans a chunk boundary comes out truncated/garbled at the edges (observed in testing: "We are checking that with --" / "We are checking that we're" — same audio, two different truncated results from mic vs. participants chunking slightly out of phase). Window reduced from 5s to 3s after real-user latency feedback, which trims max buffering delay but makes boundary-cutting slightly more frequent, not less. A real fix is VAD-based segmentation or overlapping windows, not naive fixed-size chunking — still an open follow-up. This mostly matters for Participants only now, since mic transcription moved to Web Speech (see #10), which streams results incrementally rather than in fixed windows.
10. **Mic transcription moved to a hybrid: Web Speech API (cloud) preferred, whisper.cpp (local) as fallback.** After re-enabling multi-threaded WASM (#7) and shrinking the transcription window (#9) still didn't meet real-user latency/accuracy expectations, the remaining local-only options were all uncertain (a lighter model, true streaming) while the cloud option was a known, immediate fix — an explicit, informed trade-off, not a default: the user was shown that no local in-browser model can match cloud ASR speed/accuracy, and chose to accept audio leaving the device for the mic channel specifically. **This is not a drop-in swap** — the Web Speech API has no way to accept a custom `MediaStream`; it always captures from the microphone internally, with no hook to redirect it to the `getDisplayMedia` tab-audio stream. That means it can only ever handle the mic ("You") channel — Participants audio has no cloud path available and stays on whisper.cpp regardless. Implementation: `src/hooks/useWebSpeechTranscription.ts` wraps `SpeechRecognition`, auto-restarting on Chrome's periodic `onend` (continuous mode isn't truly infinite), merging its segments with whisper's Participants segments by timestamp at the `page.tsx` level. `useMicEngine()` (`useSyncExternalStore`) picks "cloud" when `SpeechRecognition`/`webkitSpeechRecognition` exists, else "local" (whisper.cpp handles mic too, old behavior, in Safari/Firefox). **Verification gap, same shape as #7:** in this project's headless/sandboxed build environment, `SpeechRecognition.start()` doesn't throw but never fires *any* event — not even `onstart` — over 20s, a known limitation of headless Chrome (no working path to the cloud recognition service without a full browser session), not a code bug. Confirmed the Participants/whisper path is unaffected (still produces correct real-speech transcripts) and added a 10s startup watchdog (`STARTUP_WATCHDOG_MS`) so if this same silent-non-response ever happens in a real user's browser (e.g. no connectivity), they get a visible error instead of "Listening…" forever with no feedback — verified the watchdog itself fires correctly in the sandboxed environment. **What's still unverified:** whether Web Speech actually produces fast, accurate results in a real browser session — that can only be confirmed by using the app for real.

    **Where this architecture's ceiling actually is** (researched against Microsoft Teams' server-side recording model, which forks each participant's *unmixed* stream at Azure before any mixing happens): the mic channel above is structurally the same move as Teams sending your own stream to Azure Cognitive Speech Services — different vendor, same idea, about as close as this architecture gets. The Participants channel can't follow the same path: `getDisplayMedia` tab-audio capture only ever sees *already-mixed, already-degraded* output audio (post AEC/jitter-buffering/mixing by Zoom/Teams/Meet's own client), not a clean per-participant source stream the way Azure's MCU sees one. No STT model or engine swap fixes that — it's a limitation of *where in the pipeline* this app captures from, not of the model. Matching Teams' Participants-side quality would require becoming a meeting bot with platform API access to each participant's individual stream, which contradicts principle #1 in §1 ("No Meeting Bots") — considered and explicitly declined; not pursuing.
11. **`[BLANK_AUDIO]` and similar bracketed non-speech tags were leaking into the transcript.** Whisper's training data included transcribed non-speech events tagged this way (`[BLANK_AUDIO]`, `[MUSIC]`, `(silence)`, etc.), so the model sometimes emits these as a literal "transcription" of a silent/non-speech window rather than returning nothing — most visible on the Participants channel during solo testing, where there's genuinely no one talking. Left in, this is pure noise for the summarization/Ask LLM calls downstream. Fixed with two layers in `src/lib/stt/whisperEngine.ts`: (a) the custom binding (#8) now also returns each segment's `no_speech_prob` (whisper's own confidence there's no speech at all), filtered against whisper.cpp's own default threshold (0.6); (b) a text-pattern check (whole segment text wrapped in brackets/parens, nothing else) as defense in depth, since a confident "[MUSIC]" tag reflects confidence about *non-speech audio*, not necessarily a high no-speech score. Verified with two real recordings: 60s of genuine silence on both channels produced zero transcript segments (previously would have produced repeated `[BLANK_AUDIO]` lines) and zero false-positive filtering of actual real speech in the same session type.
12. **Cross-channel/cross-engine transcript ordering was wrong — three independent clocks, never reconciled.** A real user's first actual two-party call surfaced this: transcript merge order (`allSegments` in `page.tsx`, sorted by `segment.start`) can only be correct if every producer's `start` timestamp is measured from the same origin. It wasn't. (a) Whisper windows (`useTranscription.ts`) computed `offsetSeconds` as a per-channel running counter of "seconds of audio captured so far," starting both mic and participants at 0 — but participants capture only begins once the share-picker dialog is granted, which can be many seconds after mic capture starts, so participants segments were systematically mistimed relative to mic. (b) Web Speech (`useWebSpeechTranscription.ts`) used `Date.now()` captured at its own `start()` call, which only happens after `startMeeting()` fully resolves (i.e. after *both* the mic permission prompt and the participants share picker) — an even later, wall-clock-domain origin, unrelated to whisper's `AudioContext`-based clock entirely. Fix: `PCMChunk.timestamp` (already stamped from the shared `AudioContext.currentTime` in the worklet — see `capture.ts`'s own doc comment on why mic/participants share one context — but never actually read downstream) is now used directly as each whisper window's origin; `useMeetingRecorder.ts`'s `startMeeting()` now captures one `meetingEpochMs = Date.now()` before any awaits and returns it, and `page.tsx` passes it into `webSpeech.start(meetingEpochMs)` so Web Speech timestamps land in the same timeline instead of starting their own. **Verified:** in-browser test confirms whisper-side (participants) segments now come out in correct, monotonically increasing order matching real speech content. **Not verifiable in this sandboxed environment** (same headless-Chrome limitation as #10 — Web Speech never fires events here): whether mic (cloud) segments now interleave correctly against participants (local) segments in a real two-party call — needs the user's next real call to confirm.
13. **No feedback that local transcription can still be "catching up" after Stop.** `WhisperEngine` serializes all `transcribe()` calls through one internal queue; if live transcription falls behind real-time during a call (plausible on slower hardware, single-threaded whisper.cpp), a backlog builds silently, and `flushAll()` on Stop just appends two more jobs to the end of that same backlog — so the "final" transcript can take much longer to settle than the last ~3s window alone would suggest (a real user observed roughly a minute). `useTranscription.ts` now tracks `pendingJobCount` (incremented on every `transcribe()` dispatch, decremented on settle); `page.tsx` shows a "Finalizing transcript…" banner and disables Generate Summary / Ask while it's nonzero, so neither runs against a transcript still missing its tail. Verified in-browser: banner appears immediately on Stop and clears only once the backlog actually drains (took 27s in one test run, live-demonstrating the exact effect being guarded against).
14. **Participants transcription had a real, fixable accuracy bug — no anti-aliasing filter before downsampling — plus a near-miss on the fix.** A real user reported the Participants channel specifically ("anyone else joining the call") producing garbled text despite the captured audio sounding fine when played back. Root cause: `public/worklets/pcm-processor.js` downsamples from the device's native rate (commonly 48kHz) to whisper's 16kHz via linear interpolation only, with no low-pass filter first — so content above 16kHz's 8kHz Nyquist aliases straight into the speech band during decimation. That's inaudible as "distortion" to a human listening to the original unfiltered audio live, but it's real corrupted energy in what whisper.cpp actually receives, matching the exact symptom reported. Fixed with two cascaded biquad low-pass filter stages (~24dB/octave combined, cutoff 7kHz) applied per-sample before the existing resample loop; skipped when the source is already at/below the target rate (no aliasing risk there). **Near-miss, caught before shipping:** the first attempt at "improve Participants accuracy" also changed the default STT model from tiny.en to base.en, reasoning that since mic now defaults to Web Speech (#10), this setting mostly only governs Participants anymore and isn't trading off against mic latency the way it used to. A direct timing probe (bypassing the UI, timing a single `transcribe()` call directly) measured **~25.7s for one ~3s window with base.en** — past `TRANSCRIBE_TIMEOUT_MS` (25s, `whisperEngine.ts`) — meaning it would trip the "stopped responding" watchdog on close to every window rather than just running slower, producing a worse failure mode (near-zero transcript via repeated restart cycles) than tiny.en's lower accuracy. Reverted before committing; tiny.en stays the default, base.en remains an opt-in in Settings for faster hardware. Verified in-browser with the real shipped defaults (tiny.en + the new filter): 5 correctly-ordered, correctly-transcribed segments, zero regressions.

---

## 5. Execution Roadmap

### Phase 1: Capture + Scaffold (Week 1) — done
- Scaffold Next.js app, deploy to Vercel; configure COOP/COEP headers for cross-origin isolation.
- Implement `getUserMedia` (mic) and `getDisplayMedia` (tab/system audio) capture, piped through an `AudioWorkletNode` for raw PCM extraction and resampling, with capability detection and mic-only fallback.
- **Milestone:** Record a test meeting in Chrome with both streams captured as raw 16kHz PCM in-memory. ✓ verified in-browser.

### Phase 2: Client-Side Transcription (Weeks 2–3) — done; mic path now hybrid (see §4.10)
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
* **Updated per §4.10: mic audio is no longer guaranteed to stay on-device.** When Web Speech API is available (Chrome/Edge, the common case), your own voice is streamed to the browser vendor's cloud recognition service (Google, in Chrome) to be transcribed — not to a server this app operates, but off-device nonetheless. Participants' audio is unaffected and always stays local via whisper.cpp, since Web Speech has no way to capture it. The in-app tagline and per-channel labels ("— cloud" / "— local") reflect this live, so it's never silently misrepresented as fully local when it isn't.

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
7. **Web Speech Real-Browser Test (partially confirmed, see §4.10):** Record a meeting in Chrome with actual speech and confirm (a) mic transcript appears noticeably faster/more accurately than the whisper.cpp path, (b) the "Speech recognition isn't responding" watchdog message never appears during normal use, (c) Participants transcription is unaffected. Separately, a real user already confirmed hitting the (now-reverted) multi-threaded whisper.cpp watchdog message ("Transcription worker stopped responding") in their real browser — see §4.7 — which is why that path is single-threaded again; a clean session today should never show that message.
