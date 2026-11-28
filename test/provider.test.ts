import { LoadAPIKeyError, NoSuchModelError } from "@ai-sdk/provider";
import { createProviderRegistry, generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour, MagicHourError, magichour } from "../src/index.js";
import { fakeApi } from "./setup/fake-api.js";

describe("provider", () => {
  // Importing the package creates a provider, so this must work before a key is configured.
  test("creating the provider and its models needs no API key", () => {
    vi.stubEnv("MAGIC_HOUR_API_KEY", undefined);
    const provider = createMagicHour();
    expect(() => provider.image()).not.toThrow();
    expect(() => provider.video()).not.toThrow();
  });

  // Image and video model IDs are checked by the API, which rejects unknown ones before charging.
  test("language and embedding models throw NoSuchModelError", () => {
    const provider = createMagicHour({ apiKey: "test-key" });
    for (const create of [
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
    await expect(generateImage({ model, prompt: "Mug", maxRetries: 0 })).rejects.toThrow(LoadAPIKeyError);
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

describe("estimate", () => {
  const params = { tool: "ai-image-generator" } as const;

  test("returns the estimate and sends only supported query fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({ estimated_credits: 12 })
    );
    const provider = createMagicHour({ apiKey: " test-key ", fetch });
    const request = { ...params, model: "nano-banana-2.1", image_count: 4, prompt: "Mug" };

    await expect(provider.estimate("image", request)).resolves.toEqual({ estimated_credits: 12 });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.magichour.ai/v1/estimate/image?tool=ai-image-generator&model=nano-banana-2.1&image_count=4",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer test-key", Accept: "application/json" },
        redirect: "error",
      })
    );
  });

  test("rejects an unsupported type before sending a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createMagicHour({ apiKey: "test-key", fetch });
    // @ts-expect-error JavaScript callers can pass unsupported types at runtime.
    await expect(provider.estimate("video", params)).rejects.toThrow("Unsupported estimate type: video");
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    {
      response: Response.json({ message: "Invalid model", code: "invalid_model" }, { status: 400 }),
      error: { message: "Invalid model", status: 400, code: "invalid_model" },
    },
    {
      response: new Response("Bad Gateway", { status: 502 }),
      error: { message: "Magic Hour image estimate failed (HTTP 502).", status: 502 },
    },
  ])("reports an HTTP $error.status error", async ({ response, error }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
    const provider = createMagicHour({ apiKey: "test-key", fetch });
    await expect(provider.estimate("image", params)).rejects.toMatchObject(error);
  });

  test("wraps a network failure in MagicHourError", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError("fetch failed"));
    const provider = createMagicHour({ apiKey: "test-key", fetch });
    await expect(provider.estimate("image", params)).rejects.toThrow(MagicHourError);
  });

  test("an already-aborted estimate sends no request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = createMagicHour({ apiKey: "test-key", fetch });
    const abortSignal = AbortSignal.abort();
    await expect(provider.estimate("image", params, { abortSignal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
