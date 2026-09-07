import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../', import.meta.url)),
}

export default nextConfig
