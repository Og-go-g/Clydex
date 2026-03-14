"use client";

import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary] Caught error:", error, errorInfo);

    // Report to Sentry if available
    if (typeof window !== "undefined" && "Sentry" in window) {
      const sentry = (window as Record<string, unknown>).Sentry;
      if (sentry && typeof sentry === "object" && "captureException" in sentry) {
        (sentry as { captureException: (e: Error, ctx: Record<string, unknown>) => void }).captureException(
          error,
          { extra: { componentStack: errorInfo.componentStack } }
        );
      }
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-[50vh] items-center justify-center p-6">
          <div className="w-full max-w-md rounded-2xl border border-red-500/20 bg-zinc-900 p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
              <svg
                className="h-8 w-8 text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                />
              </svg>
            </div>
            <h2 className="mb-2 text-lg font-semibold text-white">
              Something went wrong
            </h2>
            <p className="mb-6 text-sm text-zinc-400">
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={this.handleReset}
                className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500"
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="rounded-xl border border-zinc-700 px-6 py-3 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
