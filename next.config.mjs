/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Express server owns /api/*; Next renders the reference dashboard.
  poweredByHeader: false,
};

export default nextConfig;
