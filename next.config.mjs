import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  productionBrowserSourceMaps: false,

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            // `interest-cohort=()` was here historically — it's an
            // obsolete FLoC opt-out that no current browser
            // recognises. Chrome logs a yellow warning on every
            // page load. Removed; we use `Referrer-Policy` /
            // `connect-src` to keep tracking surface tight.
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
          },
          // Content-Security-Policy moved into proxy.ts so each
          // request can carry a fresh per-request nonce. Setting it
          // statically here would either force 'unsafe-inline' (the
          // baseline we're trying to remove) or refuse Next.js's own
          // hydration scripts. See middleware.ts buildCsp().
        ],
      },
      {
        source: "/api/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, max-age=0",
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG || "",
  project: process.env.SENTRY_PROJECT || "",
  ...(process.env.SENTRY_AUTH_TOKEN ? {} : { dryRun: true }),
});
