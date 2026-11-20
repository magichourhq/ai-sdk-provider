// Once the API accepts a job it's paid for, so every later failure must name the project. The
// caller can then resume it instead of paying again.
import { execFileSync } from "node:child_process";
import { generateImage } from "ai";
import { describe, expect, test } from "vitest";
import type { MagicHourSettings } from "../src/index.js";
import { fakeApi, type FakeApiOptions } from "./fake-api.js";
import {
  endpoints,
  expectNoSecret,
  expectRecoverable,
  failingFetch,
  isDownload,
  isPoll,
  kinds,
  latch,
  onlyProject,
  rejection,
  runImage,
  runImageVideo,
  underFakeTime,
} from "./helpers.js";

describe("failures after acceptance name the project", () => {
  const failures: [string, FakeApiOptions][] = [
    ["an error project", { statuses: ["rendering", "error"] }],
    ["a canceled project", { statuses: ["rendering", "canceled"] }],
    ["an unknown project status", { statuses: ["exploded"] }],
    ["a failed poll", { projectStatus: 500 }],
    [
      "a poll that returns HTML",
      {
        pollResponse: () =>
          new Response("<html>Bad gateway</html>", { headers: { "Content-Type": "text/html" } }),
      },
    ],
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
    ["an empty download (204)", { statuses: ["complete"], downloadStatus: 204 }],
    ["an empty download (200)", { statuses: ["complete"], emptyDownload: true }],
    ["an unrequested partial download (206)", { statuses: ["complete"], partialDownload: true }],
  ];

  for (const [kind, run] of kinds)
    describe(kind, () => {
      test.each(failures)("%s", async (_, options) => {
        const api = fakeApi(options);
        const error = await rejection(run(api));
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
        const error = await rejection(run(api, { settings: { fetch } }));
        expectRecoverable(error, onlyProject(api));
        expect(api.generations()).toHaveLength(1);
      });

      test("a render error, without showing the server's message", async () => {
        const api = fakeApi({
          statuses: ["error"],
          projectError: { message: "internal token tk_SECRET_123 leaked", code: "internal" },
        });
        const error = await rejection(run(api));
        expectRecoverable(error, onlyProject(api));
        expectNoSecret(error, "tk_SECRET_123");
      });
    });
});

describe("onProjectCreated", () => {
  test.each(endpoints)(
    "%s: receives the accepted project before polling starts",
    async (endpoint, run) => {
      const api = fakeApi({ statuses: ["complete"] });
      const seen: { id: string; kind: string; pollsSoFar: number }[] = [];
      await run(api, {
        settings: {
          onProjectCreated: (project) =>
            void seen.push({ ...project, pollsSoFar: api.polls().length }),
        },
      });
      const kind = endpoint === "ai-image-generator" ? "image" : "video";
      expect(seen).toEqual([{ id: onlyProject(api), kind, pollsSoFar: 0 }]);
    }
  );

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

  test("n jobs each save their own project before it's polled", async () => {
    const api = fakeApi({ statuses: ["rendering", "complete"] });
    const saved: { id: string; polled: boolean }[] = [];
    const settings: MagicHourSettings = {
      onProjectCreated: ({ id }) => {
        saved.push({ id, polled: api.polls().some((c) => c.url.endsWith(`/${id}`)) });
      },
    };
    await generateImage({ model: api.provider(settings).image(), prompt: "Mug", n: 2 });
    expect(saved.map((s) => s.id).sort()).toEqual(
      api
        .projects()
        .map((p) => p.id)
        .sort()
    );
    expect(saved.every((s) => !s.polled)).toBe(true);
  });

  for (const [kind, run] of kinds) {
    test.each([
      [
        "throws",
        () => {
          throw new Error("database down SAVE_SECRET_7");
        },
      ],
      ["rejects", async () => Promise.reject(new Error("database down SAVE_SECRET_7"))],
    ])(`${kind}: a save that %s names the project and stops before polling`, async (_, save) => {
      const api = fakeApi();
      const error = await rejection(run(api, { settings: { onProjectCreated: save } }));
      expectRecoverable(error, onlyProject(api));
      expectNoSecret(error, "SAVE_SECRET_7");
      expect(api.polls()).toHaveLength(0);
    });

    test(`${kind}: a save that never finishes names the project at timeoutMs`, async () => {
      const api = fakeApi();
      const { error, elapsed } = await underFakeTime(() =>
        run(api, {
          settings: { timeoutMs: 1000, onProjectCreated: () => new Promise<void>(() => {}) },
        })
      );
      expectRecoverable(error, onlyProject(api));
      expect(api.polls()).toHaveLength(0);
      expect(elapsed).toBeLessThan(1200);
    });

    test(`${kind}: aborting while a save hangs names the project right away`, async () => {
      const api = fakeApi();
      const controller = new AbortController();
      const { error, elapsed } = await underFakeTime(() =>
        run(api, {
          abortSignal: controller.signal,
          settings: {
            onProjectCreated: () => {
              controller.abort();
              return new Promise<void>(() => {});
            },
          },
        })
      );
      expectRecoverable(error, onlyProject(api));
      expect(api.polls()).toHaveLength(0);
      expect(elapsed).toBeLessThan(100);
    });
  }

  test("a save that never finishes gets only what's left of timeoutMs after a slow upload", async () => {
    const api = fakeApi({ delay: (c) => (c.method === "PUT" ? 600 : 0) });
    const { error, elapsed } = await underFakeTime(() =>
      runImageVideo(api, {
        settings: { timeoutMs: 1000, onProjectCreated: () => new Promise<void>(() => {}) },
      })
    );
    expectRecoverable(error, onlyProject(api));
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
  test.each(kinds)("%s: a formatMessage that throws still names the project", async (_, run) => {
    const api = fakeApi({ statuses: ["error"] });
    const error = await rejection(
      run(api, {
        settings: {
          formatMessage: () => {
            throw new Error("translation missing");
          },
        },
      })
    );
    expectRecoverable(error, onlyProject(api));
  });

  test("translates errors, including the project ID in the recovery guidance", async () => {
    const api = fakeApi({ statuses: ["error"] });
    const seen: (Record<string, string | number> | undefined)[] = [];
    const error = await rejection(
      runImage(api, {
        settings: {
          formatMessage: (message, values) => {
            seen.push(values);
            const text = message.defaultMessage.replace(/\{(\w+)\}/g, (_, k) =>
              String(values?.[k])
            );
            return `[t] ${text}`;
          },
        },
      })
    );
    const projectId = onlyProject(api);
    expect((error as Error).message).toMatch(/^\[t\] /);
    expect((error as Error).message).toContain(projectId);
    expect(seen).toContainEqual(expect.objectContaining({ projectId }));
  });

  test("receives the HTTP status of a rejected submission", async () => {
    const api = fakeApi({ createStatus: 402 });
    const seen: unknown[] = [];
    const error = await rejection(
      runImage(api, {
        settings: {
          formatMessage: (message, values) => {
            seen.push(values);
            return `[t] ${message.defaultMessage}`;
          },
        },
      })
    );
    expect((error as Error).message).toMatch(/^\[t\] /);
    expect(seen).toContainEqual({ status: 402 });
  });
});
