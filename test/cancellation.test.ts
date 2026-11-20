// Aborts and deadlines stop work promptly and name the project once it's accepted.
import { execFileSync } from "node:child_process";
import { generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour } from "../src/index.js";
import { fakeApi, isGeneration } from "./fake-api.js";
import {
  abortWhenHeld,
  expectAcceptanceUnknown,
  expectRecoverable,
  isDownload,
  isPoll,
  isUpload,
  isUploadUrlRequest,
  onlyProject,
  rejection,
  type Run,
  runImage,
  runImageVideo,
  runTextVideo,
  underFakeTime,
} from "./helpers.js";

describe("cancellation", () => {
  test("aborting during the upload starts no paid job", async () => {
    const { api, signal } = abortWhenHeld(isUpload);
    await rejection(runImageVideo(api, { abortSignal: signal }));
    expect(api.generations()).toHaveLength(0);
  });

  test("aborting during submission leaves acceptance unknown", async () => {
    const { api, signal } = abortWhenHeld(isGeneration);
    const error = await rejection(runImage(api, { abortSignal: signal }));
    expectAcceptanceUnknown(error);
    expect(api.generations()).toHaveLength(1);
  });

  test("aborting once the acceptance has arrived names the project", async () => {
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
      runImage(api, {
        abortSignal: controller.signal,
        settings: { fetch, onProjectCreated: ({ id }) => void saved.push(id) },
      })
    );
    expectRecoverable(error, onlyProject(api));
    expect(saved).toEqual([onlyProject(api)]);
  });

  test("aborting a poll names the project and stops polling", async () => {
    const { api, signal } = abortWhenHeld(isPoll);
    expectRecoverable(await rejection(runImage(api, { abortSignal: signal })), onlyProject(api));
    expect(api.polls()).toHaveLength(1);
  });

  test("aborting between polls settles at once and leaves no timer", async () => {
    const api = fakeApi({ statuses: ["rendering"] });
    const controller = new AbortController();
    const { error, elapsed } = await underFakeTime(() => {
      setTimeout(() => controller.abort(), 100);
      return runImage(api, {
        settings: { pollIntervalMs: 60_000 },
        abortSignal: controller.signal,
      });
    });
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeLessThan(1000);
    expect(api.polls()).toHaveLength(1);
    // A leftover poll timer would keep a Node process running.
    expect(vi.getTimerCount()).toBe(0);
  });

  test("aborting a download names the project", async () => {
    const { api, signal } = abortWhenHeld(isDownload, { statuses: ["complete"] });
    expectRecoverable(await rejection(runImage(api, { abortSignal: signal })), onlyProject(api));
  });
});

describe("timeoutMs", () => {
  test.each<[string, Run]>([
    ["image", runImage],
    ["image-to-video", runImageVideo],
  ])("%s: is one deadline across upload, submission and waiting", async (_, run) => {
    const api = fakeApi({
      statuses: ["rendering"],
      // Up to 300 ms upload URL + 300 ms upload + 200 ms submission, then polling until 1000 ms.
      delay: (c) => (isUploadUrlRequest(c) || isUpload(c) ? 300 : isGeneration(c) ? 200 : 0),
    });
    const { error, elapsed } = await underFakeTime(() =>
      run(api, { settings: { timeoutMs: 1000, pollIntervalMs: 100 } })
    );
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(1200);
  });

  test("bounds an upload that never answers, and no paid job starts", async () => {
    const api = fakeApi({ hold: isUpload });
    const { error, elapsed } = await underFakeTime(() =>
      runImageVideo(api, { settings: { timeoutMs: 1000 } })
    );
    expect(error).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(1200);
    expect(api.generations()).toHaveLength(0);
  });

  // The response headers have arrived, so a timeout that only covers `fetch()` would hang.
  test("bounds a download whose body stalls, naming the project", async () => {
    const api = fakeApi({
      statuses: [...Array(8).fill("rendering"), "complete"],
      stallBody: (c) => isDownload(c) && (() => {}),
    });
    const { error, elapsed } = await underFakeTime(() =>
      runTextVideo(api, { settings: { timeoutMs: 1000, pollIntervalMs: 100 } })
    );
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeLessThan(1200);
  });

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

  test("defaults to 10 minutes, then names the pending project", async () => {
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
