import { afterEach, vi } from "vitest";

// Tests must never reach the network. A rewrite that bypasses the `fetch` setting fails here
// instead of calling the real API. Tests that need the global fetch stub it explicitly.
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected network request in a test: ${String(input)}`);
};

afterEach(() => {
  vi.useRealTimers();
});
