import { NoSuchModelError } from "@ai-sdk/provider";
import { createProviderRegistry, generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour, magichour } from "../src/index.js";
import { fakeApi } from "./fake-api.js";

describe("provider", () => {
  // Importing the package creates a provider, so this must work before a key is configured.
  test("creating the provider and its models needs no API key", () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", undefined);
    const provider = createMagicHour();
    expect(() => provider.image()).not.toThrow();
    expect(() => provider.video()).not.toThrow();
  });

  test("unknown models throw NoSuchModelError", () => {
    const provider = createMagicHour({ apiKey: "test-key" });
    for (const create of [
      () => provider.image("not-a-model" as any),
      () => provider.video("not-a-model" as any),
      () => provider.languageModel("gpt"),
      () => provider.embeddingModel("embed"),
    ])
      expect(create).toThrow(NoSuchModelError);
  });

  test("generates images through a provider registry", async () => {
    const api = fakeApi();
    const registry = createProviderRegistry({ magichour: api.provider() });
    await generateImage({
      model: registry.imageModel("magichour:z-image-turbo"),
      prompt: "Mug",
      maxRetries: 0,
    });
    expect(api.generations()[0].body.model).toBe("z-image-turbo");
  });
});

describe("API key", () => {
  test("a missing key fails before any request", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", undefined);
    const api = fakeApi();
    const model = createMagicHour({ fetch: api.fetch }).image();
    await expect(generateImage({ model, prompt: "Mug", maxRetries: 0 })).rejects.toThrow(/API key/);
    expect(api.calls).toHaveLength(0);
  });

  // Apps often load their environment after importing the provider.
  test("the default export reads MAGIC_HOUR_API_KEY when a call starts", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    await generateImage({ model: magichour.image(), prompt: "Mug", maxRetries: 0 });
    expect(api.generations()[0].headers.get("Authorization")).toBe("Bearer env-key");
  });

  test("an explicit key wins over the environment", async () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", "env-key");
    const api = fakeApi();
    const model = api.provider({ apiKey: "explicit-key" }).image();
    await generateImage({ model, prompt: "Mug", maxRetries: 0 });
    expect(api.generations()[0].headers.get("Authorization")).toBe("Bearer explicit-key");
  });
});
