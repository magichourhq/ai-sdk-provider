import { experimental_generateVideo as generateVideo } from "ai";
import { describe, expect, test } from "vitest";
import { API, fakeApi, png, UPLOAD_URL } from "./fake-api.js";

const base64Png = Buffer.from(png).toString("base64");

/** Video call options the AI SDK would pass, for calling doGenerate directly. */
function videoCall(overrides: Record<string, unknown> = {}): any {
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

describe("text-to-video request", () => {
  test("defaults to the default model, 5 seconds, 480p and 16:9", async () => {
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

  test.each(["default", "ltx-2.5", "minimax-h3", "wan-2.2"] as const)(
    "sends the %s model",
    async (modelId) => {
      const api = fakeApi({ statuses: ["complete"] });
      await generateVideo({ model: api.provider().video(modelId), prompt: "Waves", maxRetries: 0 });
      expect(api.generations()[0].body.model).toBe(modelId);
    }
  );

  test.each([
    ["640x360", "360p", "16:9"],
    ["854x480", "480p", "16:9"],
    ["1280x720", "720p", "16:9"],
    ["1920x1080", "1080p", "16:9"],
    ["3840x2160", "4k", "16:9"],
    ["720x1280", "720p", "9:16"],
    ["1080x1080", "1080p", "1:1"],
  ] as const)("maps resolution %s to %s and %s", async (resolution, tier, ratio) => {
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
    "sends the %s resolution from provider options",
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

  test.each(["1:1", "16:9", "9:16"] as const)("sends aspect ratio %s", async (aspectRatio) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      aspectRatio,
      maxRetries: 0,
    });
    expect(api.generations()[0].body.aspect_ratio).toBe(aspectRatio);
  });

  test.each([1, 5, 60])("sends a %i second duration", async (duration) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      duration,
      maxRetries: 0,
    });
    expect(api.generations()[0].body.end_seconds).toBe(duration);
  });

  test.each([true, false])("sends audio: %s when generateAudio is set", async (generateAudio) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      generateAudio,
      maxRetries: 0,
    });
    expect(api.generations()[0].body.audio).toBe(generateAudio);
  });
});

describe("image-to-video request", () => {
  test("uploads binary image bytes to the signed URL, then sends the asset path", async () => {
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
    const uploads = api.storage().filter((c) => c.method === "PUT");
    expect(uploads.map((c) => c.url)).toEqual([UPLOAD_URL]);
    expect(uploads[0].body).toEqual(png);
    expect(api.generations()[0].url).toBe(`${API}/v1/image-to-video`);
    expect(api.generations()[0].body).toEqual({
      model: "ltx-2.5",
      end_seconds: 1,
      resolution: "480p",
      style: { prompt: "Animate" },
      assets: { image_file_path: "api-assets/test/input.png" },
    });
  });

  test("uploads a base64 image string", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: base64Png, text: "Animate" },
      maxRetries: 0,
    });
    expect(api.storage().find((c) => c.method === "PUT")!.body).toEqual(png);
    expect(api.generations()[0].body.assets.image_file_path).toBe("api-assets/test/input.png");
  });

  test("uploads base64 image data passed to the model directly", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType: "image/png", data: base64Png } })
    );
    expect(api.storage().find((c) => c.method === "PUT")!.body).toEqual(png);
  });

  test.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
  ])("asks for a %s upload URL with the %s extension", async (mediaType, extension) => {
    const api = fakeApi({ statuses: ["complete"] });
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType, data: png } })
    );
    expect(api.calls[0].body).toEqual({ items: [{ type: "image", extension }] });
  });

  test("sends an HTTPS image URL directly, without downloading or uploading it", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: "https://example.com/image.png", text: "Animate" },
      maxRetries: 0,
    });
    expect(api.offOrigin()).toEqual(api.storage().filter((c) => c.method === "GET"));
    expect(api.calls.some((c) => c.url.includes("upload"))).toBe(false);
    expect(api.generations()[0].body.assets).toEqual({
      image_file_path: "https://example.com/image.png",
    });
  });

  test("an image without text sends no prompt", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: "https://example.com/image.png" },
      maxRetries: 0,
    });
    expect(api.generations()[0].body).not.toHaveProperty("style");
  });

  test("adaptive aspect ratio keeps the input image's shape", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: "https://example.com/image.png", text: "Animate" },
      aspectRatio: "adaptive" as any,
      maxRetries: 0,
    });
    expect(api.generations()[0].body).not.toHaveProperty("aspect_ratio");
  });

  test("a resolution sets only the tier for image-to-video", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: "https://example.com/image.png", text: "Animate" },
      resolution: "1920x1080",
      maxRetries: 0,
    });
    expect(api.generations()[0].body.resolution).toBe("1080p");
    expect(api.generations()[0].body).not.toHaveProperty("aspect_ratio");
  });
});

