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

  test.each(["flux-2-klein", "z-image-turbo", "qwen-image-2.1"] as const)(
    "send the %s model",
    async (modelId) => {
      const api = fakeApi({ statuses: ["complete"] });
      await generateImage({ model: api.provider().image(modelId), prompt: "Mug", maxRetries: 0 });
      expect(api.generations()[0].body.model).toBe(modelId);
    }
  );

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

  test.each(["1:1", "16:9", "9:16"] as const)("send aspect ratio %s", async (aspectRatio) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      aspectRatio,
      maxRetries: 0,
    });
    expect(api.generations()[0].body).toMatchObject({
      aspect_ratio: aspectRatio,
      resolution: "640px",
    });
  });

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

  test.each(["640px", "1k", "2k"])(
    "send the %s resolution option and ignore other providers' options",
    async (resolution) => {
      const api = fakeApi({ statuses: ["complete"] });
      await generateImage({
        model: api.provider().image(),
        prompt: "Mug",
        providerOptions: { openai: { quality: "hd" }, magichour: { resolution } },
        maxRetries: 0,
      });
      expect(api.generations()[0].body.resolution).toBe(resolution);
    }
  );

  test("send the prompt unchanged", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const prompt = '  A "quoted" prompt\nwith a newline and émoji 🎨  ';
    await generateImage({ model: api.provider().image(), prompt, maxRetries: 0 });
    expect(api.generations()[0].body.style.prompt).toBe(prompt);
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

  test.each(["ltx-2.5", "minimax-h3", "wan-2.2"] as const)("send the %s model", async (modelId) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({ model: api.provider().video(modelId), prompt: "Waves", maxRetries: 0 });
    expect(api.generations()[0].body.model).toBe(modelId);
  });

  // Video tiers go by the short edge.
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

  test.each(["360p", "480p", "720p", "1080p", "4k"])(
    "send the %s resolution option",
    async (resolution) => {
      const api = fakeApi({ statuses: ["complete"] });
      await generateVideo({
        model: api.provider().video(),
        prompt: "Waves",
        providerOptions: { magichour: { resolution } },
        maxRetries: 0,
      });
      expect(api.generations()[0].body.resolution).toBe(resolution);
    }
  );

  test.each(["1:1", "16:9", "9:16"] as const)("send aspect ratio %s", async (aspectRatio) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      aspectRatio,
      maxRetries: 0,
    });
    expect(api.generations()[0].body.aspect_ratio).toBe(aspectRatio);
  });

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
    ["image/png", "png", png],
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
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: Buffer.from(png).toString("base64"), text: "Animate" },
      maxRetries: 0,
    });
    expect(api.uploads()[0].bytes).toEqual(png);
    expect(api.generations()[0].body.assets.image_file_path).toBe("api-assets/test/input-1.png");
  });

  test("upload base64 image data passed to the model directly", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const data = Buffer.from(png).toString("base64");
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType: "image/png", data } })
    );
    expect(api.uploads()[0].bytes).toEqual(png);
  });

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

  test.each([
    ["a URL", "https://example.com/image.png"],
    ["binary data", png],
  ])("send no prompt for an image without text: %s", async (_, image) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({ model: api.provider().video(), prompt: { image }, maxRetries: 0 });
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
  test.each([
    ["text-to-video", true, "Waves"],
    ["text-to-video", false, "Waves"],
    ["image-to-video", true, { image: png, text: "Animate" }],
    ["image-to-video", false, { image: png, text: "Animate" }],
  ] as const)("%s sends audio: %s from generateAudio", async (_, generateAudio, prompt) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({ model: api.provider().video(), prompt, generateAudio, maxRetries: 0 });
    expect(api.generations()[0].body.audio).toBe(generateAudio);
  });
});
