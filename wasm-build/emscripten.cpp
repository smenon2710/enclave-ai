#include "whisper.h"

#include <emscripten.h>
#include <emscripten/bind.h>

#include <string>
#include <vector>

std::vector<struct whisper_context *> g_contexts(4, nullptr);

EMSCRIPTEN_BINDINGS(whisper) {
    emscripten::function("init", emscripten::optional_override([](const std::string & path_model) {
        for (size_t i = 0; i < g_contexts.size(); ++i) {
            if (g_contexts[i] == nullptr) {
                g_contexts[i] = whisper_init_from_file_with_params(path_model.c_str(), whisper_context_default_params());
                if (g_contexts[i] != nullptr) {
                    return i + 1;
                } else {
                    return (size_t) 0;
                }
            }
        }

        return (size_t) 0;
    }));

    emscripten::function("free", emscripten::optional_override([](size_t index) {
        --index;

        if (index < g_contexts.size()) {
            whisper_free(g_contexts[index]);
            g_contexts[index] = nullptr;
        }
    }));

    // Runs synchronously on the calling thread. The upstream whisper.wasm demo
    // dispatches this via an outer std::thread purely to make the call
    // non-blocking on the browser's main thread — unnecessary here since this
    // binding is always called from inside a dedicated Worker already off the
    // main thread, and returning structured segments directly (instead of
    // scraping printf output for `[HH:MM:SS.mmm --> ...]` lines) is more
    // robust than text parsing.
    emscripten::function("transcribe", emscripten::optional_override([](size_t index, const emscripten::val & audio, const std::string & lang, int nthreads, bool translate) {
        --index;

        if (index >= g_contexts.size() || g_contexts[index] == nullptr) {
            return emscripten::val::array();
        }

        auto * ctx = g_contexts[index];
        const bool is_multilingual = whisper_is_multilingual(ctx);

        struct whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.print_realtime   = false;
        params.print_progress   = false;
        params.print_timestamps = false;
        params.print_special    = false;
        params.translate        = translate;
        params.language         = is_multilingual ? lang.c_str() : "en";
        params.n_threads        = nthreads;
        params.offset_ms        = 0;

        const int n = audio["length"].as<int>();
        std::vector<float> pcmf32(n);

        emscripten::val heap   = emscripten::val::module_property("HEAPU8");
        emscripten::val memory = heap["buffer"];
        emscripten::val memoryView = audio["constructor"].new_(memory, reinterpret_cast<uintptr_t>(pcmf32.data()), n);
        memoryView.call<void>("set", audio);

        whisper_reset_timings(ctx);
        const int ret = whisper_full(ctx, params, pcmf32.data(), pcmf32.size());

        emscripten::val segments = emscripten::val::array();
        if (ret != 0) {
            return segments;
        }

        const int n_segments = whisper_full_n_segments(ctx);
        for (int i = 0; i < n_segments; ++i) {
            emscripten::val seg = emscripten::val::object();
            seg.set("start", whisper_full_get_segment_t0(ctx, i) * 0.01);
            seg.set("end",   whisper_full_get_segment_t1(ctx, i) * 0.01);
            seg.set("text",  std::string(whisper_full_get_segment_text(ctx, i)));
            segments.call<void>("push", seg);
        }

        return segments;
    }));
}
