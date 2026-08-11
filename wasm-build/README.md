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

Pinned to **3.1.74**, not `latest`. The `latest` SDK at the time this was
first built (6.0.6) and 3.1.74 both hit the same pthreads hang described
below in this project's sandboxed build environment — version wasn't the
cause — but 3.1.74 is the one actually verified end-to-end, so stay on it
until someone re-verifies a newer SDK.

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
  unnecessary complexity — and empirically, it's also where the original
  hang (see below) turned out to live. This replacement runs `whisper_full`
  synchronously and returns structured `{start, end, text}` segments via
  `whisper_full_get_segment_*`, independent of whether pthreads are on.
- **`whisper.wasm-CMakeLists.txt`** currently ships with
  `-s USE_PTHREADS=1` / `PTHREAD_POOL_SIZE_STRICT=0` in the link flags
  (multi-threaded), plus `FS` added to `EXPORTED_RUNTIME_METHODS` (needed
  for `Module.FS.writeFile` to load model bytes — `FORCE_FILESYSTEM=1`
  alone doesn't export it) and
  `target_compile_features(libmain PRIVATE cxx_std_17)` (upstream's
  `DefaultTargetOptions.cmake` pins `cxx_std_11` repo-wide;
  `emscripten/bind.h` needs C++14+).

`-pthread` also needs to be present in the **root** `whisper.cpp/CMakeLists.txt`
(the `if (EMSCRIPTEN)` block sets it project-wide for `ggml`/`whisper`
themselves, not just `libmain` — it's on by default in a fresh clone of
whisper.cpp, nothing to patch there unless you're following the "disable
pthreads" path below).

## History: the pthreads hang, and why it's safe to ship now anyway

A `USE_PTHREADS=1` build (matching upstream's own WASM demo) originally hung
indefinitely at the inference step, reproduced identically across Emscripten
6.0.6 and 3.1.74, in both plain Node and headless Chromium with
`crossOriginIsolated: true` confirmed — pointing at *this project's
sandboxed dev/build environment* restricting native thread/worker creation,
not a code bug. That hang was never reproduced or confirmed in a normal,
non-sandboxed browser — it just couldn't be tested there. The app first
shipped single-threaded (disabling `-pthread` project-wide and
`USE_PTHREADS=1`/`PTHREAD_POOL_SIZE_STRICT=0` in the link flags) to have
something verified-working while that stayed unresolved.

Multi-threading was re-enabled after real-user latency feedback, on the bet
that the hang was specific to the sandboxed build environment. To make that
bet safe without redoing the whole investigation: `WhisperEngine.transcribe()`
(`src/lib/stt/whisperEngine.ts`) races every call against a 25s timeout; on
timeout it terminates the stuck worker and throws `EngineTimeoutError`, which
`useTranscription.ts` catches specifically to drop to `nthreads=1` and force
a full re-init. So a hang — wherever it happens — degrades to the
previously-verified single-threaded path (with a "restarting
single-threaded" message shown) instead of freezing transcription forever.
This fallback itself was verified end-to-end in the sandboxed environment,
which reliably reproduces the original hang. **Whether threading actually
helps latency in a real browser is still unverified** — if you're using the
app and never see the "restarting single-threaded" message, it's working;
if you do see it, the fallback caught a hang and you're back to the slower
but reliable single-threaded path. See plan.md §4.7.

## 3. Build

```bash
cd whisper.cpp
emcmake cmake -B build-em -DCMAKE_BUILD_TYPE=Release
emmake make -C build-em libmain
cp build-em/bin/libmain.js ../../public/wasm/whisper/libmain.js
```

## 4. Disabling pthreads (reverting to the single-threaded-only build)

If the watchdog fallback in `whisperEngine.ts`/`useTranscription.ts` turns
out not to be enough (e.g. a hang that somehow doesn't route through
`transcribe()`), the fully single-threaded build is the fallback of last
resort. Comment out `-s USE_PTHREADS=1` / `PTHREAD_POOL_SIZE_STRICT=0` in
`whisper.wasm-CMakeLists.txt`'s link flags, and comment out the two
`-pthread` lines in the root `whisper.cpp/CMakeLists.txt`'s
`if (EMSCRIPTEN)` block, then rebuild. `emscripten.cpp` needs no changes
either way — the synchronous binding doesn't depend on pthreads.
