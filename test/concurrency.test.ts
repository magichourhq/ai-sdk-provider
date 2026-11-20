// Reused and overlapping calls on one model or provider each keep their own request, key,
// upload, result and error.
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { API, fakeApi, makePng, png } from "./fake-api.js";
import { expectRecoverable, rejection, until, videoCall } from "./helpers.js";

describe("reuse", () => {
  test("a video model reused for image-to-video and then text-only sends each its own way", async () => {
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
});

describe("overlapping calls", () => {
  test("concurrent image-to-video jobs each send their own upload", async () => {
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
      expect(upload.bytes).toEqual(images[Number(call.body.style.prompt.replace("Job ", ""))]);
    }
  });

  test("calls that finish out of order each return their own output and charge", async () => {
    const api = fakeApi({
      statusesFor: (n) =>
        n === 1 ? ["rendering", "rendering", "rendering", "complete"] : ["complete"],
      creditsCharged: (project) => (project.id.startsWith("video-1-") ? 9 : 18),
    });
    const model = api.provider({ pollIntervalMs: 5 }).video();
    const results = await Promise.all([
      model.doGenerate!(videoCall({ prompt: "First" })),
      model.doGenerate!(videoCall({ prompt: "Second" })),
    ]);
    results.forEach((result, i) => {
      const metadata = (result.providerMetadata as any).magichour;
      expect(metadata.projectId).toBe(api.projects()[i].id);
      expect(metadata.creditsCharged).toBe([9, 18][i]);
      const video = result.videos[0] as { type: "binary"; data: Uint8Array };
      expect(video.data).toEqual(api.projects()[i].bytes);
    });
  });

  test("aborting one call leaves the other running", async () => {
    const api = fakeApi({ statuses: ["rendering", "rendering", "rendering", "complete"] });
    const model = api.provider({ pollIntervalMs: 5 }).image();
    const first = new AbortController();
    const firstRun = rejection(
      generateImage({ model, prompt: "First", abortSignal: first.signal, maxRetries: 0 })
    );
    const secondRun = generateImage({ model, prompt: "Second", maxRetries: 0 });
    await until(() => api.projects().length === 2);
    first.abort();
    expectRecoverable(await firstRun, api.projects()[0].id);
    expect((await secondRun).image.uint8Array).toEqual(api.projects()[1].bytes);
  });
});

describe("providers with different keys", () => {
  test("two providers running at once each use their own key", async () => {
    const api = fakeApi({ statuses: ["queued", "rendering", "complete"] });
    const keys = ["key-tenant-a", "key-tenant-b"];
    await Promise.all(
      keys.map((apiKey, i) =>
        generateImage({
          model: api.provider({ apiKey, pollIntervalMs: 5 }).image(),
          prompt: `Tenant ${i}`,
          maxRetries: 0,
        })
      )
    );
    expect(api.generations()).toHaveLength(2);
    // Each project is created and polled with the key of the tenant that asked for it.
    api.generations().forEach((call, i) => {
      const bearer = `Bearer ${keys[Number(call.body.style.prompt.replace("Tenant ", ""))]}`;
      expect(call.headers.get("Authorization")).toBe(bearer);
      const polls = api.polls().filter((c) => c.url.endsWith(`/${api.projects()[i].id}`));
      expect(polls.length).toBeGreaterThan(0);
      for (const poll of polls) expect(poll.headers.get("Authorization")).toBe(bearer);
    });
  });
});
