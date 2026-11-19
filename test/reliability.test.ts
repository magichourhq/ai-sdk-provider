import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { MagicHourError } from "../src/index.js";
import { fakeApi, mp4, png, STORAGE } from "./fake-api.js";

/** Matches an error that tells the caller which accepted project to resume. */
function keepsProject(projectId = "project-1") {
  return (error: unknown) =>
    error instanceof MagicHourError && error.projectId === projectId && error.isRetryable === false;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject");
}

describe("paid generations are never retried", () => {
  test.each([400, 401, 402, 404, 408, 409, 422, 429, 500, 502, 503])(
    "HTTP %i on submission sends exactly one request, even with AI SDK retries enabled",
    async (status) => {
      const api = fakeApi({ createStatus: status });
      const error = await rejection(
        generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 3 })
      );
      expect(error).toBeInstanceOf(MagicHourError);
      expect((error as MagicHourError).isRetryable).toBe(false);
      expect(api.calls).toHaveLength(1);
    }
  );

  test.each([400, 401, 402, 422])("HTTP %i is reported with its status", async (status) => {
    const api = fakeApi({ createStatus: status });
    const error = await rejection(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 })
    );
    expect((error as MagicHourError).status).toBe(status);
    expect((error as MagicHourError).projectId).toBeUndefined();
  });

  test.each([408, 500, 503])("HTTP %i on submission says acceptance is unknown", async (status) => {
    const api = fakeApi({ createStatus: status });
    await expect(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 })
    ).rejects.toThrow(/Acceptance is unknown/);
  });

  test("a dropped connection on submission says acceptance is unknown and doesn't retry", async () => {
    const api = fakeApi({ createNetworkError: true });
    await expect(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 3 })
    ).rejects.toThrow(/Acceptance is unknown/);
    expect(api.calls).toHaveLength(1);
  });

  test("a video submission failure doesn't retry either", async () => {
    const api = fakeApi({ createStatus: 500 });
    await expect(
      generateVideo({ model: api.provider().video(), prompt: "Waves", maxRetries: 3 })
    ).rejects.toThrow(/Acceptance is unknown/);
    expect(api.generations()).toHaveLength(1);
  });

  test.each([
    ["no project ID", () => ({ credits_charged: 5 })],
    ["an empty project ID", () => ({ id: "" })],
    ["a non-string project ID", () => ({ id: 42 })],
  ])("an accepted response with %s fails without resubmitting", async (_, createBody) => {
    const api = fakeApi({ createBody });
    await expect(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 3 })
    ).rejects.toBeInstanceOf(MagicHourError);
    expect(api.generations()).toHaveLength(1);
    expect(api.polls()).toHaveLength(0);
  });
});

describe("failures after acceptance keep the project ID", () => {
  test.each(["error", "canceled"])("a %s project", async (status) => {
    const api = fakeApi({ statuses: ["rendering", status] });
    const error = await rejection(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 3 })
    );
    expect(keepsProject()(error)).toBe(true);
    expect(api.generations()).toHaveLength(1);
  });

  test("an unknown project status", async () => {
    const api = fakeApi({ statuses: ["exploded"] });
    const error = await rejection(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 })
    );
    expect(keepsProject()(error)).toBe(true);
  });

  test("a complete project without downloads", async () => {
    const api = fakeApi({ statuses: ["complete"], downloads: [] });
    const error = await rejection(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 })
    );
    expect(keepsProject()(error)).toBe(true);
    expect(api.storage()).toHaveLength(0);
  });

  test("a download URL that isn't HTTPS is never fetched", async () => {
    const api = fakeApi({
      statuses: ["complete"],
      downloads: [{ url: "http://storage.example/output.png", expires_at: "2099-01-01T00:00:00Z" }],
    });
    const error = await rejection(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 })
    );
    expect(keepsProject()(error)).toBe(true);
    expect(api.calls.some((c) => c.url.startsWith("http://"))).toBe(false);
  });

  test("a failed poll", async () => {
    const api = fakeApi({ projectStatus: 500 });
    const error = await rejection(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 3 })
    );
    expect(keepsProject()(error)).toBe(true);
    expect(api.generations()).toHaveLength(1);
  });

  test.each(["image", "video"] as const)("a failed %s download", async (kind) => {
    const api = fakeApi({ statuses: ["complete"], downloadStatus: 403, media: mp4 });
    const run =
      kind === "image"
        ? generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 3 })
        : generateVideo({ model: api.provider().video(), prompt: "Waves", maxRetries: 3 });
    expect(keepsProject()(await rejection(run))).toBe(true);
    expect(api.generations()).toHaveLength(1);
  });

  test("the error message tells the caller to resume the project", async () => {
    const api = fakeApi({ statuses: ["error"] });
    await expect(
      generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 })
    ).rejects.toThrow(/project-1/);
  });
});

