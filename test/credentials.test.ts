// Which API key is used, where it's sent, and what errors may reveal.
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour, magichour } from "../src/index.js";
import { API, fakeApi, type FakeApiOptions, png, STORAGE } from "./fake-api.js";
import {
  expectNoSecret,
  expectRecoverable,
  failingFetch,
  isDownload,
  isPoll,
  isUpload,
  isUploadUrlRequest,
  latch,
  onlyProject,
  rejection,
  type Run,
  runImage,
  runImageVideo,
  until,
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

  test("MAGIC_HOUR_API_KEY is read on every call, so a rotated key takes effect", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const model = createMagicHour({ fetch: api.fetch, pollIntervalMs: 0 }).image();
    vi.stubEnv("MAGIC_HOUR_API_KEY", "old-key");
    await generateImage({ model, prompt: "Mug", maxRetries: 0 });
    vi.stubEnv("MAGIC_HOUR_API_KEY", "new-key");
    await generateImage({ model, prompt: "Mug", maxRetries: 0 });
    expect(api.generations().map((c) => c.headers.get("Authorization"))).toEqual([
      "Bearer old-key",
      "Bearer new-key",
    ]);
  });

  test("a key rotated mid-job applies to the next call, not the running job", async () => {
    const api = fakeApi({ statuses: ["rendering", "complete"] });
    const model = createMagicHour({
      fetch: api.fetch,
      pollIntervalMs: 0,
      onProjectCreated: () => void vi.stubEnv("MAGIC_HOUR_API_KEY", "new-key"),
    }).image();
    vi.stubEnv("MAGIC_HOUR_API_KEY", "old-key");
    await generateImage({ model, prompt: "Mug", maxRetries: 0 });
    for (const call of api.calls)
      expect(call.headers.get("Authorization")).not.toBe("Bearer new-key");
    expect(api.polls().length).toBeGreaterThan(1);
    await generateImage({ model, prompt: "Mug", maxRetries: 0 });
    expect(api.generations()[1].headers.get("Authorization")).toBe("Bearer new-key");
  });

  test("a key rotated during an upload doesn't change the running job's account", async () => {
    const upload = latch();
    const api = fakeApi({
      statuses: ["complete"],
      gate: (c) => (isUpload(c) ? upload.promise : undefined),
    });
    const model = createMagicHour({ fetch: api.fetch, pollIntervalMs: 0 }).video();
    vi.stubEnv("MAGIC_HOUR_API_KEY", "old-key");
    const job = generateVideo({ model, prompt: { image: png, text: "Animate" }, maxRetries: 0 });
    await until(() => api.calls.some(isUpload));
    vi.stubEnv("MAGIC_HOUR_API_KEY", "new-key");
    upload.release();
    await job;
    for (const call of api.calls.filter((c) => new URL(c.url).origin === API))
      expect(call.headers.get("Authorization")).toBe("Bearer old-key");
  });

  test("an explicit key wins over the environment", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    const api = fakeApi({ statuses: ["complete"] });
    await runImage(api, { settings: { apiKey: "explicit-key" } });
    for (const call of api.calls.filter((c) => new URL(c.url).origin === API))
      expect(call.headers.get("Authorization")).toBe("Bearer explicit-key");
  });

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
  test.each<[string, Run]>([
    ["ai-image-generator", runImage],
    ["image-to-video", runImageVideo],
  ])("%s: the key goes to the API only, never to storage", async (_, run) => {
    const api = fakeApi();
    await run(api, { settings: { apiKey: key } });
    for (const call of api.calls.filter((c) => new URL(c.url).origin === API))
      expect(call.headers.get("Authorization")).toBe(`Bearer ${key}`);
    expect(api.offOrigin().length).toBeGreaterThan(0);
    for (const call of api.offOrigin()) {
      expect(call.url).not.toContain(key);
      for (const [, value] of call.headers) expect(value).not.toContain(key);
      const body =
        call.body instanceof Uint8Array
          ? Buffer.from(call.body).toString("latin1")
          : JSON.stringify(call.body ?? "");
      expect(body).not.toContain(key);
    }
  });

  test("a caller's Authorization header can't replace the configured key", async () => {
    const api = fakeApi();
    await runImageVideo(api, {
      settings: { apiKey: key },
      headers: { authorization: "Bearer someone-elses-key" },
    });
    const apiCalls = api.calls.filter((c) => new URL(c.url).origin === API);
    expect(apiCalls.length).toBeGreaterThan(1);
    for (const call of apiCalls) expect(call.headers.get("Authorization")).toBe(`Bearer ${key}`);
    for (const call of api.offOrigin()) expect(call.headers.has("Authorization")).toBe(false);
  });

  test("custom headers reach the submission and polls, but not storage", async () => {
    const api = fakeApi();
    await runImageVideo(api, { headers: { "X-Trace-Id": "trace-1" } });
    expect(api.polls().length).toBeGreaterThan(0);
    for (const call of [...api.generations(), ...api.polls()])
      expect(call.headers.get("X-Trace-Id")).toBe("trace-1");
    for (const call of api.offOrigin()) expect(call.headers.has("X-Trace-Id")).toBe(false);
  });

  test("storage requests never send cookies", async () => {
    const api = fakeApi();
    await runImageVideo(api);
    expect(api.storage().length).toBeGreaterThan(1);
    for (const call of api.storage()) expect(call.credentials).toBe("omit");
  });

  test.each([
    ["a project poll", isPoll],
    ["the upload-URL request", isUploadUrlRequest],
  ])("a cross-origin redirect on %s is not followed", async (_, match) => {
    const api = fakeApi({
      redirect: (c) => (match(c) ? "https://attacker.example/steal" : undefined),
    });
    await rejection(runImageVideo(api));
    expect(api.calls.some((c) => c.url.startsWith("https://attacker.example"))).toBe(false);
    expect(api.generations().length).toBeLessThanOrEqual(1);
  });
});

