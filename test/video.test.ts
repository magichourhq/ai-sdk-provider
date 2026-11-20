import { experimental_generateVideo as generateVideo } from "ai";
import { describe, expect, test } from "vitest";
import { API, fakeApi, gif, jpeg, png, webp } from "./fake-api.js";

/** Call options for the model itself, for inputs `generateVideo` can't produce. */
function directCall(overrides: Record<string, unknown>): any {
  return {
    prompt: "Animate",
    n: 1,
    image: undefined,
    aspectRatio: undefined,
    resolution: undefined,
    duration: undefined,
    fps: undefined,
    seed: undefined,
    providerOptions: {},
    ...overrides,
  };
}

describe("text-to-video", () => {
  test("sends the default request and returns the project's output, ID and charge", async () => {
    const api = fakeApi();
    const result = await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      maxRetries: 0,
    });
    const [project] = api.projects;
    expect(api.generations().map((c) => c.url)).toEqual([`${API}/v1/text-to-video`]);
    expect(api.generations()[0].body).toEqual({
      model: "default",
      end_seconds: 5,
      resolution: "480p",
      style: { prompt: "Waves" },
      aspect_ratio: "16:9",
    });
    // Polled until the project completes, then downloaded once from its signed URL.
    expect(api.polls().map((c) => c.url)).toEqual(
      Array(3).fill(`${API}/v1/video-projects/${project.id}`)
    );
    expect(api.storage().map((c) => c.url)).toEqual([project.url]);
    expect(result.video.uint8Array).toEqual(project.bytes);
    expect(result.video.mediaType).toBe("video/mp4");
    expect(result.providerMetadata.magichour).toMatchObject({
      projectId: project.id,
      creditsCharged: 5,
    });
  });

  test("sends the chosen model, duration, aspect ratio, resolution option and audio setting", async () => {
    const api = fakeApi();
    await generateVideo({
      model: api.provider().video("wan-2.2"),
      prompt: "Waves",
      duration: 10,
      aspectRatio: "9:16",
      providerOptions: { magichour: { resolution: "720p" } },
      // `false` must be sent too, or the API falls back to its own default.
      generateAudio: false,
      maxRetries: 0,
    });
    expect(api.generations()[0].body).toEqual({
      model: "wan-2.2",
      end_seconds: 10,
      resolution: "720p",
      audio: false,
      style: { prompt: "Waves" },
      aspect_ratio: "9:16",
    });
  });

  // Video tiers go by the short edge. 854x480 is only roughly 16:9.
  test.each([
    ["640x360", "360p", "16:9"],
    ["854x480", "480p", "16:9"],
    ["720x1280", "720p", "9:16"],
    ["1080x1080", "1080p", "1:1"],
    ["3840x2160", "4k", "16:9"],
  ] as const)("maps resolution %s to %s and %s", async (resolution, tier, ratio) => {
    const api = fakeApi();
    await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      resolution,
      maxRetries: 0,
    });
    expect(api.generations()[0].body).toMatchObject({ resolution: tier, aspect_ratio: ratio });
  });
});

describe("image-to-video", () => {
  test("uploads the image to its signed URL, then sends the uploaded file path", async () => {
    const api = fakeApi();
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: png, text: "Animate" },
      maxRetries: 0,
    });
    const [upload] = api.uploads;
    expect(api.calls[0].url).toBe(`${API}/v1/files/upload-urls`);
    expect(api.calls[0].body).toEqual({ items: [{ type: "image", extension: "png" }] });
    expect(api.calls[1]).toMatchObject({ method: "PUT", url: upload.url, body: png });
    expect(api.generations().map((c) => c.url)).toEqual([`${API}/v1/image-to-video`]);
    // No aspect ratio, so the video keeps the image's shape.
    expect(api.generations()[0].body).toEqual({
      model: "default",
      end_seconds: 5,
      resolution: "480p",
      style: { prompt: "Animate" },
      assets: { image_file_path: upload.filePath },
    });
  });

  test.each([
    ["JPEG", "jpg", jpeg],
    ["WebP", "webp", webp],
  ])("uploads a %s image with the %s extension", async (_, extension, image) => {
    const api = fakeApi();
    await generateVideo({
      model: api.provider().video(),
      prompt: { image, text: "Animate" },
      maxRetries: 0,
    });
    expect(api.calls[0].body).toEqual({ items: [{ type: "image", extension }] });
    expect(api.uploads[0].bytes).toEqual(image);
  });

  // The AI SDK decodes base64 itself, but the model interface also allows it.
  test("uploads the decoded bytes of base64 image data", async () => {
    const api = fakeApi();
    const data = Buffer.from(png).toString("base64");
    await api.provider().video().doGenerate!(
      directCall({ image: { type: "file", mediaType: "image/png", data } })
    );
    expect(api.uploads[0].bytes).toEqual(png);
  });

  test("sends an HTTPS image URL as given, without uploading it", async () => {
    const api = fakeApi();
    const url = "https://cdn.example.com/in%20put.png?X-Amz-Signature=a%2Fb";
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: url, text: "Animate" },
      maxRetries: 0,
    });
    expect(api.uploads).toHaveLength(0);
    expect(api.generations()[0].body.assets).toEqual({ image_file_path: url });
  });

  test("sends no prompt for an image without text", async () => {
    const api = fakeApi();
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: "https://example.com/image.png" },
      maxRetries: 0,
    });
    expect(api.generations()[0].body).not.toHaveProperty("style");
  });
});

// Invalid input fails before any request, so it never uploads anything or starts a paid job.
describe("rejected video input", () => {
  test.each<[string, Record<string, unknown>]>([
    ["a missing prompt and image", { prompt: "   " }],
    ["a seed", { seed: 1 }],
    ["a duration over 60 seconds", { duration: 61 }],
    ["a resolution that isn't a tier", { resolution: "1600x900" }],
    [
      "an unsupported resolution option",
      { providerOptions: { magichour: { resolution: "999p" } } },
    ],
    [
      "both a resolution and a resolution option",
      { resolution: "1280x720", providerOptions: { magichour: { resolution: "720p" } } },
    ],
    [
      "a resolution and aspect ratio that disagree",
      { resolution: "1280x720", aspectRatio: "9:16" },
    ],
    ["adaptive without an input image", { aspectRatio: "adaptive" }],
    [
      "an aspect ratio with an input image",
      { prompt: { image: "https://example.com/i.png", text: "x" }, aspectRatio: "16:9" },
    ],
    ["frame images", { frameImages: [{ image: png, frameType: "last_frame" }] }],
    ["a GIF input image", { prompt: { image: gif, text: "x" } }],
    // A paid job must never run on data that isn't an image.
    [
      "input image data that isn't an image",
      { prompt: { image: Buffer.from("Hello"), text: "x" } },
    ],
  ])("rejects %s", async (_, options) => {
    const api = fakeApi();
    await expect(
      generateVideo({ model: api.provider().video(), prompt: "Waves", maxRetries: 0, ...options })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  test.each<[string, Record<string, unknown>]>([
    // The AI SDK splits larger requests into single-video calls.
    ["more than one video per call", { n: 2 }],
    // It starts with a valid PNG header, so a lenient decoder would upload it.
    [
      "base64 image data with invalid characters",
      { image: { type: "file", mediaType: "image/png", data: "iVBORw0KGgo!!" } },
    ],
  ])("rejects %s when called directly", async (_, overrides) => {
    const api = fakeApi();
    await expect(api.provider().video().doGenerate!(directCall(overrides))).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});