describe("a failed upload never starts a paid job", () => {
  test.each([403, 500])("an upload PUT that returns HTTP %i", async (uploadStatus) => {
    const api = fakeApi({ uploadStatus });
    await expect(
      generateVideo({
        model: api.provider().video(),
        prompt: { image: png, text: "Animate" },
        maxRetries: 3,
      })
    ).rejects.toThrow();
    expect(api.storage().filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(api.generations()).toHaveLength(0);
  });

  test.each([
    ["no items", { items: [] }],
    ["no file path", { items: [{ upload_url: UPLOAD_URL, expires_at: "2099-01-01T00:00:00Z" }] }],
    ["no upload URL", { items: [{ file_path: "api-assets/x.png", expires_at: "2099-01-01" }] }],
    [
      "a plain-HTTP upload URL",
      {
        items: [
          {
            upload_url: UPLOAD_URL.replace("https:", "http:"),
            file_path: "api-assets/x.png",
            expires_at: "2099-01-01T00:00:00Z",
          },
        ],
      },
    ],
  ])("an upload-URL response with %s", async (_, uploadUrlsBody) => {
    const api = fakeApi({ uploadUrlsBody });
    await expect(
      generateVideo({
        model: api.provider().video(),
        prompt: { image: png, text: "Animate" },
        maxRetries: 0,
      })
    ).rejects.toThrow();
    expect(api.storage()).toHaveLength(0);
    expect(api.generations()).toHaveLength(0);
  });
});

describe("video validation happens before any request", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a missing prompt and image", { prompt: "   " }],
    ["a seed", { seed: 1 }],
    ["an fps", { fps: 30 }],
    ["a duration under 1 second", { duration: 0 }],
    ["a duration over 60 seconds", { duration: 61 }],
    ["a non-numeric duration", { duration: Number.NaN }],
    ["an unsupported resolution", { resolution: "1000x500" }],
    ["a 16:9 resolution that isn't a tier", { resolution: "1600x900" }],
    ["a resolution with trailing text", { resolution: "1280x720xjunk" }],
    ["a resolution with an unsupported aspect ratio", { resolution: "1440x1080" }],
    [
      "an unsupported resolution option",
      { providerOptions: { magichour: { resolution: "999p" } } },
    ],
    [
      "both resolution and a resolution option",
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
  ];
  test.each(cases)("rejects %s", async (_, options) => {
    const api = fakeApi();
    await expect(
      generateVideo({ model: api.provider().video(), prompt: "Waves", maxRetries: 0, ...options })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  // With binary input, a rewrite could upload first and validate later. That upload is wasted
  // work, and an upload followed by an invalid paid request is worse.
  // Cases about the prompt or adaptive ratio don't apply once an input image is given.
  test.each(cases.filter(([name]) => !/image|missing prompt|adaptive/.test(name)))(
    "rejects %s with a binary input image before uploading",
    async (_, options) => {
      const api = fakeApi();
      await expect(
        generateVideo({
          model: api.provider().video(),
          maxRetries: 0,
          ...options,
          prompt: { image: png, text: "Animate" },
        })
      ).rejects.toThrow();
      expect(api.calls).toHaveLength(0);
    }
  );

  test.each([
    ["an unsupported image type", { image: { type: "file", mediaType: "image/gif", data: png } }],
    ["frame images", { frameImages: [{ type: "file", mediaType: "image/png", data: png }] }],
    [
      "reference inputs",
      { inputReferences: [{ type: "file", mediaType: "image/png", data: png }] },
    ],
    ["more than one video", { n: 2 }],
  ])("rejects %s when called directly", async (_, extra) => {
    const api = fakeApi();
    await expect(api.provider().video().doGenerate!(videoCall(extra))).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});

describe("video result", () => {
  test("returns the project's own MP4 with its metadata", async () => {
    const api = fakeApi({ creditsCharged: 12 });
    const result = await generateVideo({
      model: api.provider().video("wan-2.2"),
      prompt: "Waves",
      maxRetries: 0,
    });
    const [project] = api.projects();
    expect(result.video.uint8Array).toEqual(project.bytes);
    expect(result.video.mediaType).toBe("video/mp4");
    expect(result.warnings).toEqual([]);
    expect(result.responses[0].modelId).toBe("wan-2.2");
    expect(result.providerMetadata.magichour).toMatchObject({
      projectId: project.id,
      creditsCharged: 12,
    });
  });

  test("polls the accepted video project until it completes, then downloads its signed URL", async () => {
    const api = fakeApi({ statuses: ["queued", "rendering", "complete"] });
    await generateVideo({ model: api.provider().video(), prompt: "Waves", maxRetries: 0 });
    const [project] = api.projects();
    expect(api.polls().map((c) => `${c.method} ${c.url}`)).toEqual(
      Array(3).fill(`GET ${API}/v1/video-projects/${project.id}`)
    );
    expect(api.storage().map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${project.url}`]);
  });

  test("n videos run as n jobs, each returning its own project's output", async () => {
    const api = fakeApi({ statuses: ["rendering", "complete"] });
    const result = await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      n: 2,
      maxRetries: 0,
    });
    expect(api.generations()).toHaveLength(2);
    expect(result.videos.map((v) => Buffer.from(v.uint8Array).toString("hex")).sort()).toEqual(
      api
        .projects()
        .map((p) => Buffer.from(p.bytes).toString("hex"))
        .sort()
    );
  });
});