describe("cancellation and timeouts", () => {
  test("an already-aborted signal starts no generation", async () => {
    const api = fakeApi();
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateImage({
        model: api.provider().image(),
        prompt: "Mug",
        abortSignal: controller.signal,
        maxRetries: 0,
      })
    ).rejects.toThrow();
    expect(api.generations()).toHaveLength(0);
  });

  test("aborting while waiting keeps the project ID and stops polling", async () => {
    const api = fakeApi({ statuses: ["rendering"] });
    const controller = new AbortController();
    const provider = api.provider({ pollIntervalMs: 20 });
    const run = generateImage({
      model: provider.image(),
      prompt: "Mug",
      abortSignal: controller.signal,
      maxRetries: 3,
    });
    setTimeout(() => controller.abort(), 50);
    expect(keepsProject()(await rejection(run))).toBe(true);
    const polls = api.polls().length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(api.polls()).toHaveLength(polls);
    expect(api.generations()).toHaveLength(1);
  });

  test("timeoutMs bounds the wait and keeps the project ID", async () => {
    const api = fakeApi({ statuses: ["rendering"] });
    const started = Date.now();
    const error = await rejection(
      generateImage({
        model: api.provider({ timeoutMs: 100, pollIntervalMs: 10 }).image(),
        prompt: "Mug",
        maxRetries: 0,
      })
    );
    expect(keepsProject()(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a video input upload is cancelled with the call", async () => {
    const api = fakeApi();
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateVideo({
        model: api.provider().video(),
        prompt: { image: png, text: "Animate" },
        abortSignal: controller.signal,
        maxRetries: 0,
      })
    ).rejects.toThrow();
    expect(api.generations()).toHaveLength(0);
  });
});

describe("onProjectCreated", () => {
  test.each(["image", "video"] as const)(
    "receives the accepted %s project before polling starts",
    async (kind) => {
      const api = fakeApi({ statuses: ["complete"], media: mp4 });
      const seen: { id: string; kind: string; pollsSoFar: number }[] = [];
      const provider = api.provider({
        onProjectCreated: (project) => {
          seen.push({ ...project, pollsSoFar: api.polls().length });
        },
      });
      if (kind === "image")
        await generateImage({ model: provider.image(), prompt: "Mug", maxRetries: 0 });
      else await generateVideo({ model: provider.video(), prompt: "Waves", maxRetries: 0 });
      expect(seen).toEqual([{ id: "project-1", kind, pollsSoFar: 0 }]);
    }
  );

  test("is awaited before polling", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    let release!: () => void;
    let accepted!: () => void;
    const saved = new Promise<void>((resolve) => (release = resolve));
    const created = new Promise<void>((resolve) => (accepted = resolve));
    const provider = api.provider({
      onProjectCreated: async () => {
        accepted();
        await saved;
      },
    });
    const run = generateImage({ model: provider.image(), prompt: "Mug", maxRetries: 0 });
    await created;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.polls()).toHaveLength(0);
    release();
    await run;
    expect(api.polls().length).toBeGreaterThan(0);
  });

  test("a failure keeps the project ID and stops before polling", async () => {
    const api = fakeApi();
    const provider = api.provider({
      onProjectCreated: () => {
        throw new Error("database down");
      },
    });
    const error = await rejection(
      generateImage({ model: provider.image(), prompt: "Mug", maxRetries: 3 })
    );
    expect(keepsProject()(error)).toBe(true);
    expect(api.generations()).toHaveLength(1);
    expect(api.polls()).toHaveLength(0);
  });
});

describe("credentials and error contents", () => {
  test("only Magic Hour API requests carry the API key", async () => {
    const api = fakeApi({ media: mp4 });
    await generateVideo({
      model: api.provider().video(),
      prompt: { image: png, text: "Animate" },
      maxRetries: 0,
    });
    for (const call of api.calls)
      expect(call.headers.get("Authorization")).toBe(
        call.url.startsWith(STORAGE) ? null : "Bearer test-key"
      );
  });

  test("custom request headers reach the API but not media storage", async () => {
    const api = fakeApi();
    await generateImage({
      model: api.provider().image(),
      prompt: "Mug",
      headers: { "X-Trace-Id": "trace-1" },
      maxRetries: 0,
    });
    for (const call of [...api.generations(), ...api.polls()])
      expect(call.headers.get("X-Trace-Id")).toBe("trace-1");
    for (const call of api.storage()) expect(call.headers.has("X-Trace-Id")).toBe(false);
  });

  test("API error bodies never appear in error messages", async () => {
    const secret = "signed-url?X-Goog-Signature=secret123";
    for (const options of [
      { createStatus: 400 },
      { createStatus: 500 },
      { projectStatus: 500 },
      { statuses: ["complete"], downloadStatus: 403 },
    ]) {
      const api = fakeApi({ ...options, errorBody: secret });
      const error = await rejection(
        generateImage({ model: api.provider().image(), prompt: "Mug", maxRetries: 0 })
      );
      expect(String((error as Error).message)).not.toContain("secret123");
    }
  });

  test("the API key never appears in error messages", async () => {
    const api = fakeApi({ createStatus: 401 });
    const error = await rejection(
      generateImage({
        model: api.provider({ apiKey: "mhk_live_secret" }).image(),
        prompt: "Mug",
        maxRetries: 0,
      })
    );
    expect(String((error as Error).message)).not.toContain("mhk_live_secret");
  });
});
