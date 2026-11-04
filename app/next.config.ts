import type { NextConfig } from "next";
import path from "node:path";

// Resolve TypeScript-style `.js` relative imports (used by the shared
// verifier library under `../verifier`) to their `.ts` sources.
const nextConfig: NextConfig = {
  webpack(config) {
    // NOTE: `.js` stays first so bare package-subpath imports inside
    // node_modules (e.g. `@noble/hashes/sha3.js` via near-api-js) resolve
    // against the package `exports` map without probing `.ts`/`.jsx`
    // variants that the map does not export. Relative TypeScript-style
    // `.js` imports under `../verifier` still resolve: no compiled `.js`
    // sits next to those `.ts` sources, so the `.js` probe misses and
    // webpack falls through to `.ts`/`.tsx`.
    config.resolve.extensionAlias = {
      ".js": [".js", ".ts", ".tsx", ".jsx"],
    };
    // Shared sources under `../verifier` import npm deps (bs58, ethers)
    // installed in the app's node_modules. Webpack resolves bare imports
    // from the issuer's directory, so without a fallback it walks up from
    // `../verifier` and misses the app tree. The app tree is appended as a
    // LAST resort: prepending it would shadow nested `node_modules`
    // copies (e.g. `@noble/hashes@2` nested under `@noble/post-quantum`)
    // with the hoisted top level and break package `exports` resolution.
    const appNodeModules = path.join(
      config.context ?? process.cwd(),
      "node_modules",
    );
    const modules = Array.isArray(config.resolve.modules)
      ? config.resolve.modules
      : ["node_modules"];
    if (!modules.includes(appNodeModules)) {
      modules.push(appNodeModules);
    }
    config.resolve.modules = modules;
    return config;
  },
};

export default nextConfig;
