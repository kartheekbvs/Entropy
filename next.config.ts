import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // v4.8 — StackBlitz WebContainers (the Live App embed) require the
  // embedding page to be cross-origin isolated: COOP + COEP. Same-origin
  // subresources (preview webviews, SSE, fonts with CORS) are unaffected;
  // StackBlitz serves its embed frame with the matching CORP headers.
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
