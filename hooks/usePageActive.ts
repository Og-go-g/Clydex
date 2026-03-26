"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Returns `true` when the page is visible AND the user has been active recently.
 *
 * - `idleTimeout` (ms): after this much inactivity, returns `false` (default: 10 min).
 *   Pass `0` to disable idle detection (only use visibility).
 * - On visibility hidden → immediately `false`.
 * - On visibility visible → immediately `true` (resets idle timer).
 * - User activity (mouse, keyboard, touch, scroll) resets the idle timer.
 *
 * Use this to pause WS/polling when the user isn't looking.
 */
export function usePageActive(idleTimeout = 10 * 60 * 1000): boolean {
  const [active, setActive] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);

  const markActive = useCallback(() => {
    if (!activeRef.current) {
      activeRef.current = true;
      setActive(true);
    }
    // Reset idle timer
    if (idleTimeout > 0) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        activeRef.current = false;
        setActive(false);
      }, idleTimeout);
    }
  }, [idleTimeout]);

  useEffect(() => {
    // Visibility change
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        markActive();
      } else {
        activeRef.current = false;
        setActive(false);
        if (timerRef.current) clearTimeout(timerRef.current);
      }
    };

    // User activity events
    const onActivity = () => { if (document.visibilityState === "visible") markActive(); };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity, { passive: true });
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });

    // Start idle timer
    markActive();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("scroll", onActivity);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [markActive]);

  return active;
}
