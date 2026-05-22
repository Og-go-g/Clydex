/**
 * Tests for provider-fallback orchestration.
 *
 * Coverage:
 *   - Sticky reads from the most recent assistant.metadata.provider
 *   - New-session detection (no assistant turns)
 *   - When only one provider key is configured, no probe is needed
 *   - When both configured + new session, probe outcome decides
 *   - 429 / 5xx / timeout → fall to OpenAI
 *   - 200 → stay on Anthropic
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStickyProvider,
  isNewSession,
  pickChatProvider,
} from "./provider-fallback";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

describe("getStickyProvider", () => {
  it("returns null on empty history", () => {
    expect(getStickyProvider([])).toBeNull();
  });

  it("returns null when only user messages exist (new session)", () => {
    expect(
      getStickyProvider([{ role: "user" }, { role: "user" }]),
    ).toBeNull();
  });

  it("returns the most recent assistant metadata.provider", () => {
    expect(
      getStickyProvider([
        { role: "user" },
        { role: "assistant", metadata: { provider: "anthropic" } },
        { role: "user" },
      ]),
    ).toBe("anthropic");
    expect(
      getStickyProvider([
        { role: "user" },
        { role: "assistant", metadata: { provider: "openai" } },
      ]),
    ).toBe("openai");
  });

  it("ignores unknown provider values", () => {
    expect(
      getStickyProvider([
        { role: "assistant", metadata: { provider: "gemini" } },
      ]),
    ).toBeNull();
  });

  it("ignores assistant turns with no metadata", () => {
    expect(
      getStickyProvider([{ role: "assistant" }]),
    ).toBeNull();
  });

  it("most-recent-wins when assistants disagree (defensive)", () => {
    expect(
      getStickyProvider([
        { role: "assistant", metadata: { provider: "openai" } },
        { role: "user" },
        { role: "assistant", metadata: { provider: "anthropic" } },
      ]),
    ).toBe("anthropic");
  });
});

describe("isNewSession", () => {
  it("true on empty list", () => {
    expect(isNewSession([])).toBe(true);
  });

  it("true with only user messages", () => {
    expect(isNewSession([{ role: "user" }])).toBe(true);
  });

  it("false once an assistant message exists", () => {
    expect(
      isNewSession([{ role: "user" }, { role: "assistant" }]),
    ).toBe(false);
  });
});

describe("pickChatProvider — single-provider configs", () => {
  it("returns anthropic when only ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    expect(await pickChatProvider([], "claude-sonnet-4")).toBe("anthropic");
  });

  it("returns openai when only OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "k";
    expect(await pickChatProvider([], "claude-sonnet-4")).toBe("openai");
  });

  it("returns anthropic when neither is set (caller will error)", async () => {
    expect(await pickChatProvider([], "claude-sonnet-4")).toBe("anthropic");
  });
});

describe("pickChatProvider — sticky takes precedence", () => {
  it("respects sticky=openai even when Anthropic available", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
    // fetch should NOT be called; force throw to prove it
    global.fetch = vi.fn(() => Promise.reject("probe should not run")) as never;
    const messages = [
      { role: "user" },
      { role: "assistant", metadata: { provider: "openai" as const } },
      { role: "user" },
    ];
    expect(await pickChatProvider(messages, "claude-sonnet-4")).toBe("openai");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("respects sticky=anthropic", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
    global.fetch = vi.fn(() => Promise.reject("probe should not run")) as never;
    const messages = [
      { role: "user" },
      { role: "assistant", metadata: { provider: "anthropic" as const } },
      { role: "user" },
    ];
    expect(await pickChatProvider(messages, "claude-sonnet-4")).toBe("anthropic");
  });
});

describe("pickChatProvider — new session with both providers (probe)", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
  });

  it("stays on Anthropic on probe 200", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    ) as never;
    expect(await pickChatProvider([{ role: "user" }], "claude-sonnet-4")).toBe(
      "anthropic",
    );
  });

  it("falls to OpenAI on probe 429", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 429 })),
    ) as never;
    expect(await pickChatProvider([{ role: "user" }], "claude-sonnet-4")).toBe(
      "openai",
    );
  });

  it("falls to OpenAI on probe 503", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    ) as never;
    expect(await pickChatProvider([{ role: "user" }], "claude-sonnet-4")).toBe(
      "openai",
    );
  });

  it("falls to OpenAI on probe network failure", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("ENETUNREACH"))) as never;
    expect(await pickChatProvider([{ role: "user" }], "claude-sonnet-4")).toBe(
      "openai",
    );
  });

  it("falls to OpenAI on probe non-200 4xx (auth / billing)", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    ) as never;
    expect(await pickChatProvider([{ role: "user" }], "claude-sonnet-4")).toBe(
      "openai",
    );
  });
});
