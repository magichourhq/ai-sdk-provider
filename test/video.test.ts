import { experimental_generateVideo as generateVideo } from "ai";
import { describe, expect, test } from "vitest";
import { API, fakeApi, jpeg, makePng, png, STORAGE, webp } from "./fake-api.js";

const signedUpload = `${STORAGE}/uploads/input-1.png?X-Goog-Signature=sig%2Bup%2F1%26y%3D`;

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
    expect(uploads.map((c) => c.url)).toEqual([signedUpload]);
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

  test("uploads a base64 image string", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: base64Png, text: "Animate" },
      maxRetries: 0,
    });
    expect(api.storage().find((c) => c.method === "PUT")!.body).toEqual(png);
    expect(api.generations()[0].body.assets.image_file_path).toBe("api-assets/test/input-1.png");
  });

  test.each([
    ["PNG bytes declared as JPEG", "image/jpeg", png],
    ["WebP bytes declared as JPEG", "image/jpeg", webp],
    ["JPEG bytes declared as WebP", "image/webp", jpeg],
    [
      "a WAVE file declared as WebP",
      "image/webp",
      new Uint8Array([...Buffer.from("RIFF"), 36, 0, 0, 0, ...Buffer.from("WAVEfmt ")]),
    ],
    ["JPEG bytes declared as PNG", "image/png", jpeg],
  ])("rejects %s before any request", async (_, mediaType, data) => {
    const api = fakeApi();
    await expect(
      api.provider().video().doGenerate!(videoCall({ image: { type: "file", mediaType, data } }))
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  test("a data URL whose bytes aren't the declared image type starts nothing", async () => {
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

  test("uploads base64 image data passed to the model directly", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType: "image/png", data: base64Png } })
    );
    expect(api.storage().find((c) => c.method === "PUT")!.body).toEqual(png);
  });

  test.each([
    ["image/png", "png", png],
    ["image/jpeg", "jpg", jpeg],
    ["image/webp", "webp", webp],
  ])("uploads a %s image with the %s extension", async (mediaType, extension, data) => {
    const api = fakeApi({ statuses: ["complete"] });
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType, data } })
    );
    expect(api.calls[0].body).toEqual({ items: [{ type: "image", extension }] });
    expect(api.uploads()[0].bytes).toEqual(data);
  });

  test("uploads only the bytes of a view, not the rest of its buffer", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const padded = new Uint8Array([
      ...Buffer.from("SENTINEL-BEFORE"),
      ...png,
      ...Buffer.from("SENTINEL-AFTER"),
    ]);
    const view = padded.subarray(15, 15 + png.length);
    expect(view).toEqual(png);
    await api.provider().video().doGenerate!(
      videoCall({ image: { type: "file", mediaType: "image/png", data: view } })
    );
    expect(api.uploads()[0].bytes).toEqual(png);
  });

  test.each([true, false])("sends audio: %s for image-to-video", async (generateAudio) => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: png, text: "Animate" },
      generateAudio,
      maxRetries: 0,
    });
    expect(api.generations()[0].body.audio).toBe(generateAudio);
  });

  test("sends a signed input image URL exactly as given", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const url =
      "https://cdn.example.com/in%20put.png?X-Amz-Signature=a%2Fb%2Bc%26d&X-Amz-Expires=60";
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: url, text: "Animate" },
      maxRetries: 0,
    });
    expect(api.generations()[0].body.assets.image_file_path).toBe(url);
  });

  test("concurrent jobs each send the asset path of their own upload", async () => {
    const api = fakeApi({ statuses: ["rendering", "complete"] });
    const model = api.provider().video();
    const images = [makePng(10, 20, 30), makePng(200, 100, 50)];
    await Promise.all(
      images.map((image, i) =>
        generateVideo({ model, prompt: { image, text: `Job ${i}` }, maxRetries: 0 })
      )
    );
    expect(api.generations()).toHaveLength(2);
    for (const call of api.generations()) {
      const upload = api.uploads().find((u) => u.filePath === call.body.assets.image_file_path)!;
      const job = Number(call.body.style.prompt.replace("Job ", ""));
      expect(upload.bytes).toEqual(images[job]);
    }
  });

  test("each job uploads to its own signed URL and sends its own asset path", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const provider = api.provider();
    const second = new Uint8Array([...png]);
    await generateVideo({
      model: provider.video(),
      prompt: { image: png, text: "One" },
      maxRetries: 0,
    });
    await generateVideo({
      model: provider.video(),
      prompt: { image: second, text: "Two" },
      maxRetries: 0,
    });
    const [first, next] = api.uploads();
    expect(first.url).not.toBe(next.url);
    expect(
      api
        .storage()
        .filter((c) => c.method === "PUT")
        .map((c) => c.url)
    ).toEqual([first.url, next.url]);
    expect(api.generations().map((c) => c.body.assets.image_file_path)).toEqual([
      first.filePath,
      next.filePath,
    ]);
  });

  test("a model reused for image-to-video and then text-only sends each job its own way", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const model = api.provider().video();
    await generateVideo({ model, prompt: { image: png, text: "Animate" }, maxRetries: 0 });
    await generateVideo({ model, prompt: "Waves", maxRetries: 0 });
    const [imageJob, textJob] = api.generations();
    expect(imageJob.url).toBe(`${API}/v1/image-to-video`);
    expect(textJob.url).toBe(`${API}/v1/text-to-video`);
    expect(textJob.body).not.toHaveProperty("assets");
    expect(textJob.body.style).toEqual({ prompt: "Waves" });
    expect(api.uploadUrlRequests()).toHaveLength(1);
  });

  test("an image job whose upload finishes after a text job on the same model keeps its route", async () => {
    let releaseUpload!: () => void;
    const upload = new Promise<void>((resolve) => (releaseUpload = resolve));
    const api = fakeApi({
      statuses: ["complete"],
      gate: (c) => (c.method === "PUT" ? upload : undefined),
    });
    const model = api.provider().video();
    const imageJob = generateVideo({
      model,
      prompt: { image: png, text: "Animate" },
      maxRetries: 0,
    });
    for (let i = 0; i < 1000 && !api.calls.some((c) => c.method === "PUT"); i++)
      await new Promise((resolve) => setImmediate(resolve));
    const text = await generateVideo({ model, prompt: "Waves", maxRetries: 0 });
    releaseUpload();
    const image = await imageJob;
    const [textCall, imageCall] = api.generations();
    expect(textCall.url).toBe(`${API}/v1/text-to-video`);
    expect(textCall.body).not.toHaveProperty("assets");
    expect(imageCall.url).toBe(`${API}/v1/image-to-video`);
    expect(imageCall.body.assets.image_file_path).toBe(api.uploads()[0].filePath);
    expect(text.video.uint8Array).toEqual(api.projects()[0].bytes);
    expect(image.video.uint8Array).toEqual(api.projects()[1].bytes);
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

  test("an upload that fails slowly still starts no paid job", async () => {
    const api = fakeApi({ uploadStatus: 403, delay: (c) => (c.method === "PUT" ? 30 : 0) });
    await expect(
      generateVideo({
        model: api.provider().video(),
        prompt: { image: png, text: "Animate" },
        maxRetries: 3,
      })
    ).rejects.toThrow();
    expect(api.generations()).toHaveLength(0);
  });

  test("an upload-URL request that fails", async () => {
    const api = fakeApi({ uploadUrlsStatus: 500 });
    await expect(
      generateVideo({
        model: api.provider().video(),
        prompt: { image: png, text: "Animate" },
        maxRetries: 3,
      })
    ).rejects.toThrow();
    expect(api.uploadUrlRequests()).toHaveLength(1);
    expect(api.offOrigin()).toHaveLength(0);
    expect(api.generations()).toHaveLength(0);
  });

  const item = (overrides: Record<string, unknown>) => ({
    items: [
      {
        upload_url: signedUpload,
        file_path: "api-assets/x.png",
        expires_at: "2099-01-01T00:00:00Z",
        ...overrides,
      },
    ],
  });
  test.each([
    ["no items", { items: [] }],
    ["no file path", item({ file_path: undefined })],
    ["a numeric file path", item({ file_path: 123 })],
    ["an object file path", item({ file_path: {} })],
    ["a blank file path", item({ file_path: "    " })],
    ["no upload URL", item({ upload_url: undefined })],
    ["a non-string upload URL", item({ upload_url: 42 })],
    ["a plain-HTTP upload URL", item({ upload_url: signedUpload.replace("https:", "http:") })],
    [
      "an upload URL with embedded credentials",
      item({ upload_url: signedUpload.replace("https://", "https://user:pass@") }),
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
    expect(api.uploadUrlRequests()).toHaveLength(1);
    expect(api.offOrigin()).toHaveLength(0);
    expect(api.generations()).toHaveLength(0);
  });

  test.each([
    ["empty bytes", new Uint8Array(0)],
    ["an empty base64 string", ""],
    ["invalid base64", "iVBORw0KGgo!!"],
    ["text labeled as a PNG", Buffer.from("Hello").toString("base64")],
    ["JPEG bytes labeled as a PNG", jpeg],
    ["base64 missing a character", "iVBORw0KGgoAA"],
  ])("an input image with %s", async (_, data) => {
    const api = fakeApi();
    await expect(
      api.provider().video().doGenerate!(
        videoCall({ image: { type: "file", mediaType: "image/png", data } })
      )
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
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
    [
      "an image URL with embedded credentials",
      { prompt: { image: "https://user:secret@example.com/i.png", text: "x" } },
    ],
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
    [
      "frame images alongside an input image",
      {
        image: { type: "file", mediaType: "image/png", data: png },
        frameImages: [{ type: "file", mediaType: "image/png", data: png }],
      },
    ],
    [
      "reference inputs alongside an input image",
      {
        image: { type: "file", mediaType: "image/png", data: png },
        inputReferences: [{ type: "file", mediaType: "image/png", data: png }],
      },
    ],
    [
      "an image URL with an invalid duration",
      { image: { type: "url", url: "https://example.com/i.png" }, duration: 0 },
    ],
    [
      "an image URL with an invalid resolution",
      { image: { type: "url", url: "https://example.com/i.png" }, resolution: "1600x900" },
    ],
  ])("rejects %s when called directly", async (_, extra) => {
    const api = fakeApi();
    await expect(api.provider().video().doGenerate!(videoCall(extra))).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});

describe("video result", () => {
  test("returns the project's own MP4 with its metadata", async () => {
    const api = fakeApi({
      creditsCharged: 12,
      // A second output must not change what's downloaded or the reported charge.
      downloads: (p) => [
        { url: p.url, expires_at: "2099-01-01T00:00:00Z" },
        { url: `${p.url}&copy=2`, expires_at: "2099-01-01T00:00:00Z" },
      ],
    });
    const result = await generateVideo({
      model: api.provider().video("wan-2.2"),
      prompt: "Waves",
      maxRetries: 0,
    });
    const [project] = api.projects();
    expect(api.storage().map((c) => c.url)).toEqual([project.url]);
    expect(result.responses[0].timestamp).toBeInstanceOf(Date);
    expect(result.video.uint8Array).toEqual(project.bytes);
    expect(result.video.mediaType).toBe("video/mp4");
    expect(result.warnings).toEqual([]);
    expect(result.responses[0].modelId).toBe("wan-2.2");
    expect(result.providerMetadata.magichour).toMatchObject({
      projectId: project.id,
      creditsCharged: 12,
    });
  });

  test.each([
    ["text-to-video", "Waves"],
    ["image-to-video", { image: png, text: "Animate" }],
  ] as const)("%s waits through draft, queued and rendering", async (_, prompt) => {
    const api = fakeApi({ statuses: ["draft", "queued", "rendering", "complete"] });
    const result = await generateVideo({ model: api.provider().video(), prompt, maxRetries: 0 });
    expect(api.polls()).toHaveLength(4);
    expect(result.video.uint8Array).toEqual(api.projects()[0].bytes);
  });

  test("uses the downloads list when the deprecated download field is null", async () => {
    const api = fakeApi({ statuses: ["complete"], nullDownloadField: true });
    const result = await generateVideo({
      model: api.provider().video(),
      prompt: "Waves",
      maxRetries: 0,
    });
    expect(result.video.uint8Array).toEqual(api.projects()[0].bytes);
  });

  test("overlapping calls on one model each return their own project's output and metadata", async () => {
    // The first job finishes last.
    const api = fakeApi({
      statusesFor: (n) =>
        n === 1 ? ["rendering", "rendering", "rendering", "complete"] : ["complete"],
    });
    const model = api.provider({ pollIntervalMs: 5 }).video();
    const results = await Promise.all([
      model.doGenerate!(videoCall({ prompt: "First" })),
      model.doGenerate!(videoCall({ prompt: "Second" })),
    ]);
    expect(api.projects()).toHaveLength(2);
    results.forEach((result, i) => {
      const projectId = (result.providerMetadata as any).magichour.projectId;
      expect(projectId).toBe(api.projects()[i].id);
      const video = result.videos[0] as { type: "binary"; data: Uint8Array };
      expect(video.data).toEqual(api.projects()[i].bytes);
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
