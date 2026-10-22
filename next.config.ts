import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Plain files in out/, served by the agent itself: no Next.js server running in the background.
  output: "export",
  experimental: {
    agentFeedback: true,
  },
  // cacheComponents and partialPrefetching (template defaults) turn on PPR, which
  // a static export cannot use; this dashboard is a single client page anyway.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
