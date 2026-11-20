// The provider as the AI SDK and users see it: its models and the registry.
import { NoSuchModelError } from "@ai-sdk/provider";
import { createProviderRegistry, generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour } from "../src/index.js";
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
      () => provider.imageModel("not-a-model"),
      () => provider.video("not-a-model" as any),
      () => provider.languageModel("gpt"),
      () => provider.embeddingModel("embed"),
    ])
      expect(create).toThrow(NoSuchModelError);
  });

  test("generates images through a provider registry", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const registry = createProviderRegistry({ magichour: api.provider() });
    await generateImage({
      model: registry.imageModel("magichour:z-image-turbo"),
      prompt: "Mug",
      maxRetries: 0,
    });
    expect(api.generations()[0].body.model).toBe("z-image-turbo");
  });
});
