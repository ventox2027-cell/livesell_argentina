/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El panel no sirve imágenes de producto todavía; cuando lo haga, las URLs
  // vienen del backend y no de un dominio configurado acá.
  images: { unoptimized: true },
};

export default nextConfig;
