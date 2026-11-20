// Aborts and deadlines stop work promptly and name the project once it's accepted.
import { execFileSync } from "node:child_process";
import { generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour } from "../src/index.js";
import { fakeApi, type FakeApiOptions, isGeneration } from "./fake-api.js";
import {
  abortWhenHeld,
  endpoints,
  expectAcceptanceUnknown,
  expectNoSecret,
  expectRecoverable,
  isDownload,
  isPoll,
  isUpload,
  isUploadUrlRequest,
  kinds,
  onlyProject,
  rejection,
  runImage,
  runImageVideo,
  runTextVideo,
  underFakeTime,
} from "./helpers.js";

describe("cancellation", () => {
  test.each(endpoints)("%s: an already-aborted call sends nothing", async (_, run) => {
    const api = fakeApi();
    const controller = new AbortController();
    controller.abort(new Error("ABORT_REASON_SECRET"));
    const error = await rejection(run(api, { abortSignal: controller.signal }));
    expectNoSecret(error, "ABORT_REASON_SECRET");
    expect(api.calls).toHaveLength(0);
  });

  test.each(endpoints)(
    "%s: aborting during submission leaves acceptance unknown",
    async (_, run) => {
      const { api, signal } = abortWhenHeld(isGeneration);
      const error = await rejection(run(api, { abortSignal: signal }));
      expectAcceptanceUnknown(error);
      expect(api.generations()).toHaveLength(1);
    }
  );

  test.each([
    ["the upload-URL request", isUploadUrlRequest],
    ["the upload", isUpload],
  ])("aborting during %s starts no paid job", async (_, match) => {
    const { api, signal } = abortWhenHeld(match);
    await rejection(runImageVideo(api, { abortSignal: signal }));
    expect(api.generations()).toHaveLength(0);
  });

  for (const [kind, run] of kinds) {
    test(`${kind}: aborting once the acceptance has arrived names the project`, async () => {
      const api = fakeApi();
      const controller = new AbortController();
      // The whole response is already buffered when the abort comes.
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const response = await api.fetch(input, init);
        if (!isGeneration(api.calls.at(-1)!)) return response;
        const buffered = new Response(await response.arrayBuffer(), response);
        queueMicrotask(() => controller.abort());
        return buffered;
      };
      const saved: string[] = [];
      const error = await rejection(
        run(api, {
          abortSignal: controller.signal,
          settings: { fetch, onProjectCreated: ({ id }) => void saved.push(id) },
        })
      );
      expectRecoverable(error, onlyProject(api));
      expect(saved).toEqual([onlyProject(api)]);
    });

    test(`${kind}: aborting a poll names the project and stops polling`, async () => {
      const { api, signal } = abortWhenHeld(isPoll);
      expectRecoverable(await rejection(run(api, { abortSignal: signal })), onlyProject(api));
      expect(api.polls()).toHaveLength(1);
    });

    test(`${kind}: aborting between polls settles at once and leaves no timer`, async () => {
      const api = fakeApi({ statuses: ["rendering"] });
      const controller = new AbortController();
      const { error, elapsed } = await underFakeTime(() => {
        setTimeout(() => controller.abort(), 100);
        return run(api, { settings: { pollIntervalMs: 60_000 }, abortSignal: controller.signal });
      });
      expectRecoverable(error, onlyProject(api));
      expect(elapsed).toBeLessThan(1000);
      expect(api.polls()).toHaveLength(1);
      // A leftover poll timer would keep a Node process running.
      expect(vi.getTimerCount()).toBe(0);
    });

    test(`${kind}: aborting a download names the project`, async () => {
      const { api, signal } = abortWhenHeld(isDownload, { statuses: ["complete"] });
      expectRecoverable(await rejection(run(api, { abortSignal: signal })), onlyProject(api));
    });

    test(`${kind}: aborting while the download body streams names the project`, async () => {
      const controller = new AbortController();
      const api = fakeApi({
        statuses: ["complete"],
        stallBody: (c) => isDownload(c) && (() => controller.abort()),
      });
      const error = await rejection(run(api, { abortSignal: controller.signal }));
      expectRecoverable(error, onlyProject(api));
    });
  }
});

