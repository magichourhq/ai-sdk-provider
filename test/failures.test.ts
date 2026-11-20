// What a failure costs: a paid request is never sent twice, and once a job is accepted every
// failure names its project, so the caller can resume it instead of paying again.
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { MagicHourError, type MagicHourSettings } from "../src/index.js";
import { fakeApi, type FakeApiOptions, png } from "./setup/fake-api.js";

type Api = ReturnType<typeof fakeApi>;
type Options = { settings?: MagicHourSettings; abortSignal?: AbortSignal };

// maxRetries is 3, so a provider that lets the AI SDK retry would send a second paid request.
function image(api: Api, { settings, abortSignal }: Options = {}) {
  const model = api.provider(settings).image();
  return generateImage({ model, prompt: "Mug", abortSignal, maxRetries: 3 });
}
function video(api: Api, { settings, abortSignal }: Options = {}) {
  const model = api.provider(settings).video();
  return generateVideo({ model, prompt: "Waves", abortSignal, maxRetries: 3 });
}
const models = [
  ["image", image],
  ["video", video],
] as const;

/** The error a call rejects with. */
function rejection(call: Promise<unknown>): Promise<MagicHourError> {
  return call.then(
    () => {
      throw new Error("Expected the call to reject");
    },
    (error) => error
  );
}

describe("a paid request is never sent twice", () => {
  // The AI SDK retries 429 and 5xx by default, and the fake's errors carry Retry-After.
  test("a rejected submission is sent once and keeps its status", async () => {
    const api = fakeApi({ createStatus: 429 });
    const error = await rejection(image(api));
    expect(api.generations()).toHaveLength(1);
    expect(error).toBeInstanceOf(MagicHourError);
    expect(error.status).toBe(429);
    expect(error.message).not.toMatch(/Acceptance is unknown/);
  });

  // The job may have been accepted before the failure, so the caller must check first.
  test.each<[string, FakeApiOptions]>([
    ["HTTP 500", { createStatus: 500 }],
    ["a dropped connection", { createNetworkError: true }],
  ])("%s on submission is sent once and says acceptance is unknown", async (_, options) => {
    const api = fakeApi(options);
    const error = await rejection(image(api));
    expect(api.generations()).toHaveLength(1);
    expect(error).toBeInstanceOf(MagicHourError);
    expect(error.projectId).toBeUndefined();
    expect(error.message).toMatch(/Acceptance is unknown/);
  });

  test("a failed upload starts no paid job", async () => {
    const api = fakeApi({ uploadStatus: 403 });
    const model = api.provider().video();
    await rejection(generateVideo({ model, prompt: { image: png, text: "Animate" } }));
    expect(api.uploads).toHaveLength(1);
    expect(api.generations()).toHaveLength(0);
  });
});

describe("after acceptance, a failure names the project", () => {
  function expectNamesProject(error: MagicHourError, api: Api) {
    expect(api.projects).toHaveLength(1);
    expect(error).toBeInstanceOf(MagicHourError);
    expect(error.projectId).toBe(api.projects[0].id);
    expect(error.message).toContain(api.projects[0].id);
    expect(api.generations()).toHaveLength(1);
  }

  test("a failed render", async () => {
    const api = fakeApi({ statuses: ["rendering", "error"] });
    expectNamesProject(await rejection(image(api)), api);
  });

  test.each(models)("%s: a failed download", async (_, run) => {
    const api = fakeApi({ downloadStatus: 403 });
    expectNamesProject(await rejection(run(api)), api);
  });

  test.each(models)("%s: an abort while waiting", async (_, run) => {
    const api = fakeApi({ statuses: ["rendering"] });
    const controller = new AbortController();
    // Aborts as the first poll goes out.
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (String(input).includes("-projects/")) controller.abort();
      return api.fetch(input, init);
    };
    const error = await rejection(
      run(api, { settings: { fetch }, abortSignal: controller.signal })
    );
    expectNamesProject(error, api);
  });

  test("timeoutMs running out", async () => {
    const api = fakeApi({ statuses: ["rendering"] });
    expectNamesProject(await rejection(image(api, { settings: { timeoutMs: 100 } })), api);
  });
});

describe("onProjectCreated", () => {
  test("receives the accepted project before polling starts", async () => {
    const api = fakeApi();
    const seen: unknown[] = [];
    await image(api, {
      settings: {
        onProjectCreated: (project) => void seen.push({ ...project, polls: api.polls().length }),
      },
    });
    expect(seen).toEqual([{ id: api.projects[0].id, kind: "image", polls: 0 }]);
  });
});
