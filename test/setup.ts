// Unit tests must never reach the network. A rewrite that bypasses the `fetch` setting fails
// here instead of calling the real API. Tests that need the global fetch stub it explicitly.
if (process.env.MAGIC_HOUR_LIVE !== "1")
  globalThis.fetch = async (input) => {
    throw new Error(`Unexpected network request in a unit test: ${String(input)}`);
  };