describe("timeoutMs", () => {
  test("is one deadline across upload, submission and waiting", async () => {
    const api = fakeApi({
      statuses: ["rendering"],
      // 300 ms upload URL + 300 ms upload + 200 ms submission, then polling until 1000 ms.
      delay: (c) => (isUploadUrlRequest(c) || isUpload(c) ? 300 : isGeneration(c) ? 200 : 0),
    });
    const { error, elapsed } = await underFakeTime(() =>
      runImageVideo(api, { settings: { timeoutMs: 1000, pollIntervalMs: 100 } })
    );
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(1200);
  });

  test("doesn't restart for the submission after a slow upload", async () => {
    const api = fakeApi({ delay: (c) => (isUpload(c) ? 300 : 0), hold: isGeneration });
    const { error, elapsed } = await underFakeTime(() =>
      runImageVideo(api, { settings: { timeoutMs: 500 } })
    );
    expectAcceptanceUnknown(error);
    expect(api.generations()).toHaveLength(1);
    expect(elapsed).toBeLessThan(600);
  });

  test("shortens the wait after a slow submission", async () => {
    const api = fakeApi({ statuses: ["rendering"], delay: (c) => (isGeneration(c) ? 400 : 0) });
    const { error, elapsed } = await underFakeTime(() =>
      runImage(api, { settings: { timeoutMs: 500, pollIntervalMs: 50 } })
    );
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeLessThan(600);
  });

  test.each<[string, FakeApiOptions]>([
    [
      "an upload-URL response body that stalls",
      { stallBody: (c) => isUploadUrlRequest(c) && (() => {}) },
    ],
    ["an upload that never answers", { hold: isUpload }],
  ])("bounds %s, and no paid job starts", async (_, options) => {
    const api = fakeApi(options);
    const { error, elapsed } = await underFakeTime(() =>
      runImageVideo(api, { settings: { timeoutMs: 1000 } })
    );
    expect(error).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(1200);
    expect(api.generations()).toHaveLength(0);
  });

  for (const [kind, run] of kinds) {
    test(`${kind}: bounds a poll whose body stalls, naming the project`, async () => {
      const api = fakeApi({ stallBody: (c) => isPoll(c) && (() => {}) });
      const { error, elapsed } = await underFakeTime(() =>
        run(api, { settings: { timeoutMs: 1000 } })
      );
      expectRecoverable(error, onlyProject(api));
      expect(elapsed).toBeLessThan(1200);
    });

    test(`${kind}: bounds a download whose body stalls after most of the time went to polling`, async () => {
      const api = fakeApi({
        statuses: [...Array(8).fill("rendering"), "complete"],
        stallBody: (c) => isDownload(c) && (() => {}),
      });
      const { error, elapsed } = await underFakeTime(() =>
        run(api, { settings: { timeoutMs: 1000, pollIntervalMs: 100 } })
      );
      expectRecoverable(error, onlyProject(api));
      expect(elapsed).toBeLessThan(1200);
    });
  }

  test("still applies when the caller passes its own signal", async () => {
    const api = fakeApi({ statuses: ["rendering"] });
    const { error, elapsed } = await underFakeTime(() =>
      runImage(api, {
        settings: { timeoutMs: 500, pollIntervalMs: 50 },
        abortSignal: new AbortController().signal,
      })
    );
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeLessThan(600);
  });

  test("defaults to 10 minutes: a job finishing just inside succeeds", async () => {
    // 20 polls 29 s apart complete at 551 s.
    const api = fakeApi({ statuses: [...Array(19).fill("rendering"), "complete"] });
    const { error, elapsed } = await underFakeTime(
      () => runImage(api, { settings: { pollIntervalMs: 29_000 } }),
      500
    );
    expect(error).toBeUndefined();
    expect(elapsed).toBeGreaterThan(550_000);
  });

  test("defaults to 10 minutes: a job still pending then names its project", async () => {
    const api = fakeApi({ statuses: ["rendering"] });
    const { error, elapsed } = await underFakeTime(
      () => runTextVideo(api, { settings: { pollIntervalMs: 30_000 } }),
      500
    );
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeGreaterThanOrEqual(600_000);
    expect(elapsed).toBeLessThan(601_000);
  });
});

describe("polling", () => {
  test("waits pollIntervalMs between polls", async () => {
    const api = fakeApi({ statuses: ["rendering", "rendering", "complete"] });
    vi.useFakeTimers();
    const run = runImage(api, { settings: { pollIntervalMs: 1000 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.polls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(api.polls()).toHaveLength(3);
  });

  test("waits 2 seconds between polls by default", async () => {
    const api = fakeApi({ statuses: ["rendering", "rendering", "complete"] });
    vi.useFakeTimers();
    // Not api.provider(), which sets pollIntervalMs: 0 to keep other tests fast.
    const model = createMagicHour({ apiKey: "test-key", fetch: api.fetch }).image();
    const run = generateImage({ model, prompt: "Mug", maxRetries: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(api.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.polls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    await run;
  });

  test("in a real Node process, finished calls leave nothing keeping it alive", () => {
    // Otherwise a script or serverless function would hang until the 10-minute deadline.
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", new URL("./scripts/clean-exit.ts", import.meta.url).pathname],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(output.trim().split("\n")).toEqual(["done=2", "failed=image-1-63z"]);
  }, 30_000);
});