describe("errors never reveal secrets", () => {
  test.each<[string, Run, FakeApiOptions]>([
    ["a rejected submission", runImage, { createStatus: 400 }],
    ["a failed submission", runImage, { createStatus: 500 }],
    ["a failed poll", runImage, { projectStatus: 500 }],
    ["a failed download", runImage, { statuses: ["complete"], downloadStatus: 403 }],
    ["a failed upload-URL request", runImageVideo, { uploadUrlsStatus: 500 }],
    ["a failed upload", runImageVideo, { uploadStatus: 403 }],
    [
      "a rejected job with a signed input image URL",
      (api) =>
        generateVideo({
          model: api.provider().video(),
          prompt: {
            image: "https://cdn.example.com/in.png?X-Amz-Signature=SECRET_123",
            text: "Go",
          },
          maxRetries: 0,
        }),
      { createStatus: 422 },
    ],
    [
      "a plain-text rejection",
      runImageVideo,
      {
        createResponse: () =>
          new Response(`Invalid image ${STORAGE}/in.png?X-Goog-Signature=SECRET_123`, {
            status: 422,
            headers: { "Content-Type": "text/plain" },
          }),
      },
    ],
    [
      "a malformed upload-URL response",
      runImageVideo,
      {
        // V8's parse error quotes the start of the text.
        uploadUrlsResponse: () =>
          new Response("SECRET_123 {", { headers: { "Content-Type": "application/json" } }),
      },
    ],
  ])("%s doesn't echo the response or the signed URL", async (_, run, options) => {
    const api = fakeApi({ ...options, errorMessage: "signed-url?X-Goog-Signature=SECRET_123" });
    const error = await rejection(run(api, { maxRetries: 0 }));
    expectNoSecret(error, "SECRET_123");
    expectNoSecret(error, "Signature");
  });

  // Node's fetch errors can include the URL, and a custom fetch can include anything.
  test.each([
    ["the upload-URL request", isUploadUrlRequest],
    ["the upload", isUpload],
    [
      "the submission",
      (c: { url: string; method: string }) => c.method === "POST" && /to-video$/.test(c.url),
    ],
    ["a poll", isPoll],
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
    if (api.projects().length) expectRecoverable(error, onlyProject(api));
  });

  test.each<[string, Run, FakeApiOptions]>([
    [
      "a plain-HTTP download URL",
      runImage,
      {
        statuses: ["complete"],
        downloads: () => [
          { url: "http://videos.magichour.ai/out.png?sig=URL_SECRET_42", expires_at: "2099-01-01" },
        ],
      },
    ],
    ...[
      ["a plain-HTTP upload URL", "http://videos.magichour.ai/in.png?sig=URL_SECRET_42"],
      [
        "an upload URL with embedded credentials",
        "https://user:URL_SECRET_42@videos.magichour.ai/in.png",
      ],
      [
        "an upload URL that doesn't parse",
        "https://videos.magichour.ai:bad/in.png?sig=URL_SECRET_42",
      ],
    ].map(([name, url]): [string, Run, FakeApiOptions] => [
      name,
      runImageVideo,
      {
        uploadUrlsBody: {
          items: [{ upload_url: url, file_path: "api-assets/x.png", expires_at: "2099-01-01" }],
        },
      },
    ]),
  ])("rejecting %s doesn't echo it", async (_, run, options) => {
    const api = fakeApi(options);
    const error = await rejection(run(api));
    expectNoSecret(error, "URL_SECRET_42");
    expect(api.calls.some((c) => c.url.includes("URL_SECRET_42"))).toBe(false);
  });

  test("an API key that isn't a valid header value doesn't appear", async () => {
    const api = fakeApi();
    const error = await rejection(runImage(api, { settings: { apiKey: "bad\nKEY_SECRET_9" } }));
    expectNoSecret(error, "KEY_SECRET_9");
    expect(api.generations()).toHaveLength(0);
  });

  test("a caller's abort reason during an upload doesn't appear", async () => {
    const controller = new AbortController();
    const api = fakeApi({
      hold: (c) => {
        if (!isUpload(c)) return false;
        queueMicrotask(() => controller.abort(new Error("ABORT_REASON_SECRET")));
        return true;
      },
    });
    const error = await rejection(runImageVideo(api, { abortSignal: controller.signal }));
    expectNoSecret(error, "ABORT_REASON_SECRET");
    expect(api.generations()).toHaveLength(0);
  });
});
