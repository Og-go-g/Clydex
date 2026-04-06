"use client";

import { useState, useEffect } from "react";

export function Footer() {
  const [traders, setTraders] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.traders === "number") setTraders(d.traders);
      })
      .catch(() => {});
  }, []);

  return (
    <footer id="site-footer" className="flex items-center justify-between px-6 py-4 bg-[#0a0a0a]/[0.08] backdrop-blur-sm">
      {traders !== null ? (
        <span className="text-[11px] text-gray-600">
          <span className="text-gray-400">{traders.toLocaleString()}</span> users
        </span>
      ) : (
        <span />
      )}
      <a
        href="https://x.com/ClydexAi"
        target="_blank"
        rel="noopener noreferrer"
        className="text-gray-600 transition-colors hover:text-gray-300"
        aria-label="Follow on X"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </a>
    </footer>
  );
}
