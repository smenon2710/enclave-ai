# Implementation Plan: Browser-Based Privacy-First Meeting Assistant ($0 Stack)

## Overview
This document outlines the architecture, technology stack, and execution roadmap for a **browser-based, no-install meeting recording and summarization app** — an in-browser alternative to Otter.ai and Fathom.

It runs entirely as a static/SSR web app (hosted free on Vercel), captures meeting audio via standard browser APIs, stores history locally in the browser, and — only if the user opts in — sends the finished transcript to an LLM of their choice via their own OpenRouter API key for summarization.

**Transcription is fully cloud-based as of the Groq migration (§9), not local.** Both the mic ("You") and Participants (tab/system capture) channels are transcribed via Groq's Whisper API using the user's own key, sent directly from the browser. This supersedes the project's original local-first design (§3-§4 below, kept as historical record) and the hybrid Web Speech/whisper.cpp arrangement that followed real-user latency feedback (§4.10) — **§3 and §4's numbered list describe that earlier architecture and are no longer how the app works**; jump to §9 for the current pipeline and why it changed. §6 (Storage & Privacy Model) has been updated to reflect the current, fully-cloud state.

---

## 1. Key Principles & Value Proposition

* **$0 Operating Cost (to you):** Static Next.js app on Vercel's free tier. No servers, no database, no per-user compute cost. LLM usage is billed to the *user's own* OpenRouter key, not to you.
* **No Install, Works Anywhere:** Runs in any modern browser — share a link, no download, no OS-specific build.
* **No Server We Control, Even Though Transcription Is Now Cloud-Based.** Both channels are transcribed via Groq's API using the user's own key, sent directly from the browser (§9) — audio leaves the device for both You and Participants now, a deliberate change from this project's original local-first design (kept as historical record in §3-§4). What hasn't changed: nothing is proxied through infrastructure this app operates.
* **Bring Your Own LLM:** Users paste their own OpenRouter API key and pick a model. No key = transcription and history still work; only summarization is disabled.
* **History Lives With the User:** Meeting history is stored in the browser (IndexedDB), not on a server — private by default, but device-local (see §6 for the tradeoff).

---

## 2. Technical Stack ($0 Stack)

