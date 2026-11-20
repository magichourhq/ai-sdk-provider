// Invalid input must fail before any request, so it never uploads anything or starts a paid job.
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { fakeApi, jpeg, png } from "./fake-api.js";
import { rejection, runImage, videoCall } from "./helpers.js";

describe("image options", () => {
  test.each<[string, Record<string, unknown>]>([
    ["a blank prompt", { prompt: "   " }],
    ["a seed", { seed: 1 }],
    ["a size that isn't a 640, 1024 or 2048 tier", { size: "500x500" }],
    ["a size with an unsupported aspect ratio", { size: "1024x768" }],
    ["a size with trailing text", { size: "1024x1024xjunk" }],
    ["an unsupported aspect ratio", { aspectRatio: "4:3" }],
    ["a size and aspect ratio that disagree", { size: "1024x1024", aspectRatio: "16:9" }],
    ["an unsupported resolution option", { providerOptions: { magichour: { resolution: "4k" } } }],
    [
      "both a size and a resolution option",
      { size: "1024x1024", providerOptions: { magichour: { resolution: "1k" } } },
    ],
    ["an unknown provider option", { providerOptions: { magichour: { image_count: 4 } } }],
  ])("reject %s", async (_, options) => {
    const api = fakeApi();
    await expect(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0, ...options })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  test.each<[string, object]>([
    ["input images", { images: [png] }],
    ["a mask", { images: [], mask: png }],
  ])("reject image editing: %s", async (_, edit) => {
    const api = fakeApi();
    await expect(
      generateImage({
        model: api.provider().image(),
        prompt: { text: "Make it blue", ...edit } as any,
        maxRetries: 0,
      })
    ).rejects.toThrow(/not image editing/);
    expect(api.calls).toHaveLength(0);
  });

  // The AI SDK splits larger requests into single-image calls, so this only happens directly.
  test("reject more than one image per call", async () => {
    const api = fakeApi();
    await expect(
      api.provider().image().doGenerate({
        prompt: "Mug",
        n: 2,
        size: undefined,
        aspectRatio: undefined,
        seed: undefined,
        files: undefined,
        mask: undefined,
        providerOptions: {},
      })
    ).rejects.toThrow(/One image per request/);
    expect(api.calls).toHaveLength(0);
  });
});

describe("video options", () => {
  test.each<[string, Record<string, unknown>]>([
    ["a missing prompt and image", { prompt: "   " }],
    ["a seed", { seed: 1 }],
    ["an fps", { fps: 30 }],
    ["a duration under 1 second", { duration: 0 }],
    ["a duration over 60 seconds", { duration: 61 }],
    ["a non-numeric duration", { duration: Number.NaN }],
    ["a 16:9 resolution that isn't a tier", { resolution: "1600x900" }],
    ["a resolution with an unsupported aspect ratio", { resolution: "1440x1080" }],
    [
      "an unsupported resolution option",
      { providerOptions: { magichour: { resolution: "999p" } } },
    ],
    [
      "both a resolution and a resolution option",
      { resolution: "1280x720", providerOptions: { magichour: { resolution: "720p" } } },
    ],
    ["an unknown provider option", { providerOptions: { magichour: { model: "x" } } }],
    ["an unsupported aspect ratio", { aspectRatio: "4:3" }],
    [
      "a resolution and aspect ratio that disagree",
      { resolution: "1280x720", aspectRatio: "9:16" },
    ],
    ["adaptive without an input image", { aspectRatio: "adaptive" }],
    [
      "an aspect ratio with an input image",
      { prompt: { image: "https://example.com/i.png", text: "x" }, aspectRatio: "16:9" },
    ],
    ["a plain-HTTP image URL", { prompt: { image: "http://example.com/i.png", text: "x" } }],
  ])("reject %s", async (_, options) => {
    const api = fakeApi();
    await expect(
      generateVideo({ model: api.provider().video(), prompt: "Waves", maxRetries: 0, ...options })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  // Duration is the last option checked, so this fails if any check moves after the upload.
  test("reject invalid options before uploading a binary input image", async () => {
    const api = fakeApi();
    await expect(
      generateVideo({
        model: api.provider().video(),
        prompt: { image: png, text: "Animate" },
        duration: 61,
        maxRetries: 0,
      })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  test.each<[string, Record<string, unknown>]>([
    ["more than one video", { n: 2 }],
    ["an unsupported image type", { image: { type: "file", mediaType: "image/gif", data: png } }],
    ["frame images", { frameImages: [{ type: "file", mediaType: "image/png", data: png }] }],
    [
      "reference inputs",
      { inputReferences: [{ type: "file", mediaType: "image/png", data: png }] },
    ],
  ])("reject %s when called directly", async (_, overrides) => {
    const api = fakeApi();
    await expect(api.provider().video().doGenerate!(videoCall(overrides))).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});

// A paid job must never run on data that isn't the image it claims to be.
describe("input image data", () => {
  test.each<[string, string, Uint8Array | string]>([
    ["PNG bytes declared as JPEG", "image/jpeg", png],
    ["JPEG bytes declared as PNG", "image/png", jpeg],
    ["JPEG bytes declared as WebP", "image/webp", jpeg],
    [
      "a WAVE file declared as WebP",
      "image/webp",
      new Uint8Array([...Buffer.from("RIFF"), 36, 0, 0, 0, ...Buffer.from("WAVEfmt ")]),
    ],
    // Both start with a valid PNG header, so a lenient decoder would let them through.
    ["base64 with invalid characters", "image/png", "iVBORw0KGgo!!"],
    ["base64 missing a character", "image/png", "iVBORw0KGgoAA"],
  ])("reject %s", async (_, mediaType, data) => {
    const api = fakeApi();
    await expect(
      api.provider().video().doGenerate!(videoCall({ image: { type: "file", mediaType, data } }))
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  test("reject a data URL whose bytes aren't the declared image type", async () => {
    const api = fakeApi();
    await expect(
      generateVideo({
        model: api.provider().video(),
        prompt: { image: "data:image/png;base64,SGVsbG8=", text: "Animate" },
        maxRetries: 0,
      })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});

describe("provider settings", () => {
  // Timers treat NaN and Infinity as about 1 ms, which would give up on a job as it starts.
  test("reject invalid timing settings", async () => {
    for (const settings of [
      { pollIntervalMs: -1 },
      { pollIntervalMs: NaN },
      { timeoutMs: 0 },
      { timeoutMs: NaN },
      { timeoutMs: Infinity },
    ]) {
      const api = fakeApi();
      await rejection(runImage(api, { settings }));
      expect(api.calls).toHaveLength(0);
    }
  });
});
