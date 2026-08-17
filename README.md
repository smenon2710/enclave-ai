# Enclave AI

Browser-based meeting assistant. No install, no server-side app logic — see
`plan.md` for the full architecture.

**Transcription is fully cloud-based, not local** (see plan.md's migration
note near the end): both your own voice and other participants' audio are
transcribed via Groq's Whisper API, using your own API key sent directly
from the browser to Groq — never through a server this app operates. This
supersedes the project's original design, which kept Participants audio
strictly on-device via local whisper.cpp WASM and used a mic-only hybrid
(Web Speech API) for your own voice. That local pipeline is fully removed
from the codebase now — see plan.md for why, and for the substantial
benchmarking/debugging history of the pipeline it replaced (kept as
historical record, not because any of that code still runs).

## Status

**Phase 1 (capture pipeline):** done, rewritten from the original
AudioWorklet/PCM pipeline to `MediaRecorder`. Mic (`getUserMedia`) and
Participants (`getDisplayMedia` tab/system audio) capture; a live level
meter comes from a Web Audio `AnalyserNode` on each stream, while a
separate `MediaRecorder` per channel captures the actual audio in ~10s
stop/restart cycles (`src/lib/audio/capture.ts`) — each completed window is
a self-contained compressed file (Opus/WebM, or mp4 on Safari) uploaded
directly for transcription. No client-side resampling/anti-aliasing needed
anymore — Groq's API accepts standard compressed audio formats directly,
unlike the local whisper.cpp engine this replaced, which required exact
16kHz mono float32 PCM.

**Phase 2 (transcription):** done — Groq's Whisper API (`whisper-large-v3`,
or the faster/cheaper `whisper-large-v3-turbo` default, your choice in
Settings) transcribes both channels directly from the browser using your
own API key. Fully replaces this project's original local-only whisper.cpp
WASM pipeline (its own Emscripten build toolchain, single-threaded, ~3s
windows) and the Web Speech API mic hybrid that followed it.

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
16's Turbopack build. The service worker now only caches the app shell for
a faster repeat load — **no longer offline-capable for transcription**
(previously verified fully offline end-to-end under the local whisper.cpp
pipeline; both channels now require live network access to Groq, by design,
per the migration above). Responsive pass done at a 375px viewport,
including a real overflow bug found and fixed in the History modal's
toolbar.

All five roadmap phases are built and verified end-to-end, most recently
against the current Groq-based transcription pipeline.

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
- **Short mic utterances vanishing + microphone picker gap** — a real two-party test (a podcast video shared as Participants, own voice via mic) surfaced two mic issues. First: Chrome periodically ends a Web Speech recognition "turn" even in `continuous: true` mode, and any text still sitting as interim (not yet `isFinal`) at that exact moment was silently discarded with zero trace — brief interjections like "OK" never appeared in the transcript at all; now salvaged as a best-effort final segment before restarting. Second, discovered along the way: the Web Speech API has no way to accept a `deviceId` or `MediaStream`, so it silently ignores this app's own microphone picker regardless of what's selected there — added a Settings toggle ("Always transcribe my voice locally too") to force the mic through whisper.cpp instead, which does respect the picker. Also added a live "Finalizing transcript… (Ns and counting)" counter so backlog duration is actually measurable instead of just feeling slow.
- **Local transcription finalize time cut roughly 5-10x — missing `audio_ctx` cap** — a real user reported a 5m26s recording taking over an hour to finalize. Root cause: the WASM binding never set `whisper_full_params.audio_ctx`, so every ~3s window's encoder pass processed the model's full ~30s default context regardless of actual audio length — up to ~10x more encoder compute than necessary per window. Fixed by exposing `audio_ctx` as a JS-controlled parameter rather than hardcoding a value into the WASM binary, and benchmarking candidates directly against the real build (a Worker fed real speech audio, bypassing `getUserMedia`/`getDisplayMedia` entirely) rather than guessing: 384 was chosen after a more aggressive, proportionally-computed value (182) produced duplicated/hallucinated repeated text on some windows in *every* test run — a worse failure mode than slowness, since it isn't caught by the app's existing no-speech/bracket-tag filters. Verified end-to-end through the real app: a 14s two-channel local-transcription test that would previously have cost roughly 55s per channel now finalizes in ~13s total. **Superseded by the Groq migration below** — kept here as historical record of the debugging work, not because any of this WASM pipeline still runs.
- **Migrated both transcription channels to Groq's cloud Whisper API, fully replacing local whisper.cpp and Web Speech** — an explicit, informed decision for this personal, non-distributed tool: the user confirmed they're comfortable with audio leaving the device (already true for the mic channel via Web Speech since plan.md §4.10) and that reliable, fast transcription matters more than local-only processing. This resolves multiple problems the local pipeline could only ever partially fix: the `audio_ctx` tuning above, the whole Emscripten/WASM build toolchain and its maintenance burden, the Web Speech mic-picker gap (plan.md, "Short mic utterances" entry above), and the fundamental single-threaded local inference speed ceiling. Capture moved from a custom `AudioWorklet`/PCM/anti-aliasing pipeline to the browser's `MediaRecorder` API (~10s stop/restart cycles per channel, uploaded as compressed audio files) — Groq's API doesn't need the exact-16kHz-PCM input whisper.cpp did, so that entire DSP layer (and its dedicated regression test) was removed, not just the model. Real trade-off, accepted deliberately: the app is no longer offline-capable, and every meeting now costs a small amount of Groq usage (turbo model: ~$0.04/hour of audio). See plan.md's migration note for the full reasoning and verification.
- **Summary panel was dumping raw Markdown, breaking the spacing/type rhythm against Transcript and Ask** — `SUMMARY_SYSTEM_PROMPT` (`src/lib/openrouter/client.ts`) has always asked OpenRouter for structured Markdown (`## Heading`, `- list`, `**bold**`), but both places that rendered it (`app/page.tsx`'s live Summary panel, `HistoryModal.tsx`'s per-meeting expanded view) just dumped that raw source into a `<pre>` — literal `##`/`-`/`**` characters on screen, with the model's own inconsistent blank-line spacing driving the layout, next to Transcript and Ask which are both hand-styled per line/bubble. Fixed with a small hand-rolled Markdown-to-JSX renderer (`src/components/MarkdownSummary.tsx` — no new dependency, in keeping with this project's existing hand-rolled-over-library preference) that turns those three constructs into real headings/lists/paragraphs using the same section-header treatment already used elsewhere in the console, plus `leading-relaxed` added to Transcript rows and Ask bubbles so all three panels now share one consistent line-height.

## Getting Started

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), add your [Groq API
key](https://console.groq.com/keys) in Settings (required — both channels
need it), then click "Start meeting": it'll ask for microphone access, then
prompt you to share a tab/screen with audio for the "Participants" channel
(Chrome/Edge only — see `plan.md` §4 for why). Each ~10s window of audio is
uploaded to Groq and appears in the transcript once it comes back.

An OpenRouter key (Settings) is optional and only needed for Summary/Ask.

This app requires a live internet connection to transcribe at all — there
is no offline/local fallback (a deliberate trade-off, see the migration
note in plan.md).
