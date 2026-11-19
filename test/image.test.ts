import { createProviderRegistry, generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { fakeApi, png, STORAGE } from "./fake-api.js";

describe("image request", () => {
  test("defaults to the default model, one 640px image and no aspect ratio", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    await generateImage({ model: api.provider().image(), prompt: "A mug", maxRetries: 0 });
    expect(api.generations()).toHaveLength(1);
    expect(api.generations()[0].url).toBe("https://api.magichour.ai/v1/ai-image-generator");
    expect(api.generations()[0].body).toEqual({
      model: "default",
      image_count: 1,
      resolution: "640px",
      style: { prompt: "A mug" },
    });
  });

  test.each(["default", "flux-2-klein", "z-image-turbo", "qwen-image-2.1"])(
    "sends the %s model",
    async (modelId) => {
      const api = fakeApi({ statuses: ["complete"] });
      await generateImage({
        model: api.provider().image(modelId as any),
        prompt: "Mug",
        maxRetries: 0,
      });
      expect(api.generations()[0].body.model).toBe(modelId);
    }
  );

  test.each([
    ["640x640", "640px", "1:1"],
    ["1024x1024", "1k", "1:1"],
    ["2048x2048", "2k", "1:1"],
    ["2048x1152", "2k", "16:9"],
    ["1152x2048", "2k", "9:16"],
    ["1024x576", "1k", "16:9"],
  ] as const)(
    "maps size %s to resolution %s and aspect ratio %s",
    async (size, resolution, ratio) => {
      const api = fakeApi({ statuses: ["complete"] });
      await generateImage({ model: api.provider().image(), prompt: "Mug", size, maxRetries: 0 });
      expect(api.generations()[0].body).toMatchObject({ resolution, aspect_ratio: ratio });
    }
  );

  test.each(["1:1", "16:9", "9:16"] as const)("sends aspect ratio %s", async (aspectRatio) => {
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

  test("accepts a matching size and aspect ratio together", async () => {
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
    "sends the %s resolution from provider options",
    async (resolution) => {
      const api = fakeApi({ statuses: ["complete"] });
      await generateImage({
        model: api.provider().image(),
        prompt: "Mug",
        providerOptions: { magichour: { resolution } },
        maxRetries: 0,
      });
      expect(api.generations()[0].body.resolution).toBe(resolution);
    }
  );

  test("passes the prompt through unchanged", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const prompt = '  A "quoted" prompt\nwith a newline and émoji 🎨  ';
    await generateImage({ model: api.provider().image(), prompt, maxRetries: 0 });
    expect(api.generations()[0].body.style.prompt).toBe(prompt);
  });
});

describe("image validation happens before any request", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a blank prompt", { prompt: "   " }],
    ["a seed", { seed: 1 }],
    ["a size that isn't a 640, 1024 or 2048 tier", { size: "500x500" }],
    ["a size with an unsupported aspect ratio", { size: "1024x768" }],
    ["a zero dimension", { size: "0x1024" }],
    ["an unsupported aspect ratio", { aspectRatio: "4:3" }],
    ["a size and aspect ratio that disagree", { size: "1024x1024", aspectRatio: "16:9" }],
    ["an unsupported resolution option", { providerOptions: { magichour: { resolution: "4k" } } }],
    ["a non-string resolution option", { providerOptions: { magichour: { resolution: 1024 } } }],
    [
      "both size and a resolution option",
      { size: "1024x1024", providerOptions: { magichour: { resolution: "1k" } } },
    ],
    ["an unknown provider option", { providerOptions: { magichour: { image_count: 4 } } }],
  ];
  test.each(cases)("rejects %s", async (_, options) => {
    const api = fakeApi();
    await expect(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0, ...options })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  test("rejects image editing inputs", async () => {
    const api = fakeApi();
    await expect(
      generateImage({
        model: api.provider().image(),
        prompt: { text: "Make it blue", images: [png] },
        maxRetries: 0,
      })
    ).rejects.toThrow(/not image editing/);
    await expect(
      generateImage({
        model: api.provider().image(),
        prompt: { text: "Make it blue", images: [png], mask: png },
        maxRetries: 0,
      })
    ).rejects.toThrow(/not image editing/);
    expect(api.calls).toHaveLength(0);
  });

  test("rejects more than one image per call when called directly", async () => {
    const api = fakeApi();
    const model = api.provider().image();
    await expect(
      model.doGenerate({
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

describe("image result", () => {
  test("returns the downloaded bytes with project metadata", async () => {
    const api = fakeApi({ creditsCharged: 7 });
    const result = await generateImage({
      model: api.provider().image("flux-2-klein"),
      prompt: "Mug",
      maxRetries: 0,
    });
    expect(result.image.uint8Array).toEqual(png);
    expect(result.image.mediaType).toBe("image/png");
    expect(result.warnings).toEqual([]);
    expect(result.responses[0].modelId).toBe("flux-2-klein");
    expect(result.providerMetadata.magichour.images).toEqual([
      { projectId: "project-1", creditsCharged: 7 },
    ]);
  });

  test("polls the image project until it completes, then downloads once", async () => {
    const api = fakeApi({ statuses: ["draft", "queued", "rendering", "complete"] });
    await generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 });
    expect(api.polls().map((c) => c.url)).toEqual(
      Array(4).fill("https://api.magichour.ai/v1/image-projects/project-1")
    );
    expect(api.storage().map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${STORAGE}/output.png`]);
  });

  test("downloads only the first output when a project has several", async () => {
    const api = fakeApi({
      statuses: ["complete"],
      downloads: [
        { url: `${STORAGE}/first.png`, expires_at: "2099-01-01T00:00:00Z" },
        { url: `${STORAGE}/second.png`, expires_at: "2099-01-01T00:00:00Z" },
      ],
    });
    const result = await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      maxRetries: 0,
    });
    expect(result.images).toHaveLength(1);
    expect(api.storage().map((c) => c.url)).toEqual([`${STORAGE}/first.png`]);
  });

  test("n images run as n single-image jobs and report every project", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const result = await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      n: 3,
      maxRetries: 0,
    });
    expect(result.images).toHaveLength(3);
    expect(api.generations()).toHaveLength(3);
    for (const call of api.generations()) expect(call.body.image_count).toBe(1);
    const projects = (result.providerMetadata.magichour.images as { projectId: string }[]).map(
      (image) => image.projectId
    );
    expect(projects.sort()).toEqual(["project-1", "project-2", "project-3"]);
  });

  test("works through an AI SDK provider registry", async () => {
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
