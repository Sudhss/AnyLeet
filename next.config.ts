import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root. Without this, Turbopack walks up past the repo and
  // adopts an unrelated package-lock.json from the user's home directory.
  turbopack: { root: __dirname },
};

export default nextConfig;
