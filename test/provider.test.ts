import { NoSuchModelError } from "@ai-sdk/provider";
import {
  createProviderRegistry,
  experimental_generateVideo as generateVideo,
  generateImage,
} from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMagicHour, magichour, MagicHourError } from "../src/index.js";
import { API, fakeApi, png } from "./fake-api.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("API key", () => {
  test("creating the provider and models needs no key", () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", undefined);
    const provider = createMagicHour();
    expect(() => provider.image()).not.toThrow();
    expect(() => provider.video()).not.toThrow();
    expect(magichour.image("flux-2-klein").modelId).toBe("flux-2-klein");
  });

  test("a missing key fails before any request", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", undefined);
    const api = fakeApi();
    const provider = createMagicHour({ fetch: api.fetch });
    await expect(
      generateImage({ model: provider.image(), prompt: "Mug", maxRetries: 0 })
    ).rejects.toThrow(/API key/);
    expect(api.calls).toHaveLength(0);
  });

  test("reads MAGIC_HOUR_API_KEY on every call, so a rotated key takes effect", async () => {
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

  test("a key rotated mid-job applies to the next call, not to the running job", async () => {
    const api = fakeApi({ statuses: ["rendering", "complete"] });
    const model = createMagicHour({
      fetch: api.fetch,
      pollIntervalMs: 0,
      onProjectCreated: () => {
        vi.stubEnv("MAGIC_HOUR_API_KEY", "new-key");
      },
    }).image();
    vi.stubEnv("MAGIC_HOUR_API_KEY", "old-key");
    await generateImage({ model, prompt: "Mug", maxRetries: 0 });
    const [first] = api.projects();
    for (const call of api.polls().filter((c) => c.url.endsWith(`/${first.id}`)))
      expect(call.headers.get("Authorization")).toBe("Bearer old-key");
    expect(api.generations()[0].headers.get("Authorization")).toBe("Bearer old-key");
    await generateImage({ model, prompt: "Mug", maxRetries: 0 });
    expect(api.generations()[1].headers.get("Authorization")).toBe("Bearer new-key");
  });

  test("a key rotated during an upload doesn't change the running job's account", async () => {
    let releaseUpload!: () => void;
    const upload = new Promise<void>((resolve) => (releaseUpload = resolve));
    const api = fakeApi({
      statuses: ["complete"],
      gate: (c) => (c.method === "PUT" ? upload : undefined),
    });
    const model = createMagicHour({ fetch: api.fetch, pollIntervalMs: 0 }).video();
    vi.stubEnv("MAGIC_HOUR_API_KEY", "old-key");
    const job = generateVideo({ model, prompt: { image: png, text: "Animate" }, maxRetries: 0 });
    for (let i = 0; i < 1000 && !api.calls.some((c) => c.method === "PUT"); i++)
      await new Promise((resolve) => setImmediate(resolve));
    vi.stubEnv("MAGIC_HOUR_API_KEY", "new-key");
    releaseUpload();
    await job;
    for (const call of api.calls.filter((c) => new URL(c.url).origin === API))
      expect(call.headers.get("Authorization")).toBe("Bearer old-key");
    await generateVideo({ model, prompt: "Waves", maxRetries: 0 });
    expect(api.generations()[1].headers.get("Authorization")).toBe("Bearer new-key");
  });

  test("falls back to MAGIC_HOUR_API_KEY at call time", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const provider = createMagicHour({ fetch: api.fetch, pollIntervalMs: 0 });
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    await generateImage({ model: provider.image(), prompt: "Mug", maxRetries: 0 });
    expect(api.calls[0].headers.get("Authorization")).toBe("Bearer env-key");
  });

  test("an explicit key wins over the environment", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    const api = fakeApi({ statuses: ["complete"] });
    await generateImage({
      model: api.provider({ apiKey: "explicit-key" }).image(),
      prompt: "Mug",
      maxRetries: 0,
    });
    for (const call of api.generations())
      expect(call.headers.get("Authorization")).toBe("Bearer explicit-key");
  });

  test("an empty explicit key fails instead of using the environment's", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    const api = fakeApi();
    await expect(
      generateImage({ model: api.provider({ apiKey: "" }).image(), prompt: "Mug", maxRetries: 0 })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  test("the default provider uses the global fetch and the environment key", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    await generateImage({
      model: magichour.image(),
      prompt: "Mug",
      maxRetries: 0,
    });
    expect(api.generations()).toHaveLength(1);
    expect(api.generations()[0].headers.get("Authorization")).toBe("Bearer env-key");
  });

  test("the global fetch never replays a paid request after a dropped connection", async () => {
    const api = fakeApi({ createNetworkError: true });
    vi.stubGlobal("fetch", api.fetch);
    const error = await generateImage({
      model: createMagicHour({ apiKey: "test-key" }).image(),
      prompt: "Mug",
      maxRetries: 3,
    }).catch((e: unknown) => e);
    expect(api.generations()).toHaveLength(1);
    expect(error).toBeInstanceOf(MagicHourError);
    expect((error as MagicHourError).projectId).toBeUndefined();
    expect((error as Error).message).toMatch(/Acceptance is unknown/);
  });
});

describe("custom fetch", () => {
  test("every request goes through it", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const global = vi.fn();
    vi.stubGlobal("fetch", global);
    await generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 });
    expect(api.calls.length).toBeGreaterThan(2);
    expect(global).not.toHaveBeenCalled();
  });
});

describe("models", () => {
  test("identify the provider and model", () => {
    const provider = createMagicHour({ apiKey: "test-key" });
    expect(provider.image("flux-2-klein")).toMatchObject({
      specificationVersion: "v4",
      provider: "magichour.image",
      modelId: "flux-2-klein",
      maxImagesPerCall: 1,
    });
    expect(provider.imageModel("z-image-turbo").modelId).toBe("z-image-turbo");
    expect(provider.video("ltx-2.5")).toMatchObject({
      specificationVersion: "v4",
      provider: "magichour.video",
      modelId: "ltx-2.5",
      maxVideosPerCall: 1,
    });
    expect(provider.videoModel("wan-2.2").modelId).toBe("wan-2.2");
    expect(provider.image().modelId).toBe("default");
    expect(provider.video().modelId).toBe("default");
  });

  test("unknown models throw NoSuchModelError", () => {
    const provider = createMagicHour({ apiKey: "test-key" });
    for (const create of [
      () => provider.image("not-a-model" as any),
      () => provider.imageModel("not-a-model"),
      () => provider.video("not-a-model" as any),
      () => provider.languageModel("gpt"),
      () => provider.embeddingModel("embed"),
    ])
      expect(create).toThrow(NoSuchModelError);
  });

  test("a registry rejects language models", () => {
    const registry = createProviderRegistry({ magichour: createMagicHour({ apiKey: "test-key" }) });
    expect(() => registry.languageModel("magichour:gpt")).toThrow(NoSuchModelError);
    expect(() => registry.imageModel("magichour:nope")).toThrow(NoSuchModelError);
  });
});

describe("MagicHourError", () => {
  test("is exported and is what generation failures throw", async () => {
    const api = fakeApi({ statuses: ["error"] });
    const error = await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      maxRetries: 0,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MagicHourError);
    expect(error).toBeInstanceOf(Error);
    expect((error as MagicHourError).name).toBe("MagicHourError");
    expect((error as MagicHourError).isRetryable).toBe(false);
    expect((error as MagicHourError).projectId).toBe(api.projects()[0].id);
  });
});
