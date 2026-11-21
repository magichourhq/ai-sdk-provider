import { generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { API, fakeApi, gif, png } from "./setup/fake-api.js";

describe("image generation", () => {
  test("sends the default request and returns the project's output, ID and charge", async () => {
    const api = fakeApi();
    const result = await generateImage({
      model: api.provider().image(),
      prompt: "A mug",
      maxRetries: 0,
    });
    const [project] = api.projects;
    expect(api.generations().map((c) => c.url)).toEqual([`${API}/v1/ai-image-generator`]);
    expect(api.generations()[0].body).toEqual({
      model: "default",
      image_count: 1,
      resolution: "640px",
      style: { prompt: "A mug" },
    });
    // Polled until the project completes, then downloaded once from its signed URL.
    expect(api.polls().map((c) => c.url)).toEqual(
      Array(3).fill(`${API}/v1/image-projects/${project.id}`)
    );
    expect(api.storage().map((c) => c.url)).toEqual([project.url]);
    expect(result.image.uint8Array).toEqual(project.bytes);
    expect(result.image.mediaType).toBe("image/png");
    expect(result.providerMetadata.magichour.images).toEqual([
      { projectId: project.id, creditsCharged: 5 },
    ]);
  });

  test("sends the chosen model, aspect ratio and resolution option", async () => {
    const api = fakeApi();
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
    "maps size %s to resolution %s and aspect ratio %s",
    async (size, resolution, ratio) => {
      const api = fakeApi();
      await generateImage({ model: api.provider().image(), prompt: "Mug", size, maxRetries: 0 });
      expect(api.generations()[0].body).toMatchObject({ resolution, aspect_ratio: ratio });
    }
  );

  test("runs n images as n single-image jobs, each with its own project", async () => {
    const api = fakeApi();
    const result = await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      n: 2,
      maxRetries: 0,
    });
    expect(api.generations().map((c) => c.body.image_count)).toEqual([1, 1]);
    expect(result.images).toHaveLength(2);
    const metadata = result.providerMetadata.magichour.images as { projectId: string }[];
    expect(metadata.map((m) => m.projectId).sort()).toEqual(api.projects.map((p) => p.id).sort());
  });
});

// Invalid input fails before any request, so it never starts a paid job.
describe("rejected image input", () => {
  test.each<[string, Record<string, unknown>]>([
    ["a blank prompt", { prompt: "   " }],
    ["a seed", { seed: 1 }],
    ["a mask", { prompt: { text: "Make it blue", images: [png], mask: png } }],
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
  ])("rejects %s", async (_, options) => {
    const api = fakeApi();
    await expect(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0, ...options })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  // The AI SDK splits larger requests into single-image calls, so this only happens directly.
  test("rejects more than one image per call", async () => {
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

describe("image editing", () => {
  test("uploads input bytes, passes URLs through and sends an editor request", async () => {
    const api = fakeApi();
    const result = await generateImage({
      model: api.provider().image("flux-2-klein"),
      prompt: { text: "Make it blue", images: [png, "https://example.com/mug.jpg"] },
      aspectRatio: "4:3",
      maxRetries: 0,
    });
    expect(api.generations().map((c) => c.url)).toEqual([`${API}/v1/ai-image-editor`]);
    expect(api.generations()[0].body).toEqual({
      model: "flux-2-klein",
      image_count: 1,
      resolution: "640px",
      aspect_ratio: "4:3",
      style: { prompt: "Make it blue" },
      assets: { image_file_paths: ["api-assets/input-1", "https://example.com/mug.jpg"] },
    });
    expect(result.image.uint8Array).toEqual(api.projects[0].bytes);
  });

  test.each<[string, string, Record<string, unknown>]>([
    ["a model the editor doesn't offer", "z-image-turbo", {}],
    ["more than 10 images", "default", { prompt: { text: "Blue", images: Array(11).fill(png) } }],
    ["an aspect ratio the editor doesn't offer", "default", { aspectRatio: "21:9" }],
    ["a bad file after a good one", "default", { prompt: { text: "Blue", images: [png, gif] } }],
  ])("rejects %s before any request", async (_, model, options) => {
    const api = fakeApi();
    await expect(
      generateImage({
        model: api.provider().image(model as "default"),
        prompt: { text: "Blue", images: [png] },
        maxRetries: 0,
        ...options,
      })
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});
