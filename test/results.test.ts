// What the caller gets back: the accepted project's own output and metadata, through the AI SDK.
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { API, fakeApi } from "./fake-api.js";

describe("image results", () => {
  test("return the project's own PNG with its project ID and charge", async () => {
    const api = fakeApi({ creditsCharged: 7 });
    const result = await generateImage({
      model: api.provider().image("flux-2-klein"),
      prompt: "Mug",
      maxRetries: 0,
    });
    const [project] = api.projects();
    expect(result.image.uint8Array).toEqual(project.bytes);
    expect(result.image.mediaType).toBe("image/png");
    expect(result.warnings).toEqual([]);
    expect(result.responses[0].modelId).toBe("flux-2-klein");
    expect(result.responses[0].timestamp).toBeInstanceOf(Date);
    expect(result.providerMetadata.magichour.images).toEqual([
      { projectId: project.id, creditsCharged: 7 },
    ]);
  });

  test("poll the image project until it completes, then download its signed URL", async () => {
    const api = fakeApi({ statuses: ["draft", "queued", "rendering", "complete"] });
    await generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 });
    const [project] = api.projects();
    expect(api.polls().map((c) => `${c.method} ${c.url}`)).toEqual(
      Array(4).fill(`GET ${API}/v1/image-projects/${project.id}`)
    );
    expect(api.storage().map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${project.url}`]);
  });

  test("download only the first output when a project has several", async () => {
    const api = fakeApi({
      statuses: ["complete"],
      downloads: (project) => [
        { url: project.url, expires_at: "2099-01-01T00:00:00Z" },
        { url: `${project.url}&second=1`, expires_at: "2099-01-01T00:00:00Z" },
      ],
    });
    const result = await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      maxRetries: 0,
    });
    expect(result.images).toHaveLength(1);
    expect(api.storage().map((c) => c.url)).toEqual([api.projects()[0].url]);
  });

  test("n images run as n single-image jobs, each returning its own project's output", async () => {
    const api = fakeApi({ statuses: ["rendering", "complete"] });
    const result = await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      n: 3,
      maxRetries: 0,
    });
    expect(api.generations()).toHaveLength(3);
    for (const call of api.generations()) expect(call.body.image_count).toBe(1);
    const metadata = result.providerMetadata.magichour.images as { projectId: string }[];
    expect(result.images).toHaveLength(3);
    expect(metadata.map((m) => m.projectId).sort()).toEqual(
      api
        .projects()
        .map((p) => p.id)
        .sort()
    );
    result.images.forEach((image, i) => {
      const project = api.projects().find((p) => p.id === metadata[i].projectId)!;
      expect(image.uint8Array).toEqual(project.bytes);
    });
  });
});

describe("video results", () => {
  test("return the project's own MP4 with its project ID and charge", async () => {
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
    expect(result.video.uint8Array).toEqual(project.bytes);
    expect(result.video.mediaType).toBe("video/mp4");
    expect(result.warnings).toEqual([]);
    expect(result.responses[0].modelId).toBe("wan-2.2");
    expect(result.responses[0].timestamp).toBeInstanceOf(Date);
    expect(result.providerMetadata.magichour).toMatchObject({
      projectId: project.id,
      creditsCharged: 12,
    });
  });

  test("poll the video project until it completes, then download its signed URL", async () => {
    const api = fakeApi({ statuses: ["draft", "queued", "rendering", "complete"] });
    await generateVideo({ model: api.provider().video(), prompt: "Waves", maxRetries: 0 });
    const [project] = api.projects();
    expect(api.polls().map((c) => `${c.method} ${c.url}`)).toEqual(
      Array(4).fill(`GET ${API}/v1/video-projects/${project.id}`)
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
