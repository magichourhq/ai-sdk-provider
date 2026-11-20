// Once the API accepts a job it's paid for, so every later failure must name the project. The
// caller can then resume it instead of paying again.
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { fakeApi, type FakeApiOptions } from "./fake-api.js";
import {
  expectRecoverable,
  failingFetch,
  isDownload,
  isPoll,
  kinds,
  latch,
  onlyProject,
  rejection,
  runImage,
  runTextVideo,
  underFakeTime,
} from "./helpers.js";

describe("failures after acceptance name the project", () => {
  test.each<[string, FakeApiOptions]>([
    ["an error project", { statuses: ["rendering", "error"] }],
    ["an unknown project status", { statuses: ["exploded"] }],
    ["a failed poll", { projectStatus: 500 }],
    ["a complete project without downloads", { statuses: ["complete"], downloads: () => [] }],
    [
      "a download URL that isn't HTTPS",
      {
        statuses: ["complete"],
        downloads: (p) => [{ url: p.url.replace("https:", "http:"), expires_at: "2099-01-01" }],
      },
    ],
    ["a failed download", { statuses: ["complete"], downloadStatus: 403 }],
    ["a download that breaks partway", { statuses: ["complete"], breakBody: isDownload }],
    // Without a check, the next two would return an empty or cut-off file as a success.
    ["an empty download", { statuses: ["complete"], emptyDownload: true }],
    ["an unrequested partial download (206)", { statuses: ["complete"], partialDownload: true }],
  ])("%s", async (_, options) => {
    const api = fakeApi(options);
    const error = await rejection(runImage(api));
    expectRecoverable(error, onlyProject(api));
    expect(api.generations()).toHaveLength(1);
    expect(api.calls.some((c) => c.url.startsWith("http://"))).toBe(false);
  });

  test.each([
    ["poll", isPoll],
    ["download", isDownload],
  ])("a network failure on the %s", async (_, match) => {
    const api = fakeApi({ statuses: ["complete"] });
    const fetch = failingFetch(api, match, () => new TypeError("read ECONNRESET"));
    const error = await rejection(runImage(api, { settings: { fetch } }));
    expectRecoverable(error, onlyProject(api));
    expect(api.generations()).toHaveLength(1);
  });

  // Polling is shared with images. Video has its own handling of the finished project.
  test.each<[string, FakeApiOptions]>([
    ["a complete project without downloads", { statuses: ["complete"], downloads: () => [] }],
    ["a failed download", { statuses: ["complete"], downloadStatus: 403 }],
  ])("video: %s", async (_, options) => {
    const api = fakeApi(options);
    const error = await rejection(runTextVideo(api));
    expectRecoverable(error, onlyProject(api));
    expect(api.generations()).toHaveLength(1);
  });
});

describe("onProjectCreated", () => {
  test.each(kinds)("%s: receives the accepted project before polling starts", async (kind, run) => {
    const api = fakeApi({ statuses: ["complete"] });
    const seen: { id: string; kind: string; pollsSoFar: number }[] = [];
    await run(api, {
      settings: {
        onProjectCreated: (project) =>
          void seen.push({ ...project, pollsSoFar: api.polls().length }),
      },
    });
    expect(seen).toEqual([{ id: onlyProject(api), kind, pollsSoFar: 0 }]);
  });

  test("is awaited before polling", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    const save = latch();
    const created = latch();
    const run = runImage(api, {
      settings: {
        onProjectCreated: async () => {
          created.release();
          await save.promise;
        },
      },
    });
    await created.promise;
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(api.polls()).toHaveLength(0);
    save.release();
    await run;
    expect(api.polls().length).toBeGreaterThan(0);
  });

  test.each([
    [
      "throws",
      () => {
        throw new Error("database down");
      },
    ],
    ["rejects", async () => Promise.reject(new Error("database down"))],
  ])("a save that %s names the project and stops before polling", async (_, save) => {
    const api = fakeApi();
    const error = await rejection(runImage(api, { settings: { onProjectCreated: save } }));
    expectRecoverable(error, onlyProject(api));
    expect(api.polls()).toHaveLength(0);
  });

  test("a save that never finishes names the project at timeoutMs", async () => {
    const api = fakeApi();
    const { error, elapsed } = await underFakeTime(() =>
      runImage(api, {
        settings: { timeoutMs: 1000, onProjectCreated: () => new Promise<void>(() => {}) },
      })
    );
    expectRecoverable(error, onlyProject(api));
    expect(api.polls()).toHaveLength(0);
    expect(elapsed).toBeLessThan(1200);
  });

  test("in a real Node process, a save that never finishes still delivers the project ID", () => {
    // Fake timers can't show this: Node exits early once nothing keeps it alive.
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", new URL("./scripts/hanging-save.ts", import.meta.url).pathname],
      { encoding: "utf8", timeout: 20_000 }
    );
    expect(output.trim()).toBe("projectId=image-77-hang");
  }, 30_000);
});

describe("formatMessage", () => {
  test("translates errors, including the project ID in the recovery guidance", async () => {
    const api = fakeApi({ statuses: ["error"] });
    const error = await rejection(
      runImage(api, {
        settings: {
          formatMessage: (message, values) =>
            `[t] ${message.defaultMessage.replace(/\{(\w+)\}/g, (_, k) => String(values?.[k]))}`,
        },
      })
    );
    expect((error as Error).message).toMatch(/^\[t\] /);
    expect((error as Error).message).toContain(onlyProject(api));
  });

  test("a formatMessage that throws still names the project", async () => {
    const api = fakeApi({ statuses: ["error"] });
    const error = await rejection(
      runImage(api, {
        settings: {
          formatMessage: () => {
            throw new Error("translation missing");
          },
        },
      })
    );
    expectRecoverable(error, onlyProject(api));
  });
});
