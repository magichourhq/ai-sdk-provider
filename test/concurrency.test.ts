// Reused and overlapping calls on one model or provider each keep their own request, key,
// upload, result and error.
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { API, fakeApi, makePng, png } from "./fake-api.js";
import {
  type Api,
  expectRecoverable,
  isDownload,
  isUpload,
  kinds,
  latch,
  rejection,
  until,
  videoCall,
} from "./helpers.js";

describe("reuse", () => {
  test("a reused image model sends each call its own size", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const model = api.provider().image();
    await generateImage({ model, prompt: "Mug", size: "640x640", maxRetries: 0 });
    await generateImage({ model, prompt: "Mug", size: "2048x1152", maxRetries: 0 });
    const [first, second] = api.generations().map((c) => c.body);
    expect(first).toMatchObject({ resolution: "640px", aspect_ratio: "1:1" });
    expect(second).toMatchObject({ resolution: "2k", aspect_ratio: "16:9" });
  });

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

  test("a reused buffer refilled with a new image uploads the new bytes", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const model = api.provider().video();
    const image = png.slice();
    await generateVideo({ model, prompt: { image, text: "Animate" }, maxRetries: 0 });
    image[image.length - 5] ^= 0xff;
    await generateVideo({ model, prompt: { image, text: "Animate" }, maxRetries: 0 });
    expect(api.uploads()).toHaveLength(2);
    expect(api.uploads()[1].bytes).toEqual(image);
    expect(api.generations()[1].body.assets.image_file_path).toBe(api.uploads()[1].filePath);
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

  test("an image job whose upload finishes after a text job keeps its own settings", async () => {
    const upload = latch();
    const api = fakeApi({
      statuses: ["complete"],
      gate: (c) => (isUpload(c) ? upload.promise : undefined),
    });
    const model = api.provider().video();
    const imageJob = generateVideo({
      model,
      prompt: { image: png, text: "Animate" },
      duration: 1,
      generateAudio: false,
      maxRetries: 0,
    });
    await until(() => api.calls.some(isUpload));
    const text = await generateVideo({
      model,
      prompt: "Waves",
      duration: 10,
      resolution: "1920x1080",
      generateAudio: true,
      maxRetries: 0,
    });
    upload.release();
    const image = await imageJob;
    const [textCall, imageCall] = api.generations();
    expect(textCall.url).toBe(`${API}/v1/text-to-video`);
    expect(textCall.body).toMatchObject({ end_seconds: 10, resolution: "1080p", audio: true });
    expect(textCall.body).not.toHaveProperty("assets");
    expect(imageCall.url).toBe(`${API}/v1/image-to-video`);
    expect(imageCall.body).toMatchObject({ end_seconds: 1, resolution: "480p", audio: false });
    expect(imageCall.body.assets.image_file_path).toBe(api.uploads()[0].filePath);
    expect(text.video.uint8Array).toEqual(api.projects()[0].bytes);
    expect(image.video.uint8Array).toEqual(api.projects()[1].bytes);
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

  for (const [kind, run] of kinds)
    test(`${kind}: a failure that comes after another call succeeded names its own project`, async () => {
      // Job 1 fails after job 2 has already succeeded.
      const api = fakeApi({
        statusesFor: (n) =>
          n === 1 ? ["rendering", "rendering", "rendering", "error"] : ["complete"],
      });
      // The same settings object, so both jobs run through one provider.
      const settings = { pollIntervalMs: 5 };
      const first = rejection(run(api, { settings }));
      await new Promise((resolve) => setImmediate(resolve));
      await run(api, { settings });
      const error = await first;
      expect(api.projects()).toHaveLength(2);
      expectRecoverable(error, api.projects()[0].id);
      expect((error as Error).message).not.toContain(api.projects()[1].id);
    });

  const models: [
    string,
    (api: Api) => (prompt: string, signal?: AbortSignal) => Promise<unknown>,
  ][] = [
    [
      "image",
      (api) => {
        const model = api.provider({ pollIntervalMs: 5 }).image();
        return (prompt, abortSignal) =>
          generateImage({ model, prompt, abortSignal, maxRetries: 0 });
      },
    ],
    [
      "video",
      (api) => {
        const model = api.provider({ pollIntervalMs: 5 }).video();
        return (prompt, abortSignal) =>
          generateVideo({ model, prompt, abortSignal, maxRetries: 0 });
      },
    ],
  ];

  test.each(models)(
    "%s: a late download failure names its own project, not the one that finished first",
    async (_, start) => {
      const firstDownload = latch();
      const api: Api = fakeApi({
        statuses: ["complete"],
        gate: (c) =>
          isDownload(c) && c.url === api.projects()[0]?.url ? firstDownload.promise : undefined,
        downloadStatusFor: (p) => (p.id === api.projects()[0].id ? 403 : undefined),
      });
      const generate = start(api);
      const first = rejection(generate("First"));
      await until(() => api.storage().some((c) => c.url === api.projects()[0]?.url));
      await generate("Second");
      firstDownload.release();
      const error = await first;
      expectRecoverable(error, api.projects()[0].id);
      expect((error as Error).message).not.toContain(api.projects()[1].id);
    }
  );

  test.each(models)("%s: aborting one call leaves the other running", async (_, start) => {
    const api = fakeApi({ statuses: ["rendering", "rendering", "rendering", "complete"] });
    const generate = start(api);
    const first = new AbortController();
    const firstRun = rejection(generate("First", first.signal));
    const secondRun = generate("Second");
    await until(() => api.projects().length === 2);
    first.abort();
    expectRecoverable(await firstRun, api.projects()[0].id);
    const result = (await secondRun) as {
      image?: { uint8Array: Uint8Array };
      video?: { uint8Array: Uint8Array };
    };
    expect((result.image ?? result.video)!.uint8Array).toEqual(api.projects()[1].bytes);
  });
});

describe("tenants with different keys", () => {
  test("two image providers running at once each use their own key and fetch", async () => {
    const api = fakeApi({ statuses: ["queued", "rendering", "rendering", "complete"] });
    const keys = ["key-tenant-a", "key-tenant-b"];
    // Each tenant's own fetch, so a request sent through the other tenant's fetch shows up.
    const seen: string[][] = [[], []];
    await Promise.all(
      keys.map((apiKey, i) =>
        generateImage({
          model: api
            .provider({
              apiKey,
              fetch: (input, init) => {
                seen[i].push(new Request(input, init).headers.get("Authorization") ?? "storage");
                return api.fetch(input, init);
              },
            })
            .image(),
          prompt: `Tenant ${i}`,
          maxRetries: 0,
        })
      )
    );
    seen.forEach((auth, i) => {
      expect(auth.length).toBeGreaterThan(2);
      for (const value of auth) expect(["storage", `Bearer ${keys[i]}`]).toContain(value);
    });
    // Each project is polled with the key that created it.
    api.generations().forEach((call, i) => {
      const tenant = Number(call.body.style.prompt.replace("Tenant ", ""));
      expect(call.headers.get("Authorization")).toBe(`Bearer ${keys[tenant]}`);
      for (const poll of api.polls().filter((c) => c.url.endsWith(`/${api.projects()[i].id}`)))
        expect(poll.headers.get("Authorization")).toBe(`Bearer ${keys[tenant]}`);
    });
  });

  test("two image-to-video providers each use their own key, uploads included", async () => {
    const api = fakeApi({ statuses: ["rendering", "complete"] });
    const keys = ["key-tenant-a", "key-tenant-b"];
    await Promise.all(
      keys.map((apiKey, i) =>
        generateVideo({
          model: api.provider({ apiKey, pollIntervalMs: 5 }).video(),
          prompt: { image: png, text: `Tenant ${i}` },
          maxRetries: 0,
        })
      )
    );
    expect(api.generations()).toHaveLength(2);
    api.generations().forEach((call, i) => {
      const bearer = `Bearer ${keys[Number(call.body.style.prompt.replace("Tenant ", ""))]}`;
      expect(call.headers.get("Authorization")).toBe(bearer);
      const upload = api
        .uploads()
        .findIndex((u) => u.filePath === call.body.assets.image_file_path);
      expect(api.uploadUrlRequests()[upload].headers.get("Authorization")).toBe(bearer);
      const project = api.projects()[i].id;
      for (const poll of api.polls().filter((c) => c.url.endsWith(`/${project}`)))
        expect(poll.headers.get("Authorization")).toBe(bearer);
    });
  });
});
