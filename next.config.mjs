/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  poweredByHeader: false,
  allowedDevOrigins: ['localhost', '127.0.0.1', '172.16.80.182'],
};

export default nextConfig;