| Layer | Component | Choice |
| :--- | :--- | :--- |
| **Framework** | App & Hosting | **Next.js**, deployed on **Vercel** (free tier) |
| **Audio Capture** | Mic Input (You) | `getUserMedia` → Web Audio `AnalyserNode` (level meter only) + `MediaRecorder` (~10s stop/restart cycles, uploaded as compressed audio files) — see §9. Superseded: originally `AudioWorkletNode` raw-PCM extraction, §3 below. |
| **Audio Capture** | Remote/System Audio | `getDisplayMedia({ audio: true })` (tab/screen share) → same `AnalyserNode` + `MediaRecorder` pipeline |
| **STT Engine** | Both channels | **Groq's Whisper API** (`whisper-large-v3` / `whisper-large-v3-turbo`), user-supplied key, called directly from the browser (§9). Superseded: local `whisper.cpp` WASM for Participants + Web Speech API hybrid for mic, §3-§4 below — both fully removed from the codebase. |
| **Diarization** | Speaker Separation | None in v1 — remote audio is a single "Participants" stream (see §4). Future: WASM speaker-embedding model (ONNX-WASM-SIMD or Rust/`wasm-bindgen`), not a JS reimplementation. |
| **Summarization** | LLM | **OpenRouter API**, user-supplied key, user-selectable model |
| **Storage** | Meeting History | **IndexedDB** (via `idb` — thin promise wrapper, no query layer; matches the pattern used elsewhere in this codebase's sibling projects), browser-local, no backend |

**Where "low-level" applies, and where it deliberately doesn't:** audio capture and STT inference are the compute-heavy hot paths, so they get the lowest-level tooling the browser allows (`AudioWorklet` for audio, C++/WASM for inference). Transcript merging, IndexedDB access, and UI state stay in TypeScript — they're not performance-bound, and pushing them into Rust/WASM would add build complexity without a measurable benefit.

---

## 3. Audio Pipeline Architecture

> **Superseded by §9.** This section (and §4's numbered constraints list)
> describes the app's original local-first architecture — `AudioWorkletNode`
> PCM extraction, local `whisper.cpp` WASM, and the Web Speech API mic
> hybrid. None of that code exists in the app anymore; both channels now go
> through Groq's cloud API via `MediaRecorder` (§9). Kept below as the
> historical record of real debugging work (aliasing, threading, timing
> bugs, watchdogs) rather than deleted — several of the *lessons* still
> apply even though the specific code doesn't (e.g. the shared-clock timing
> fix in §4.12 is the same reason §9's `MeetingAudioCapture` still takes a
> `meetingEpochMs`).

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
15. **Short mic utterances (e.g. "OK") could vanish entirely, and the mic picker silently does nothing when Web Speech is active.** Surfaced by a real two-party test (a podcast shared as Participants, own voice via mic, occasional short interjections while listening). Two separate causes: (a) `useWebSpeechTranscription.ts`'s `onend` handler — which already knew Chrome periodically ends a recognition "turn" even in `continuous: true` mode, and restarts — unconditionally discarded whatever text was still sitting as non-final `interimText` at that exact instant, with zero trace; a short utterance caught mid-turn-boundary would just vanish. Fixed by salvaging pending interim text as a best-effort final segment before restarting/idling. (b) Discovered while investigating (a): the Web Speech API has no way to accept a `deviceId` or `MediaStream` at all, so it silently ignores this app's own microphone picker (§2, useMicrophoneDevice) regardless of what's selected — ruled out by testing with Chrome's fake-audio-device flag, which Web Speech ignored entirely while still picking up real, unrelated room speech. Added a Settings toggle ("Always transcribe my voice locally too", `useMicTranscriptionSettings.ts`) to force the mic through whisper.cpp instead, which does respect the picker and gives a way to isolate whether a capture problem is Web Speech-specific. Also added a live "Finalizing transcript… (Ns and counting)" counter (`page.tsx`) so backlog duration is actually measurable — motivated by, and shipped alongside, #16's fix.
16. **Local transcription finalize time could run 1-2 orders of magnitude longer than the recording itself — the WASM binding never capped `audio_ctx`.** A real user reported a 5m26s recording taking over an hour (4000+ seconds) to finalize. Root cause, found by reading the actual `whisper_full_params` construction in `wasm-build/emscripten.cpp`: `audio_ctx` was never set, so every ~3s window's encoder pass processed the model's full default ~30s/1500-unit context regardless of the actual (much shorter) audio length — confirmed against whisper.cpp's own official `stream.wasm`/`command.wasm` examples, which hardcode `audio_ctx = 768` specifically for this exact real-time-transcription use case ("partial encoder context for better performance"). Fixed by adding `audio_ctx` as a parameter to the `transcribe` WASM binding (threaded through `public/workers/whisper-worker.js` and `src/lib/stt/whisperEngine.ts`) that JS controls per-call, rather than hardcoding one value into the binary — this makes the actual number tunable/re-verifiable from JS without ever rebuilding WASM again. The value itself (`AUDIO_CTX_UNITS = 384` in `useTranscription.ts`) is empirically benchmarked, not derived from a formula: a Node/Playwright harness drove the real rebuilt WASM binary directly through a Worker (bypassing `getUserMedia`/`getDisplayMedia` entirely) with real TTS speech audio chopped into 3s windows. 512/384/256 all transcribed cleanly across two different passages (11 windows); a more aggressive, proportionally-computed guess (182) produced duplicated/hallucinated repeated text on one window in *every* run — a worse failure mode than slowness, since it isn't caught by the existing `no_speech_prob`/bracket-tag filter (`whisperEngine.ts`'s `isRealSpeech`) at all. 384 was chosen for headroom above that observed failure point while still measuring **~5-9x faster** than the unset default across both test passages. **Verified end-to-end through the real app** (not just the isolated benchmark): a 14s two-channel local-transcription test — both mic (forced local via #15's toggle) and Participants transcribing the same audio — finalized in ~13s total, versus an estimated ~55s *per channel* at the old default. Separately noted but not pursued alongside this fix (kept isolated/independently verifiable): the Emscripten build configure step reports `GGML_CPU_GENERIC` / `Falling back to generic implementations` for this target, meaning the WASM build may not be using SIMD-optimized code paths at all — a real further-speedup candidate, flagged in `wasm-build/README.md` as a follow-up, not investigated here.

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

**Updated per §9 (Groq migration) — this section describes the current, fully-cloud-transcription state, not the original local-first design §3-§4 describe.**

* Transcripts, summaries, and metadata live in IndexedDB, scoped to the browser/device. No account, no login, no server-side database.
* The OpenRouter API key and the Groq API key both live in `localStorage`, each sent only directly to its own provider from the browser — never proxied through a server you operate.
* Tradeoff of local-only history (chosen over cloud sync): no cross-device access, and browser data clears (private browsing, "clear site data", browser reinstall) wipe history. Mitigate with a prominent, easy "Export All" action rather than silently accepting the data-loss risk.
* **Neither channel stays on-device anymore.** Both your own voice (mic) and other participants' audio (tab/system capture) are uploaded to Groq's cloud API for transcription, using your own key. This is a deliberate, explicit decision (§9) for a personal, non-distributed tool — not a default the app quietly slid into. Raw audio itself is still never written to IndexedDB (only the resulting text), and is discarded client-side immediately after each ~10s window's upload completes.

---

## 7. Legal / Consent Note

This is a personal-use tool: no participant-facing consent UI is in scope (§5, Phase 5's recording indicator is a cue for you, not something the other party ever sees — and nothing in this architecture reaches their screen regardless). Recording-consent law is jurisdiction-dependent — some places are one-party consent (yours is enough), others require all parties' consent regardless of what any app displays. That's on you to handle outside the app; not something the app tracks or enforces. The user has explicitly directed that this remains out of scope for the app itself, given personal, non-distributed use.

---

## 8. Verification & Test Suite

1. **Browser Compatibility Matrix:** Confirm full dual-channel capture on Chrome/Edge; confirm graceful mic-only fallback on Safari/Firefox.
2. ~~Offline Transcription Test~~ — **no longer applicable, see §9.** Both channels require live network access to Groq now, by deliberate design; there is no offline transcription path to verify.
3. **No-Key Summarization Test:** Confirm the app functions fully (record, transcribe, save, export) with no OpenRouter key set, and summarization clearly prompts for a key instead of erroring.
4. **Persistence Test:** Record a meeting, reload the page and restart the browser, confirm history is intact in IndexedDB.
5. **Export/Backup Test:** Confirm "Export All" produces a complete, re-importable backup of meeting history.
6. **Storage Quota Test:** Simulate near-quota IndexedDB usage and confirm the app warns rather than silently failing to save.
7. ~~Web Speech Real-Browser Test~~ — **superseded by §9's Groq migration.** Web Speech is no longer part of the app.
8. **Groq Real-Browser Test (see §9 for what's already verified, and what still needs a real key/real call):** record a real meeting with a valid Groq key and confirm (a) both channels produce accurate transcript text, (b) the MediaRecorder stop/restart cycle survives many consecutive windows without stalling (verified structurally with a real mic stream in §9, not yet with a real Groq response), (c) Participants sharing still degrades gracefully to mic-only if the share dialog is declined.

---

## 9. Migration to Groq Cloud Transcription (Personal-Use Pivot)

**Decision, and why:** after the local whisper.cpp pipeline's `audio_ctx` fix (§4.16) still left transcription slow and expensive to maintain (its own Emscripten/WASM build toolchain, single-threaded inference ceiling, a growing pile of accumulated fixes — anti-aliasing, `[BLANK_AUDIO]` filtering, cross-channel timing, the pthreads saga), the user made an explicit, informed call: this is a personal, non-distributed tool used only for meeting notes/minutes/re-referencing, they're comfortable with audio leaving the device (already true for the mic channel via Web Speech, §4.10), and reliable, fast transcription matters more than local-only processing. Regulatory/consent considerations were explicitly directed out of scope by the user for this app (§7). Given that, the user chose to fully replace both the local whisper.cpp engine (Participants) and the Web Speech API (mic) with Groq's cloud Whisper API for both channels — not an incremental fix, a full architectural pivot.

**Why Groq specifically:** hosted `whisper-large-v3` / `whisper-large-v3-turbo`, OpenAI-compatible REST API, the turbo model claims ~216x realtime (irrelevant local-inference-speed ceiling entirely removed), same BYOK pattern already established for OpenRouter (user's own key, sent directly from the browser, never through a server this app operates — so the "$0 operating cost to the developer" principle in §1 still holds).

**What changed:**

* **Capture (`src/lib/audio/capture.ts`), fully rewritten.** The `AudioWorkletNode`/raw-PCM/anti-aliasing pipeline (§3, §4.14) is gone. Level metering now comes from a Web Audio `AnalyserNode` per channel (polled every 100ms). The actual recorded audio comes from a separate `MediaRecorder` per channel, wrapping the same raw `MediaStream` directly — no resampling/anti-aliasing needed at all, since Groq's API accepts standard compressed audio (Opus/WebM, or mp4 on Safari) directly, unlike whisper.cpp which required exact 16kHz mono float32 PCM. Every ~10s (`WINDOW_MS`), each channel's recorder is stopped (flushing one complete, self-contained audio file) and restarted for the next window — MediaRecorder's periodic `dataavailable` chunks aren't independently decodable on their own; only a full stop/start cycle produces a file Groq's per-request endpoint can accept. The shared-epoch-clock pattern from §4.12 (a single `meetingEpochMs`, not per-channel "seconds since this channel started" counters) was deliberately carried over unchanged into `prime(meetingEpochMs)` — the participants-starts-later-than-mic timing bug that fix addressed is exactly as real under this new pipeline as the old one.

* **Window size: 3s → 10s.** Local whisper.cpp's window was constrained by inference latency (§4.9); Groq's speed removes that constraint entirely. Larger windows were chosen deliberately for more model context per call (fewer mid-sentence chunk-boundary cuts, the unresolved problem §4.9 flagged) and smaller compressed-audio upload overhead, at the cost of the live transcript feeling slightly less "in the moment" — judged a reasonable trade for a personal note-taking tool, not a live-captioning one.

* **Transcription (`src/lib/groq/client.ts`, `src/hooks/useGroqTranscription.ts`), new.** Direct multipart upload to `https://api.groq.com/openai/v1/audio/transcriptions` (`response_format: verbose_json` for per-segment timestamps), same BYOK pattern as `src/lib/openrouter/client.ts`. The `no_speech_prob`/bracket-tag filtering from the local-whisper era (§4.11) was carried over unchanged into the Groq client — Groq's whisper-large-v3 family exhibits the same style of non-speech hallucinations on silent audio. Unlike the old `WhisperEngine`, there's no single Worker/queue serializing every call — Groq requests are independent, stateless HTTP calls, so mic and Participants windows (or even overlapping windows within one channel) can be in flight concurrently; ordering in the UI comes from re-sorting segments by `start` after every insert, not from request order.

* **Settings (`src/hooks/useGroqSettings.ts`, `SettingsModal.tsx`).** A Groq API key + model picker (`whisper-large-v3` vs the faster/cheaper default `whisper-large-v3-turbo`), same `localStorage` BYOK pattern as OpenRouter. Unlike OpenRouter's key (which only gates summarization), the Groq key is required for the app to do anything at all — Start meeting is disabled without one.

* **Removed entirely, not just deprecated:** `wasm-build/` (Emscripten patches + build docs), `public/wasm/`, `public/workers/whisper-worker.js`, `public/worklets/pcm-processor.js` (and its dedicated anti-aliasing regression test, `scripts/verify-antialias.js`/`npm run test:dsp` — testing code for DSP logic that no longer exists would be actively misleading, not harmless dead weight), `public/models/` (local dev model cache), `src/lib/stt/{whisperEngine,modelStore,models,webSpeechTypes}.ts`, `src/hooks/{useTranscription,useWebSpeechTranscription,useSttModelSettings,useMicTranscriptionSettings}.ts`, and the `COOP`/`COEP` cross-origin isolation headers in `next.config.ts` (existed only for `SharedArrayBuffer`/multi-threaded WASM, which no longer exists in the app at all). `src/lib/stt/types.ts` (the channel-agnostic `TranscriptSegment` shape) and `format.ts` were kept — still used, unchanged.

* **Offline capability dropped, deliberately.** The service worker (`public/sw.js`) no longer precaches transcription-critical assets (they don't exist anymore) — it now only caches a couple of app-shell assets for a faster repeat load. §5 Phase 5's "verified offline against a production build" milestone no longer applies and isn't being re-chased; both channels require live network access to Groq now, a deliberate, accepted trade-off for a personal tool the user will presumably always use online.

**A real bug found and fixed during this migration, not merely a design choice:** the naive implementation — calling `new MediaRecorder(stream).start()` synchronously inside the *previous* recorder's `onstop` handler to start the next window — throws `NotSupportedError` in Chrome. Confirmed via direct testing (a Playwright harness driving the real app with Chrome's fake-audio-capture device): window 1 always succeeds, but every subsequent restart on the same stream fails immediately, with no self-recovery even across delayed retries. **Root-caused before shipping:** this turned out to be specific to Chrome's synthetic fake-audio-device test harness (likely a single-consumer limitation of that test device) — the identical restart cycle was verified durable across 4+ consecutive real windows (~160KB each) using a real microphone stream in real Chrome, with zero errors. Two things were still kept from the investigation, on defense-in-depth grounds rather than because the root cause turned out to be real-world-relevant: (a) the restart is deferred one task (`setTimeout(..., 0)`) rather than called synchronously in `onstop`, removing any theoretical risk of racing MediaRecorder's own teardown of the previous instance; (b) `recorder.start()` failures get bounded retries (3, with a 250ms gap) before surfacing a visible error via a new `onError` callback threaded through `useMeetingRecorder.ts`, rather than a channel's capture loop silently going quiet forever — the same "cheap insurance, bounded retries, then a real visible error" pattern this project has used before (e.g. the whisper watchdog's `MAX_AUTO_RESTARTS`, §4.7).

**Verified (Playwright, real mic stream, real Chrome, no real Groq key available in this environment):**
* Start meeting is disabled with no Groq key, enabled once one is set.
* A real getUserMedia mic stream, fed through the new `MediaRecorder` pipeline, produces correctly-sized, non-empty audio files (~160KB per ~10s window) across at least 4 consecutive stop/restart cycles with zero failures.
* An intentionally invalid Groq key (same verification technique this project used for OpenRouter in §5 Phase 3) produces a clean 401, surfaced as a visible error banner, not a crash.
* "New meeting" correctly resets back to the ready state.
* `tsc --noEmit` and `eslint` both clean after the full rewrite and file removals; no stray references to any deleted module remain (verified by grep, not just by the type-checker passing).

**Not yet verified — needs a real Groq key and a real meeting:** actual transcription accuracy/quality from Groq (this environment has no real key to test against); Participants-channel behavior specifically (macOS's Screen Recording permission blocked automated `getDisplayMedia` testing in this environment too, same limitation encountered during the earlier local-whisper work — see the removed `wasm-build/README.md`'s benchmark history for the prior occurrence); whether 10s windows feel appropriately "live" in practice, or whether that should be tuned shorter/longer after real use.

**Post-migration fix — silence-gating (see real-user feedback after the first live test):** the first real recording (headphone mic, real Groq key) surfaced two more things. (1) Whisper is well-known to hallucinate generic closing phrases ("Thank you.", "Thanks for watching!") on near-silent audio — confidently, with *low* `no_speech_prob`, so the existing filter never catches it (only high-`no_speech_prob`/bracket-tag hallucinations like `[BLANK_AUDIO]` are caught). A text blocklist was deliberately rejected as the fix, since it risks dropping a real "Thank you." someone actually said — the same silent-data-loss failure mode fixed for Web Speech's interim text in the earlier local-whisper era. (2) Every ~10s window was being uploaded and billed regardless of whether anyone was talking, on both channels, for the whole meeting. Fixed both at once: `src/lib/audio/capture.ts` now tracks each window's peak RMS level (already computed for the live level meter) and simply never uploads a window whose peak never crosses `SILENCE_PEAK_THRESHOLD` — silent audio never reaches Groq to be hallucinated on, and isn't billed. Verified with a Playwright test: a pure-digital-silence window produces zero Groq requests; a real-speech window still uploads normally. Caveat carried into this fix, not fully solved: `getUserMedia`'s `autoGainControl` can slowly amplify background noise during long silences, which could in theory push a purely-noise window's peak above the threshold — a real possibility, judged a much better failure mode than the status quo it replaces.

---

## 10. Subscription Pricing Model (If Productized)

**This app is not currently for sale — it's a personal tool.** This section exists because the user asked for it as a standing reference, to be updated as real Groq/OpenRouter usage data comes in from actual use (the numbers below are estimates with explicit assumptions, not measured). Two fundamentally different business models are possible depending on who holds the API keys; they have very different risk and pricing profiles, so both are modeled separately rather than picking one.

### 10.1 The architectural fork this decision depends on

* **Model A — BYOK (this app's current architecture, unchanged).** Users paste their own Groq + OpenRouter keys; nothing is proxied through infrastructure this app operates. A subscription here would **not** be paying for AI usage at all — the user already pays Groq/OpenRouter directly. It would only be paying for the software, hosting, and ongoing maintenance. Lower risk (no liability for holding customer API keys or usage overages), lower revenue ceiling, much simpler pricing.
* **Model B — Managed/bundled.** The operator holds shared API keys, proxies every request through infrastructure they run, meters usage per customer, and charges one all-in price. This requires real infrastructure that doesn't exist today (an authenticated backend, per-customer usage metering, billing integration) — a materially different, riskier product, not a pricing tweak. Modeled below because the user asked for API costs to be broken out, which only makes sense under this model.

### 10.2 Cost breakdown (Model B assumptions)

**API costs — variable, per user, scales with actual meeting volume.** Groq turbo model (~$0.04/hour of audio, the default) billed on *post-silence-gate* audio (§9's fix), not raw session duration — both channels run concurrently, so a fully-talkative 1-hour meeting bills up to ~2 hours of audio; real meetings have gaps, so effective billed time is usually meaningfully less.

| Usage tier | Meeting hours/mo | Est. billed audio/mo (channels combined, ~65% active) | Groq cost/mo (turbo) | OpenRouter summaries (paid-tier estimate) | Total variable/mo |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Light | 5 hrs | ~6.5 hrs | ~$0.26 | ~$0.30 (10 summaries × $0.03) | **~$0.56** |
| Medium | 20 hrs | ~26 hrs | ~$1.04 | ~$1.20 (40 summaries) | **~$2.24** |
| Heavy | 60 hrs | ~78 hrs | ~$3.12 | ~$1.80 (60 summaries) | **~$4.92** |

(OpenRouter cost assumes a paid model; using the app's own default, `openrouter/free`, this column is $0 — the free-tier router is deliberately the shipped default for exactly this reason, see §5 Phase 3.)

**Infra costs — mostly fixed, near-zero at small scale.** This app's own architecture is unusually cheap to host precisely because it does almost nothing server-side (§1's "$0 Operating Cost" principle, still true under Model A, mostly true under Model B): no database (IndexedDB is client-side), no server-side transcription/LLM compute (both are direct browser-to-provider calls). Vercel's free tier plausibly covers a meaningful user base before the $20/mo Pro tier is needed; add ~$1/mo domain, and optionally ~$0-26/mo error monitoring (e.g. Sentry) once there are real users to monitor.

**Maintenance costs — the actual dominant cost, by a wide margin, at any realistic small-scale user count.** This is a labor cost, not an infrastructure cost, and estimating it honestly matters more than the API numbers above: ongoing dependency updates, bug fixes, adapting to Groq/OpenRouter API changes, browser-compatibility drift, and support. Estimated at 10-20 hours/month for a stable, mature product at small scale, valued at a blended contractor rate of $75-150/hr:

| Scope | Hours/mo | Rate | Cost/mo |
| :--- | :--- | :--- | :--- |
| Light maintenance (stable product, few users) | 10 | $75/hr | $750 |
| Active maintenance (growing product, real support load) | 20 | $150/hr | $3,000 |

### 10.3 Break-even and suggested pricing

Fixed monthly cost (infra + maintenance, Model B) lands roughly in the **$800-3,050/month** range depending on how much active maintenance the product actually needs — maintenance dominates that range, not infra. Subscribers needed to break even, at a few illustrative price points (fixed-cost side only; variable API cost per user is small enough at any of these tiers — under $5/mo even for heavy users — that it doesn't change the required subscriber count much, but should still be subtracted from each subscriber's contribution margin):

| Price/mo | Subscribers to cover $800/mo (light maintenance) | Subscribers to cover $3,050/mo (active maintenance) |
| :--- | :--- | :--- |
| $9 | ~89 | ~339 |
| $19 | ~42 | ~161 |
| $29 | ~28 | ~106 |

**Recommendation, if this were ever productized:** ship **Model A (BYOK)** first, not Model B. It sidesteps the entire variable-API-cost column, the liability of holding customer keys, and usage-metering/billing engineering — the same reasons this app already works this way for OpenRouter. A BYOK subscription only needs to clear infra + maintenance, which is a much smaller, more predictable number than Model B's — plausibly justifying a lower price point (e.g. $5-9/month) purely for the packaged software/support, or staying free/personal as it is today. Model B only becomes worth the added risk and engineering if there's real demand from users who specifically don't want to manage their own API keys — not something to build speculatively.

---

## 11. Speaker Diarization — Scoped, Not Implemented

Confirmed directly against Groq's docs (§9): **no diarization support at all**, same limitation OpenAI's Whisper API has generally. This was already a known v1 limitation before the Groq migration (§2's original "Diarization: None in v1" row) and the migration didn't change it — Participants is, and has always been, one undifferentiated stream, not per-speaker-labeled. This section scopes what actually adding it would take, without committing to building it.

### 11.1 The ceiling this app is already up against

This was flagged once before, in the local-whisper era (§4.10, "Where this architecture's ceiling actually is"), and it applies just as much to any diarization approach: `getDisplayMedia` tab/system-audio capture only ever sees **already-mixed** output audio — post-AEC, post-jitter-buffering, post-mixing by whatever Zoom/Teams/Meet client is running. By the time this app's Participants stream exists, every other call participant's voice is already blended into one channel. Diarizing a pre-mixed stream is a fundamentally harder, less reliable problem than diarizing separate per-participant streams — which is what a real "meeting bot" with platform API access would get (Teams' own server-side model works this way, per the earlier research). **No diarization model or service fixes this — it's a limitation of where in the pipeline this app captures from, not of the model**, and becoming a meeting bot to fix it was already explicitly declined (§1, "No Meeting Bots"). Any diarization work here should be scoped with that ceiling as an explicit, stated expectation up front, not discovered after building it: expect real accuracy limits on the Participants channel specifically that wouldn't exist on, say, a multi-mic in-room recording.

### 11.2 Options

1. **Client-side diarization model (WASM/ONNX).** A speaker-embedding/clustering model (e.g. a pyannote-family model exported to ONNX, run via `onnxruntime-web` or a Rust/`wasm-bindgen` port) running entirely in-browser, clustering the Participants stream into "Speaker 1 / Speaker 2 / …" labels without real identities. Consistent with this app's original architectural preference (§2's Diarization row already named this as the "Future" direction) and with the BYOK/no-server-we-control principle — no new API key, no new vendor. Real cost: another WASM pipeline to build, ship, and maintain, with the exact category of build/runtime debugging this project already spent two full local-whisper.cpp sessions on (§4, §9) — not a small undertaking, and the model would need to run over the *pre-mixed* Participants stream with the ceiling above already priced in to expectations.
2. **Cloud diarization API (BYOK, matching the Groq/OpenRouter pattern).** Services like AssemblyAI or Deepgram offer diarization as part of their transcription response. Fits this app's established BYOK pattern (another optional Settings API key, same shape as Groq/OpenRouter) with much less engineering than option 1 — but is a new vendor/cost surface, and would mean either running transcription twice (once via Groq, once via the diarization vendor) or replacing Groq for Participants specifically with a diarization-capable provider, which reopens the whole "which model transcribes best" evaluation for that channel.
3. **Heuristic speaker-turn segmentation (no new model or vendor).** Detect probable speaker changes from pause length and/or pitch shifts in the existing audio, splitting Participants text into "Speaker A / Speaker B" turns without true identity — cheapest to build, but isn't real diarization (can't tell you it's the *same* Speaker A again three segments later with any confidence) and would likely disappoint if presented as more than a rough turn-by-turn split.

### 11.3 Not scoped further than this

No recommendation is being made between these three — that's a real product decision (engineering cost vs. accuracy expectations vs. new-vendor risk) that should happen separately from this write-up, with the §11.1 ceiling clearly understood going in either way. Not started; no code changes accompany this section.
