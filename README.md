# Enclave AI

Browser-based meeting assistant. No install, no server-side audio or LLM
processing — see `plan.md` for the full architecture.

**Transcription is hybrid, not fully local** (see plan.md §4.10): your own
voice goes through the browser's cloud speech service when available (fast,
accurate, but that audio leaves the device — Web Speech API, e.g. Google's
recognition backend in Chrome), falling back to on-device whisper.cpp WASM
otherwise. Participants' audio always stays on-device via whisper.cpp — Web
Speech has no way to capture anything but the microphone. The in-app UI
labels each channel "— cloud" / "— local" live so this is never hidden.

## Status

**Phase 1 (capture pipeline):** done. Mic (`getUserMedia`) and participants
(`getDisplayMedia` tab/system audio) capture, piped through an
`AudioWorkletNode` and resampled to 16kHz mono PCM in-memory.

**Phase 2 (client-side transcription):** done, single-threaded — see
plan.md §4.7. `whisper.cpp` compiled to WASM (`public/wasm/whisper/`, build
instructions in `wasm-build/`) runs in a dedicated Worker
(`public/workers/whisper-worker.js`), transcribing the Participants channel
locally (the mic channel now prefers the cloud Web Speech API — see below).
Model weights fetch from Hugging Face on first use and cache in IndexedDB.
Multi-threading was tried after real-user latency feedback, and reverted
after a real user confirmed it hangs in their actual browser too, not just
this project's sandboxed test environment — see `wasm-build/README.md` for
the full history. A watchdog in `WhisperEngine.transcribe()` stays in place
as general-purpose defense against any stuck worker (not a pthreads-specific
one anymore), capped at 2 auto-restarts before surfacing a persistent error.

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
- **Latency**: audio capture itself has zero latency (it's 100% client-side; Vercel hosting only serves the initial static files) — the delay is the transcription pipeline. Reduced the fixed buffering window from 5s to 3s (small cost to per-chunk context/accuracy). Also tried re-enabling multi-threaded WASM with a watchdog fallback — **that was reverted**: a real user hit the exact same hang in their actual browser that previously only showed up in this project's sandboxed test environment, so the bet that it was sandbox-specific didn't hold up. Back to single-threaded, which has been reliable everywhere it's been tested. See `wasm-build/README.md` for the full story.
- **Free-tier OpenRouter models**: default model changed to `openrouter/free` (OpenRouter's self-maintaining free-tier router), and the Settings model picker has a "Free only" filter (checked by default) so testing never touches a paid model by accident. Also added typo protection: the model field now warns if what you typed doesn't match any known OpenRouter model ID, plus a one-click "Reset to default" — a real bug (a mistyped `operouter/free`, saved silently since the field accepts free text) prompted this.
- **Ask (Otter-style Q&A)**: a chat panel below Summary — ask questions about the current/just-finished meeting ("what did we decide?", "what are my action items?") and get answers grounded only in that meeting's transcript, with multi-turn follow-up support. Currently scoped to the active meeting only; asking questions about a past meeting from History isn't wired up yet.
- **Mic transcription moved to a hybrid (Web Speech API + whisper.cpp fallback)** — see plan.md §4.10 for the full story. After multi-threading and a smaller window still didn't meet real-user latency/accuracy expectations, and after being shown that no local in-browser model can match cloud ASR speed, the user made an explicit, informed call to accept mic audio leaving the device for speed. Web Speech can only ever handle the mic channel (no way to point it at captured tab/system audio), so Participants stays on whisper.cpp regardless — this makes the app's transcription pipeline permanently hybrid, not a temporary state. A 10s startup watchdog surfaces a clear error if Web Speech silently never responds (observed in this project's sandboxed test environment — a known headless-Chrome limitation, not a code bug) instead of leaving "Listening…" showing forever. **Unverified**: whether Web Speech actually delivers on speed/accuracy in a real browser session — needs real-world use to confirm. Researched against how Microsoft Teams achieves its quality (forking each participant's unmixed stream server-side before any mixing) — confirmed that's a real ceiling on the Participants channel specifically (this app only ever sees already-mixed tab/system output, not a clean source stream) that no model swap fixes, and that matching it would require becoming a meeting bot with platform API access — explicitly declined, not pursuing (see plan.md §1, "No Meeting Bots").
- **`[BLANK_AUDIO]` and other bracketed non-speech tags were leaking into the transcript** — whisper hallucinates these as a literal "transcription" of silent/non-speech audio, most visible on the Participants channel during solo testing. Pure noise for the summarization/Ask LLM calls. Fixed at the source: the custom WASM binding now also returns each segment's `no_speech_prob` (whisper's own confidence there's no speech), filtered client-side against whisper.cpp's own default threshold, plus a text-pattern check as defense in depth. Verified with a real recording: 60s of genuine silence on both channels now produces zero transcript segments (previously repeated `[BLANK_AUDIO]` lines), with no false-positive filtering of actual speech in the same test.
- **Multi-threaded WASM reverted after a real user hit the exact hang it was gambling against** — the "Transcription worker stopped responding" watchdog message (added as a safety net when threading was re-enabled) appeared during real use in the user's actual browser, confirming the hang wasn't specific to this project's sandboxed test environment after all. Back to the single-threaded build, verified fast and hang-free again (~14s to first transcript in testing, vs. eating a 25s+ hang-and-recover cycle on the threaded build). The watchdog itself stays as general-purpose protection against any stuck worker, now capped at 2 auto-restarts before surfacing a persistent error instead of retrying forever. See `wasm-build/README.md` for the full back-and-forth.
- **Cross-channel transcript ordering fixed** — a real two-party call surfaced that mic and participants segments could sort into the wrong order. Root cause: whisper's per-channel timestamps and Web Speech's timestamps were each measured from their own independent starting point (whisper per-channel counters started participants at 0 regardless of how long the share-picker dialog took; Web Speech started its own clock only after *both* permission prompts had resolved). Fixed by anchoring everything to one shared clock — see plan.md §4.12. Verified in-browser that whisper-side ordering is now correct; Web Speech-side interleaving needs the user's next real call to confirm, since Web Speech doesn't fire events in this project's sandboxed test environment (same limitation as the mic hybrid work above).
- **"Finalizing transcript" indicator** — local transcription can still have a backlog draining after you hit Stop (whisper.cpp processes chunks through one serial queue; if a call runs behind real-time, Stop doesn't clear that backlog, it just adds to the end of it — this is what was behind a real user seeing roughly a minute's delay before the final transcript settled). Generate Summary and Ask are now disabled with a visible "Finalizing transcript…" banner until that backlog actually drains, so neither runs against a partial transcript. Scoped to only appear once a meeting is stopped — the same underlying counter is nonzero throughout normal live recording too (a window is always in flight), where "finalizing" would be a misleading label.
- **Fixed a real Participants transcription accuracy bug — missing anti-aliasing filter** — a user reported garbled text specifically for other call participants despite the audio itself sounding fine on playback. The PCM downsampler (`public/worklets/pcm-processor.js`) was decimating from the device's native rate (commonly 48kHz) down to whisper's 16kHz via linear interpolation only, with no low-pass filter first — so real energy above 16kHz's Nyquist frequency was aliasing into the speech band during downsampling, corrupting exactly what whisper actually transcribes from, invisibly to a human listening to the unfiltered original. Fixed with a proper two-stage low-pass filter before decimation. Also tried, then reverted before shipping: switching the default transcription model from tiny.en to base.en for better accuracy — a direct timing probe showed base.en can take longer than the 25s watchdog timeout per window, which would silently produce *less* transcript, not more, via repeated restart cycles. See plan.md §4.14.
- **"New meeting" button + wider, two-column layout** — after Stop, a "New meeting" button clears the transcript/summary/chat back to a blank ready screen without re-prompting for mic/participants permissions (separate from clicking Start, which still resets the same state as a side effect of immediately starting the next recording). The page layout was also widened (`max-w-6xl`, up from a narrow single `max-w-xl` column) with the live session controls (mic picker, Start/Stop/New meeting, level meters) grouped into one panel, and Transcript/Summary/Ask arranged as a wide transcript pane with a sticky Summary+Ask sidebar on large screens — falling back to the original single-column stack (verified against the same 375px viewport as Phase 5) on small ones.

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
`next.config.ts`. Not currently load-bearing — the shipped WASM build is
single-threaded (see `wasm-build/README.md` for why) — left in place in
case multi-threading gets revisited with real investigation behind it.

To point at a local model file instead of fetching from Hugging Face every
reload during development, set `NEXT_PUBLIC_WHISPER_MODEL_URL` in
`.env.local`. Note this overrides the in-app model picker entirely (it takes
priority over whatever's selected in Settings) — don't leave it set if
you're testing the tiny.en/base.en switcher.

To test offline/PWA behavior, use a production build (`npm run build && npm
run start`) — `npm run dev`'s Turbopack HMR chunk names change between
requests, so the service worker can't cache them meaningfully and offline
mode will appear broken in dev even though it works in production.
