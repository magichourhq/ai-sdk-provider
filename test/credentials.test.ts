// Which API key is used, where it's sent, and what errors may reveal.
import { generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour, magichour } from "../src/index.js";
import { API, fakeApi, type FakeApiOptions, isGeneration } from "./fake-api.js";
import {
  expectNoSecret,
  failingFetch,
  isDownload,
  isUpload,
  rejection,
  type Run,
  runImage,
  runImageVideo,
} from "./helpers.js";

const key = "mh_test_KEY_8f2a91";

describe("which API key is used", () => {
  test("a missing key fails before any request", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", undefined);
    const api = fakeApi();
    const model = createMagicHour({ fetch: api.fetch }).image();
    await expect(generateImage({ model, prompt: "Mug", maxRetries: 0 })).rejects.toThrow(/API key/);
    expect(api.calls).toHaveLength(0);
  });

  // Apps often load their environment after importing the provider.
  test("MAGIC_HOUR_API_KEY is read when a call starts, not when the provider is created", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", undefined);
    const api = fakeApi({ statuses: ["complete"] });
    const model = createMagicHour({ fetch: api.fetch, pollIntervalMs: 0 }).image();
    vi.stubEnv("MAGIC_HOUR_API_KEY", "late-key");
    await generateImage({ model, prompt: "Mug", maxRetries: 0 });
    expect(api.generations()[0].headers.get("Authorization")).toBe("Bearer late-key");
  });

  test("an explicit key wins over the environment", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    const api = fakeApi({ statuses: ["complete"] });
    await runImage(api, { settings: { apiKey: "explicit-key" } });
    for (const call of api.calls.filter((c) => new URL(c.url).origin === API))
      expect(call.headers.get("Authorization")).toBe("Bearer explicit-key");
  });

  // Falling back would bill the environment's account for a tenant whose key is missing.
  test("an empty explicit key fails instead of using the environment's", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    const api = fakeApi();
    await rejection(runImage(api, { settings: { apiKey: "" } }));
    expect(api.calls).toHaveLength(0);
  });

  test("the default magichour export uses the global fetch and the environment's key", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    await generateImage({ model: magichour.image(), prompt: "Mug", maxRetries: 0 });
    expect(api.generations()).toHaveLength(1);
    expect(api.generations()[0].headers.get("Authorization")).toBe("Bearer env-key");
  });
});

describe("where the API key and headers go", () => {
  test("the key goes to the API only, never to storage", async () => {
    const api = fakeApi();
    await runImageVideo(api, { settings: { apiKey: key } });
    for (const call of api.calls.filter((c) => new URL(c.url).origin === API))
      expect(call.headers.get("Authorization")).toBe(`Bearer ${key}`);
    // The upload and the download.
    expect(api.offOrigin()).toHaveLength(2);
    for (const call of api.offOrigin()) {
      expect(call.url).not.toContain(key);
      for (const [, value] of call.headers) expect(value).not.toContain(key);
    }
  });

  // Extra headers on a signed storage request can break its signature.
  test.each<[string, Run]>([
    ["image", runImage],
    ["image-to-video", runImageVideo],
  ])("%s: custom headers reach the submission and polls, but not storage", async (_, run) => {
    const api = fakeApi();
    await run(api, { headers: { "X-Trace-Id": "trace-1" } });
    expect(api.polls().length).toBeGreaterThan(0);
    for (const call of [...api.generations(), ...api.polls()])
      expect(call.headers.get("X-Trace-Id")).toBe("trace-1");
    expect(api.offOrigin().length).toBeGreaterThan(0);
    for (const call of api.offOrigin()) expect(call.headers.has("X-Trace-Id")).toBe(false);
  });
});

describe("errors never reveal secrets", () => {
  test.each<[string, Run, FakeApiOptions]>([
    ["a rejected submission", runImage, { createStatus: 400 }],
    ["a failed download", runImage, { statuses: ["complete"], downloadStatus: 403 }],
    ["a failed upload", runImageVideo, { uploadStatus: 403 }],
  ])("%s doesn't echo the response or the signed URL", async (_, run, options) => {
    const api = fakeApi({ ...options, errorMessage: "signed-url?X-Goog-Signature=SECRET_123" });
    const error = await rejection(run(api, { maxRetries: 0 }));
    expectNoSecret(error, "SECRET_123");
    expectNoSecret(error, "Signature");
  });

  // Node's fetch errors can include the URL, and a custom fetch can include anything.
  test.each([
    ["the upload", isUpload],
    ["the submission", isGeneration],
    ["the download", isDownload],
  ])("a fetch error on %s doesn't echo its message", async (_, match) => {
    const api = fakeApi({ statuses: ["complete"] });
    const fetch = failingFetch(
      api,
      match,
      (request) => new TypeError(`connect failed for ${request.url} with ${key}`)
    );
    const error = await rejection(runImageVideo(api, { settings: { apiKey: key, fetch } }));
    expect(error).toBeInstanceOf(Error);
    expectNoSecret(error, key);
    expectNoSecret(error, "Signature");
  });

  // The runtime's own error for a bad header value repeats the value.
  test("an API key that isn't a valid header value doesn't appear", async () => {
    const api = fakeApi();
    const error = await rejection(runImage(api, { settings: { apiKey: "bad\nKEY_SECRET_9" } }));
    expectNoSecret(error, "KEY_SECRET_9");
    expect(api.generations()).toHaveLength(0);
  });
});
