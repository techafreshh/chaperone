import type { NextConfig } from "next";
import path from "node:path";

// Resolve TypeScript-style `.js` relative imports (used by the shared
// verifier library under `../verifier`) to their `.ts` sources.
const nextConfig: NextConfig = {
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    // Shared sources under `../verifier` import npm deps (bs58, ethers)
    // installed in the app's node_modules. Webpack resolves bare imports
    // from the issuer's directory, so without this it walks up from
    // `../verifier` and misses the app tree entirely.
    const appNodeModules = path.join(
      config.context ?? process.cwd(),
      "node_modules",
    );
    const modules = Array.isArray(config.resolve.modules)
      ? config.resolve.modules
      : ["node_modules"];
    if (!modules.includes(appNodeModules)) {
      modules.unshift(appNodeModules);
    }
    config.resolve.modules = modules;
    return config;
  },
};

export default nextConfig;
