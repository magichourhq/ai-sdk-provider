// What each call sends to the API: the endpoint and the exact request body.
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { API, fakeApi, jpeg, png, STORAGE, webp } from "./fake-api.js";
import { isUpload, videoCall } from "./helpers.js";

describe("image requests", () => {
  test("default to the default model, one 640px image and no aspect ratio", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateImage({ model: api.provider().image(), prompt: "A mug", maxRetries: 0 });
    expect(api.generations()).toHaveLength(1);
    expect(api.generations()[0].url).toBe(`${API}/v1/ai-image-generator`);
    expect(api.generations()[0].headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(api.generations()[0].body).toEqual({
      model: "default",
      image_count: 1,
      resolution: "640px",
      style: { prompt: "A mug" },
    });
  });

  test("send the chosen model, aspect ratio and resolution option", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateImage({
      model: api.provider().image("flux-2-klein"),
      prompt: "Mug",
      aspectRatio: "9:16",
      // Options meant for other providers are ignored.
      providerOptions: { openai: { quality: "hd" }, magichour: { resolution: "2k" } },
      maxRetries: 0,
    });
    expect(api.generations()[0].body).toEqual({
      model: "flux-2-klein",
      image_count: 1,
      resolution: "2k",
      aspect_ratio: "9:16",
      style: { prompt: "Mug" },
    });
  });

  // Magic Hour sizes images by longest edge, so the size picks a tier and an aspect ratio.
  test.each([
    ["640x640", "640px", "1:1"],
    ["1024x576", "1k", "16:9"],
    ["1152x2048", "2k", "9:16"],
  ] as const)(
    "map size %s to resolution %s and aspect ratio %s",
    async (size, resolution, ratio) => {
      const api = fakeApi({ statuses: ["complete"] });
      await generateImage({ model: api.provider().image(), prompt: "Mug", size, maxRetries: 0 });
      expect(api.generations()[0].body).toMatchObject({ resolution, aspect_ratio: ratio });
    }
  );

  test("accept a size and aspect ratio that agree", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      size: "2048x1152",
      aspectRatio: "16:9",
      maxRetries: 0,
    });
    expect(api.generations()[0].body).toMatchObject({ resolution: "2k", aspect_ratio: "16:9" });
  });
});

describe("text-to-video requests", () => {
  test("default to the default model, 5 seconds, 480p and 16:9", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({ model: api.provider().video(), prompt: "Waves", maxRetries: 0 });
    expect(api.generations()).toHaveLength(1);
    expect(api.generations()[0].url).toBe(`${API}/v1/text-to-video`);
    expect(api.generations()[0].body).toEqual({
      model: "default",
      end_seconds: 5,
      resolution: "480p",
      style: { prompt: "Waves" },
      aspect_ratio: "16:9",
    });
  });

  test("send the chosen model, duration, aspect ratio and resolution option", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video("wan-2.2"),
      prompt: "Waves",
      duration: 10,
      aspectRatio: "9:16",
      providerOptions: { magichour: { resolution: "720p" } },
      maxRetries: 0,
    });
    expect(api.generations()[0].body).toEqual({
      model: "wan-2.2",
      end_seconds: 10,
      resolution: "720p",
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
  ] as const)("map resolution %s to %s and %s", async (resolution, tier, ratio) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      resolution,
      maxRetries: 0,
    });
    expect(api.generations()[0].body).toMatchObject({ resolution: tier, aspect_ratio: ratio });
  });

  // The shortest and longest durations allowed.
  test.each([1, 60])("send a %i second duration", async (duration) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      duration,
      maxRetries: 0,
    });
    expect(api.generations()[0].body.end_seconds).toBe(duration);
  });
});

describe("image-to-video requests", () => {
  test("upload the image to its signed URL, then send the uploaded file path", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video("ltx-2.5"),
      prompt: { image: png, text: "Animate" },
      duration: 1,
      maxRetries: 0,
    });
    expect(api.calls[0].method).toBe("POST");
    expect(api.calls[0].url).toBe(`${API}/v1/files/upload-urls`);
    expect(api.calls[0].body).toEqual({ items: [{ type: "image", extension: "png" }] });
    const uploads = api.storage().filter(isUpload);
    expect(uploads.map((c) => c.url)).toEqual([
      `${STORAGE}/uploads/input-1.png?X-Goog-Signature=sig%2Bup%2F1%26y%3D`,
    ]);
    expect(uploads[0].headers.get("Content-Type") ?? "").not.toMatch(/json/);
    expect(uploads[0].body).toEqual(png);
    expect(api.generations()[0].url).toBe(`${API}/v1/image-to-video`);
    expect(api.generations()[0].body).toEqual({
      model: "ltx-2.5",
      end_seconds: 1,
      resolution: "480p",
      style: { prompt: "Animate" },
      assets: { image_file_path: "api-assets/test/input-1.png" },
    });
  });

  test.each([
    ["image/jpeg", "jpg", jpeg],
    ["image/webp", "webp", webp],
  ])("upload %s with the %s extension", async (mediaType, extension, data) => {
    const api = fakeApi({ statuses: ["complete"] });
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType, data } })
    );
    expect(api.calls[0].body).toEqual({ items: [{ type: "image", extension }] });
    expect(api.uploads()[0].bytes).toEqual(data);
  });

  test("upload the decoded bytes of a base64 image", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const data = Buffer.from(png).toString("base64");
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType: "image/png", data } })
    );
    expect(api.uploads()[0].bytes).toEqual(png);
  });

  // A small Buffer is usually a view into a larger shared one.
  test("upload only the bytes of a view, not the rest of its buffer", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const padded = new Uint8Array([...Buffer.from("BEFORE"), ...png, ...Buffer.from("AFTER")]);
    const view = padded.subarray(6, 6 + png.length);
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType: "image/png", data: view } })
    );
    expect(api.uploads()[0].bytes).toEqual(png);
  });

  test("send an HTTPS image URL exactly as given, without fetching or uploading it", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const url =
      "https://cdn.example.com/in%20put.png?X-Amz-Signature=a%2Fb%2Bc%26d&X-Amz-Expires=60";
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: url, text: "Animate" },
      maxRetries: 0,
    });
    expect(api.offOrigin()).toEqual(api.storage().filter((c) => c.method === "GET"));
    expect(api.uploadUrlRequests()).toHaveLength(0);
    expect(api.generations()[0].body.assets).toEqual({ image_file_path: url });
  });

  test("send no prompt for an image without text", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: "https://example.com/image.png" },
      maxRetries: 0,
    });
    expect(api.generations()[0].url).toBe(`${API}/v1/image-to-video`);
    expect(api.generations()[0].body).not.toHaveProperty("style");
  });

  test("send no aspect ratio, so the video keeps the image's shape", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: "https://example.com/image.png", text: "Animate" },
      aspectRatio: "adaptive" as any,
      resolution: "1920x1080",
      maxRetries: 0,
    });
    expect(api.generations()[0].body.resolution).toBe("1080p");
    expect(api.generations()[0].body).not.toHaveProperty("aspect_ratio");
  });
});

describe("video audio", () => {
  // `false` must be sent too, or the API falls back to its own default.
  test.each([
    ["text-to-video", false, "Waves"],
    ["image-to-video", true, { image: png, text: "Animate" }],
  ] as const)("%s sends audio: %s from generateAudio", async (_, generateAudio, prompt) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({ model: api.provider().video(), prompt, generateAudio, maxRetries: 0 });
    expect(api.generations()[0].body.audio).toBe(generateAudio);
  });
});
