import type { NextConfig } from "next";

// Cross-origin isolation, required for SharedArrayBuffer so whisper.cpp's
// WASM build can run multi-threaded (Phase 2). Without these headers it
// still works, just single-threaded.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
