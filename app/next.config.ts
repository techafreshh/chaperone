import type { NextConfig } from "next";

// Resolve TypeScript-style `.js` relative imports (used by the shared
// verifier library under `../verifier`) to their `.ts` sources.
const nextConfig: NextConfig = {
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
