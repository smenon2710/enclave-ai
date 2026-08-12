# Rebuilding public/wasm/whisper/libmain.js

The committed artifact at `public/wasm/whisper/libmain.js` is `whisper.cpp`
compiled to WASM via Emscripten. It's checked in because the build needs a
full Emscripten SDK, not just `npm install`. To reproduce or update it:

## 1. Toolchain

```bash
brew install cmake
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install 3.1.74 && ./emsdk activate 3.1.74
source ./emsdk_env.sh
```

Pinned to **3.1.74**, not `latest`. Both 6.0.6 and 3.1.74 hit the identical
pthreads hang described below — version wasn't the cause — but 3.1.74 is
the one actually verified end-to-end, so stay on it until someone
re-verifies a newer SDK.

## 2. Get whisper.cpp and apply the two patches in this directory

```bash
git clone --depth 1 --branch v1.7.6 https://github.com/ggml-org/whisper.cpp.git
cp emscripten.cpp whisper.cpp/examples/whisper.wasm/emscripten.cpp
cp whisper.wasm-CMakeLists.txt whisper.cpp/examples/whisper.wasm/CMakeLists.txt
```

What the patches do, and why:

- **`emscripten.cpp`** replaces upstream's binding, which dispatches
  transcription via a detached `std::thread` (to avoid blocking a browser
  main-thread caller) and reports results by parsing `printf` timestamp
  lines off stdout. This binding is only ever called from inside a
  dedicated Worker already off the main thread, so that dispatch thread is
  unnecessary complexity — and empirically, it's also where the *original*
  hang (see below) turned out to live. This replacement runs `whisper_full`
  synchronously and returns structured `{start, end, text, noSpeechProb}`
  segments via `whisper_full_get_segment_*` (`noSpeechProb` added after
  real-user testing surfaced `[BLANK_AUDIO]` hallucinations on silent audio
  polluting the transcript — `src/lib/stt/whisperEngine.ts` filters on it
  client-side). The `transcribe` binding also takes an `audio_ctx` parameter
  (passed through from JS on every call — see
  `src/hooks/useTranscription.ts`'s `AUDIO_CTX_UNITS`), added after a real
  user reported a 5m26s recording taking over an hour to finalize: the
  binding previously never set `whisper_full_params.audio_ctx`, so every
  ~3s window paid for the model's full ~30s encoder context regardless of
  actual audio length. Exposed as a JS-controlled parameter (default 0 =
  unset/full context, preserving old behavior) rather than a hardcoded
  value in this file, so the actual number can be tuned/re-verified from
  the JS side without rebuilding this binary again — see
  `useTranscription.ts` for the benchmark results that led to 384.
- **`whisper.wasm-CMakeLists.txt`** currently ships **without**
  `USE_PTHREADS`/`PTHREAD_POOL_SIZE_STRICT` (single-threaded — see History
  below for why), plus `FS` added to `EXPORTED_RUNTIME_METHODS` (needed for
  `Module.FS.writeFile` to load model bytes — `FORCE_FILESYSTEM=1` alone
  doesn't export it) and
  `target_compile_features(libmain PRIVATE cxx_std_17)` (upstream's
  `DefaultTargetOptions.cmake` pins `cxx_std_11` repo-wide;
  `emscripten/bind.h` needs C++14+).

The root `whisper.cpp/CMakeLists.txt`'s `if (EMSCRIPTEN)` block also has its
two `-pthread` lines commented out (it sets that project-wide for
`ggml`/`whisper` themselves, not just `libmain` — a fresh clone has them
active by default, so this is a patch you apply, not something already
matching upstream).

## History: the pthreads hang was real, confirmed in a real browser

A `USE_PTHREADS=1` build (matching upstream's own WASM demo) hung
indefinitely at the inference step in this project's sandboxed build/test
environment, reproduced identically across Emscripten 6.0.6 and 3.1.74, in
both plain Node and headless Chromium with `crossOriginIsolated: true`
confirmed. The app first shipped single-threaded to have something
verified-working while that stayed unresolved, then **re-enabled** pthreads
after real-user latency feedback, on the bet that the hang was specific to
the sandboxed environment (never confirmed broken in a normal browser —
just untested there).

**That bet didn't pay off.** A real user hit the exact same hang in their
actual (non-sandboxed) Chrome — confirmed by the "Transcription worker
stopped responding" watchdog message appearing during real use, not just in
this project's test environment. So the hang isn't sandbox-specific after
all; it's a real problem with this whisper.cpp + Emscripten pthreads
configuration. Pthreads were **disabled again**, back to the
verified-reliable single-threaded build — this is the current, shipped
state.

The watchdog itself (`WhisperEngine.transcribe()` racing every call against
a 25s timeout, throwing `EngineTimeoutError` and terminating the stuck
worker on timeout — `src/lib/stt/whisperEngine.ts`) stays in place as
general-purpose defense-in-depth against *any* stuck worker, not just a
pthreads-specific one, with `useTranscription.ts` capping auto-restarts at
2 before surfacing a persistent error rather than retrying forever. It's
cheap insurance now, not the load-bearing fix it was while pthreads were on.

**If revisiting multi-threading again:** don't re-enable it purely on the
"only my sandbox is broken" theory — that's now been tested and falsified.
Multi-threaded WASM in Emscripten generally *does* work in production
elsewhere (it's a well-trodden path), so this may be specific to this
combination of whisper.cpp/ggml/Emscripten versions, or something about how
this binding requests threads — worth real investigation before trying
again, not just flipping the flag back on.

## 3. Build

```bash
cd whisper.cpp
emcmake cmake -B build-em -DCMAKE_BUILD_TYPE=Release
emmake make -C build-em libmain
cp build-em/bin/libmain.js ../../public/wasm/whisper/libmain.js
```

**Known, not-yet-investigated follow-up:** the `emcmake cmake` configure step
prints `GGML_SYSTEM_ARCH: UNKNOWN` / `Falling back to generic
implementations` and `Adding CPU backend variant ggml-cpu: -DGGML_CPU_GENERIC`
— ggml isn't auto-detecting a SIMD-capable target for the Emscripten build,
so this binary may be running scalar (non-SIMD) code paths. Not pursued
alongside the `audio_ctx` fix above to keep that change isolated and
independently verifiable; worth a real investigation (likely an explicit
`-msimd128`/`GGML_WASM_SIMD`-equivalent CMake flag) as a separate follow-up
if more speed is still needed after `audio_ctx`.

## 4. Re-enabling pthreads (not recommended without new evidence)

Add back `-s USE_PTHREADS=1` / `-s PTHREAD_POOL_SIZE_STRICT=0` in
`whisper.wasm-CMakeLists.txt`'s link flags, and uncomment the two
`-pthread` lines in the root `whisper.cpp/CMakeLists.txt`'s
`if (EMSCRIPTEN)` block, then rebuild. `emscripten.cpp` needs no changes
either way — the synchronous binding doesn't depend on pthreads. Test in a
real browser, ideally more than one machine/OS, before shipping — a single
positive test isn't enough given this has already failed once "in
production."
