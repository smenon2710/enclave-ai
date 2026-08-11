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
built (6.0.6) and 3.1.74 both hit the same pthreads hang described below —
version wasn't the cause — but 3.1.74 is the one actually verified working
end-to-end, so stay on it until someone re-verifies a newer SDK.

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
  unnecessary — and empirically, it's also where things hung (see below).
  The replacement runs `whisper_full` synchronously and returns structured
  `{start, end, text}` segments via `whisper_full_get_segment_*`.
- **`whisper.wasm-CMakeLists.txt`** drops `-s USE_PTHREADS=1` /
  `PTHREAD_POOL_SIZE_STRICT=0` from the link flags, and adds `FS` to
  `EXPORTED_RUNTIME_METHODS` (needed for `Module.FS.writeFile` to load model
  bytes — `FORCE_FILESYSTEM=1` alone doesn't export it) and
  `target_compile_features(libmain PRIVATE cxx_std_17)` (upstream's
  `DefaultTargetOptions.cmake` pins `cxx_std_11` repo-wide;
  `emscripten/bind.h` needs C++14+).

Also disable `-pthread` in the **root** `whisper.cpp/CMakeLists.txt`
(the `if (EMSCRIPTEN)` block sets `-pthread` project-wide for all targets,
including `ggml`/`whisper` themselves, not just `libmain`):

```bash
# Comment out these two lines inside the `if (EMSCRIPTEN)` block:
#   set(CMAKE_C_FLAGS   "${CMAKE_C_FLAGS}   -pthread")
#   set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")
```

**Why no pthreads:** a `USE_PTHREADS=1` build (matching upstream's own WASM
demo) hung indefinitely at the inference step, reproduced identically across
Emscripten 6.0.6 and 3.1.74, and in both plain Node and headless Chromium
with `crossOriginIsolated: true` confirmed — pointing at the sandboxed
dev/build environment restricting native thread/worker creation, not a code
bug. The pthreads-free build worked immediately. **This needs re-verifying
in a normal (non-sandboxed) browser** — real Chrome very likely handles the
pthreads build fine, since it's the exact pattern whisper.cpp's own official
demo ships in production. Until re-verified, single-threaded is what's
actually confirmed working; see plan.md §4.7.

## 3. Build

```bash
cd whisper.cpp
emcmake cmake -B build-em -DCMAKE_BUILD_TYPE=Release
emmake make -C build-em libmain
cp build-em/bin/libmain.js ../../public/wasm/whisper/libmain.js
```

## 4. Re-enabling pthreads later

Revert the CMake patches (restore `-pthread` in the root CMakeLists and
`USE_PTHREADS=1`/`PTHREAD_POOL_SIZE_STRICT=0` in the wasm CMakeLists), keep
`emscripten.cpp` as-is (the synchronous binding doesn't depend on pthreads
either way — it's just no longer relying on `std::thread` for async dispatch,
which was the actual hang point), rebuild, and test in a real browser
(not headless/sandboxed) before shipping.
