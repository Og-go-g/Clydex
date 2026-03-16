import * as Sentry from "@sentry/nextjs";

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    environment: process.env.NODE_ENV,
    // Don't send PII
    sendDefaultPii: false,
    // Filter out noisy errors
    ignoreErrors: [
      "ResizeObserver loop",
      "Non-Error promise rejection",
      "Network request failed",
      "Load failed",
      "user rejected",
      "User denied",
    ],
  });
}
