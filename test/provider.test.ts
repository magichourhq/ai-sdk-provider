// The provider as the AI SDK and users see it: models, the registry, defaults and settings.
import { NoSuchModelError } from "@ai-sdk/provider";
import { createProviderRegistry, generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour, magichour } from "../src/index.js";
import { fakeApi } from "./fake-api.js";

describe("provider", () => {
  test("creating the provider and its models needs no API key", () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", undefined);
    const provider = createMagicHour();
    expect(() => provider.image()).not.toThrow();
    expect(() => provider.video()).not.toThrow();
    expect(magichour.image("flux-2-klein").modelId).toBe("flux-2-klein");
  });

  test("models identify the provider and model", () => {
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

  test("a custom fetch carries every request", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const global = vi.fn();
    vi.stubGlobal("fetch", global);
    await generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 });
    expect(api.calls.length).toBeGreaterThan(2);
    expect(global).not.toHaveBeenCalled();
  });
});

describe("provider registry", () => {
  test("generates images by registry model ID", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const registry = createProviderRegistry({ magichour: api.provider() });
    await generateImage({
      model: registry.imageModel("magichour:z-image-turbo"),
      prompt: "Mug",
      maxRetries: 0,
    });
    expect(api.generations()[0].body.model).toBe("z-image-turbo");
  });

  test("rejects language models and unknown image models", () => {
    const registry = createProviderRegistry({ magichour: createMagicHour({ apiKey: "test-key" }) });
    expect(() => registry.languageModel("magichour:gpt")).toThrow(NoSuchModelError);
    expect(() => registry.imageModel("magichour:nope")).toThrow(NoSuchModelError);
  });
});
