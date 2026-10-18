import { join } from "node:path";
import { loadDotEnv } from "./src/load-env.mjs";

// Next auto-loads env files only from the app dir; RIPPLE keeps its config at
// the repo root. This hydrates the config file's own process.env too (devtools
// like `next build` evaluate this file in-process).
for (const dir of [process.cwd(), join(process.cwd(), "..", "..")]) {
  loadDotEnv(dir);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // workspace packages ship TypeScript sources directly (main/exports → src)
  transpilePackages: ["@ripple/core", "@ripple/agent"],
  // the redis-protocol FalkorDB client must stay a real node module
  serverExternalPackages: ["falkordb"],
  webpack: (config) => {
    // workspace sources use NodeNext ".js" specifiers that resolve to ".ts" files
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
