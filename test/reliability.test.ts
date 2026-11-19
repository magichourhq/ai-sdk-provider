import { inspect } from "node:util";
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MagicHourError, type MagicHourSettings } from "../src/index.js";
import {
  API,
  type Call,
  fakeApi,
  type FakeApiOptions,
  isGeneration,
  png,
  STORAGE,
} from "./fake-api.js";

afterEach(() => {
  vi.useRealTimers();
});

type Api = ReturnType<typeof fakeApi>;
type RunOptions = {
  settings?: MagicHourSettings;
  abortSignal?: AbortSignal;
  maxRetries?: number;
  headers?: Record<string, string>;
};
type Run = (api: Api, options?: RunOptions) => Promise<unknown>;

const runImage: Run = (api, { settings, abortSignal, maxRetries = 3, headers } = {}) =>
  generateImage({
    model: api.provider(settings).image(),
    prompt: "Mug",
    abortSignal,
    maxRetries,
    headers,
  });
const runTextVideo: Run = (api, { settings, abortSignal, maxRetries = 3, headers } = {}) =>
  generateVideo({
    model: api.provider(settings).video(),
    prompt: "Waves",
    abortSignal,
    maxRetries,
    headers,
  });
const runImageVideo: Run = (api, { settings, abortSignal, maxRetries = 3, headers } = {}) =>
  generateVideo({
    model: api.provider(settings).video(),
    prompt: { image: png, text: "Animate" },
    abortSignal,
    maxRetries,
    headers,
  });

/** Each paid endpoint, started through the AI SDK, with the project kind it creates. */
const endpoints: [endpoint: string, run: Run, kind: "image" | "video"][] = [
  ["ai-image-generator", runImage, "image"],
  ["text-to-video", runTextVideo, "video"],
  ["image-to-video", runImageVideo, "video"],
];

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
}

/** Asserts the error names the given accepted project, so the caller can resume it. */
function expectRecoverable(error: unknown, projectId: string) {
  expect(error).toBeInstanceOf(MagicHourError);
  expect((error as MagicHourError).name).toBe("MagicHourError");
  expect((error as MagicHourError).projectId).toBe(projectId);
  expect((error as MagicHourError).isRetryable).toBe(false);
  expect((error as MagicHourError).message).toContain(projectId);
}

/** The only project the fake accepted. */
function onlyProject(api: Api): string {
  expect(api.projects()).toHaveLength(1);
  return api.projects()[0].id;
}

/** Asserts a submission whose outcome is unknown: no project ID, so nothing to resume. */
function expectAcceptanceUnknown(error: unknown) {
  expect(error).toBeInstanceOf(MagicHourError);
  expect((error as MagicHourError).isRetryable).toBe(false);
  expect((error as MagicHourError).projectId).toBeUndefined();
  expect((error as Error).message).toMatch(/Acceptance is unknown/);
}

const isDownload = (c: Call) => c.method === "GET" && c.url.startsWith(STORAGE);
const isPoll = (c: Call) => /-projects\//.test(c.url);

/** Asserts the secret appears nowhere a caller or a log could see it, including causes. */
function expectNoSecret(error: unknown, secret: string) {
  expect(inspect(error, { depth: 10 })).not.toContain(secret);
  for (let e: unknown = error, depth = 0; e && depth < 10; e = (e as Error).cause, depth++) {
    expect(String((e as Error).message ?? e)).not.toContain(secret);
    expect(String((e as Error).stack ?? "")).not.toContain(secret);
  }
}

/** Runs a call to completion under fake timers and reports the virtual time it took. */
async function underFakeTime(start: () => Promise<unknown>, step = 5) {
  vi.useFakeTimers();
  const began = Date.now();
  let settled = false;
  const outcome = start().then(
    (value): { value?: unknown; error?: unknown } => ({ value }),
    (error: unknown) => ({ error })
  );
  outcome.finally(() => (settled = true));
  for (let i = 0; i < 100_000 && !settled; i++) await vi.advanceTimersByTimeAsync(step);
  expect(settled).toBe(true);
  return { ...(await outcome), elapsed: Date.now() - began };
}

describe("paid generations are never retried", () => {
  const rejected = [400, 401, 402, 403, 404, 409, 422, 425, 429];
  const ambiguous = [408, 500, 502, 503, 504];

  for (const [endpoint, run] of endpoints) {
    describe(endpoint, () => {
      test.each(rejected)("HTTP %i is a rejection: one request, status kept", async (status) => {
        const api = fakeApi({ createStatus: status });
        const error = await rejection(run(api));
        expect(api.generations()).toHaveLength(1);
        expect(api.generations()[0].url).toBe(`${API}/v1/${endpoint}`);
        expect(error).toBeInstanceOf(MagicHourError);
        expect((error as MagicHourError).isRetryable).toBe(false);
        expect((error as MagicHourError).status).toBe(status);
        expect((error as MagicHourError).projectId).toBeUndefined();
        expect((error as Error).message).not.toMatch(/Acceptance is unknown/);
      });

      test.each(ambiguous)(
        "HTTP %i leaves acceptance unknown: one request, status kept",
        async (status) => {
          const api = fakeApi({ createStatus: status });
          const error = await rejection(run(api));
          expect(api.generations()).toHaveLength(1);
          expectAcceptanceUnknown(error);
          expect((error as MagicHourError).status).toBe(status);
        }
      );

      test("a dropped connection leaves acceptance unknown and isn't retried", async () => {
        const api = fakeApi({ createNetworkError: true });
        const error = await rejection(run(api));
        expect(api.generations()).toHaveLength(1);
        expectAcceptanceUnknown(error);
      });

      test.each([
        ["the same endpoint", `${API}/v1/${endpoint}`],
        ["another origin", `https://attacker.example/v1/${endpoint}`],
      ])("a redirect to %s is never followed, so the POST isn't replayed", async (_, to) => {
        const api = fakeApi({ redirect: (c) => (isGeneration(c) ? to : undefined) });
        const error = await rejection(run(api));
        const posts = api.calls.filter((c) => c.method === "POST" && c.url.endsWith(endpoint));
        expect(posts).toHaveLength(1);
        expect(api.projects()).toHaveLength(0);
        expect(api.calls.some((c) => c.url.startsWith("https://attacker.example"))).toBe(false);
        expectAcceptanceUnknown(error);
      });
    });
  }

  test.each(endpoints)(
    "%s: a submission response that breaks partway leaves acceptance unknown",
    async (_, run) => {
      const api = fakeApi({ breakBody: isGeneration });
      const error = await rejection(run(api));
      expect(api.generations()).toHaveLength(1);
      expectAcceptanceUnknown(error);
    }
  );

  test.each(endpoints)(
    "%s: a submission response whose body stalls is bounded by timeoutMs",
    async (_, run) => {
      const api = fakeApi({ stallBody: (c) => isGeneration(c) && (() => {}) });
      const { error, elapsed } = await underFakeTime(() =>
        run(api, { settings: { timeoutMs: 1000 } })
      );
      expect(api.generations()).toHaveLength(1);
      expectAcceptanceUnknown(error);
      expect(elapsed).toBeLessThan(1200);
    }
  );

  test.each<[string, () => Response]>([
    ["no project ID", () => Response.json({ credits_charged: 5 })],
    ["an empty project ID", () => Response.json({ id: "" })],
    ["a non-string project ID", () => Response.json({ id: 42 })],
    ["a JSON string body", () => Response.json("project-1")],
    [
      "malformed JSON",
      () =>
        new Response('{"id": "project-1", "note": "MALFORMED_SENTINEL', {
          headers: { "Content-Type": "application/json" },
        }),
    ],
  ])("an accepted response with %s fails without resubmitting", async (_, createResponse) => {
    const api = fakeApi({ createResponse });
    const error = await rejection(runImage(api));
    expect(error).toBeInstanceOf(MagicHourError);
    expect((error as Error).message).not.toContain("MALFORMED_SENTINEL");
    expect(api.generations()).toHaveLength(1);
    expect(api.polls()).toHaveLength(0);
  });
});

describe("failures after acceptance name the accepted project", () => {
  const cases: [string, FakeApiOptions][] = [
    ["an error project", { statuses: ["rendering", "error"] }],
    ["a canceled project", { statuses: ["rendering", "canceled"] }],
    ["an unknown project status", { statuses: ["exploded"] }],
    ["a complete project without downloads", { statuses: ["complete"], downloads: () => [] }],
    [
      "a download URL that isn't HTTPS",
      {
        statuses: ["complete"],
        downloads: (p) => [{ url: p.url.replace("https:", "http:"), expires_at: "2099-01-01" }],
      },
    ],
    ["a failed poll", { projectStatus: 500 }],
    ["a missing project", { projectStatus: 404 }],
    [
      "a poll that returns HTML",
      {
        pollResponse: () =>
          new Response("<html>Bad gateway</html>", { headers: { "Content-Type": "text/html" } }),
      },
    ],
    ["a poll that returns null", { pollResponse: () => Response.json(null) }],
    ["a failed download", { statuses: ["complete"], downloadStatus: 403 }],
    ["a download with no content (204)", { statuses: ["complete"], downloadStatus: 204 }],
    ["an empty download (200)", { statuses: ["complete"], emptyDownload: true }],
  ];

  for (const [endpoint, run] of endpoints)
    describe(endpoint, () => {
      test.each(cases)("%s", async (_, options) => {
        const api = fakeApi(options);
        const error = await rejection(run(api));
        expectRecoverable(error, onlyProject(api));
        expect(api.generations()).toHaveLength(1);
        expect(api.calls.some((c) => c.url.startsWith("http://"))).toBe(false);
      });

      test("a render error's server message is not shown to the caller", async () => {
        const api = fakeApi({
          statuses: ["error"],
          projectError: { message: "internal token tk_SECRET_123 leaked", code: "internal" },
        });
        const error = await rejection(run(api));
        expectRecoverable(error, onlyProject(api));
        expect((error as Error).message).not.toContain("tk_SECRET_123");
      });

      test("when the second of two jobs fails, the error names the second project", async () => {
        const api = fakeApi({
          statusesFor: (n) => (n === 2 ? ["rendering", "error"] : ["complete"]),
        });
        await run(api);
        const error = await rejection(run(api));
        expect(api.projects()).toHaveLength(2);
        expectRecoverable(error, api.projects()[1].id);
        expect((error as Error).message).not.toContain(api.projects()[0].id);
      });

      test("when overlapping jobs finish out of order, the failure names its own project", async () => {
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

      test("a poll whose response body stalls names the project at the deadline", async () => {
        const api = fakeApi({ stallBody: (c) => isPoll(c) && (() => {}) });
        const { error, elapsed } = await underFakeTime(() =>
          run(api, { settings: { timeoutMs: 1000 } })
        );
        expectRecoverable(error, onlyProject(api));
        expect(elapsed).toBeLessThan(1200);
      });
    });
});

describe("cancellation", () => {
  /** Holds the first matching request open and aborts the call once it's in flight. */
  function abortWhenHeld(match: (call: Call) => boolean, options: FakeApiOptions = {}) {
    const controller = new AbortController();
    const api = fakeApi({
      ...options,
      hold: (call) => {
        if (!match(call)) return false;
        queueMicrotask(() => controller.abort());
        return true;
      },
    });
    return { api, signal: controller.signal };
  }
  test("an already-aborted signal sends nothing", async () => {
    const api = fakeApi();
    const controller = new AbortController();
    controller.abort();
    await expect(runImage(api, { abortSignal: controller.signal })).rejects.toThrow();
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

  for (const [endpoint, run] of endpoints) {
    test(`${endpoint}: aborting an in-flight poll names the project and stops polling`, async () => {
      const { api, signal } = abortWhenHeld(isPoll);
      expectRecoverable(await rejection(run(api, { abortSignal: signal })), onlyProject(api));
      expect(api.polls()).toHaveLength(1);
    });

    test(`${endpoint}: aborting an in-flight download names the project`, async () => {
      const { api, signal } = abortWhenHeld(
        (c) => c.method === "GET" && c.url.startsWith(STORAGE),
        { statuses: ["complete"] }
      );
      expectRecoverable(await rejection(run(api, { abortSignal: signal })), onlyProject(api));
    });

    test(`${endpoint}: aborting while the download body streams names the project`, async () => {
      const controller = new AbortController();
      const api = fakeApi({
        statuses: ["complete"],
        stallBody: (c) => isDownload(c) && (() => controller.abort()),
      });
      expectRecoverable(
        await rejection(run(api, { abortSignal: controller.signal })),
        onlyProject(api)
      );
    });

    test(`${endpoint}: aborting between polls settles without waiting out the interval`, async () => {
      const api = fakeApi({ statuses: ["rendering"] });
      const controller = new AbortController();
      const { error, elapsed } = await underFakeTime(() => {
        setTimeout(() => controller.abort(), 100);
        return run(api, { settings: { pollIntervalMs: 60_000 }, abortSignal: controller.signal });
      });
      expectRecoverable(error, onlyProject(api));
      expect(elapsed).toBeLessThan(1000);
      expect(api.polls()).toHaveLength(1);
    });
  }

  test.each(endpoints)("%s: aborting right after acceptance names the project", async (_, run) => {
    const controller = new AbortController();
    const api = fakeApi();
    const error = await rejection(
      run(api, {
        abortSignal: controller.signal,
        settings: { onProjectCreated: () => controller.abort() },
      })
    );
    expectRecoverable(error, onlyProject(api));
    expect(api.generations()).toHaveLength(1);
  });

  test("aborting an in-flight upload starts no paid job", async () => {
    const { api, signal } = abortWhenHeld((c) => c.method === "PUT");
    await expect(runImageVideo(api, { abortSignal: signal })).rejects.toThrow();
    expect(api.generations()).toHaveLength(0);
  });

  test("aborting during the upload-URL request starts no paid job", async () => {
    const { api, signal } = abortWhenHeld((c) => c.url.endsWith("/files/upload-urls"));
    await expect(runImageVideo(api, { abortSignal: signal })).rejects.toThrow();
    expect(api.generations()).toHaveLength(0);
  });
});

describe("redirects and cookies", () => {
  test.each<[string, (c: Call) => boolean]>([
    ["a project poll", (c) => /-projects\//.test(c.url)],
    ["the upload-URL request", (c) => c.url.endsWith("/files/upload-urls")],
  ])("a cross-origin redirect on %s is never followed", async (_, match) => {
    const api = fakeApi({
      redirect: (c) => (match(c) ? "https://attacker.example/steal" : undefined),
    });
    await expect(runImageVideo(api)).rejects.toThrow();
    expect(api.calls.some((c) => c.url.startsWith("https://attacker.example"))).toBe(false);
    expect(api.generations().length).toBeLessThanOrEqual(1);
  });

  test("storage requests never send cookies", async () => {
    const api = fakeApi();
    await runImageVideo(api);
    expect(api.storage().length).toBeGreaterThan(1);
    for (const call of api.storage()) expect(call.credentials).toBe("omit");
  });
});

describe("timing", () => {
  test("polls at pollIntervalMs", async () => {
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

  test("timeoutMs is one deadline across upload, submission and waiting", async () => {
    const api = fakeApi({
      statuses: ["rendering"],
      // 600 ms upload + 200 ms submission, then polling until the shared 1000 ms deadline.
      delay: (c) => (c.method === "PUT" ? 600 : isGeneration(c) ? 200 : 0),
    });
    const { error, elapsed } = await underFakeTime(() =>
      runImageVideo(api, { settings: { timeoutMs: 1000, pollIntervalMs: 100 } })
    );
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(1200);
  });

  test.each(endpoints)(
    "%s: the shared deadline still applies to a download body that stalls",
    async (_, run) => {
      // Polling uses most of the 1000 ms deadline, then the download body never finishes.
      const api = fakeApi({
        statuses: [...Array(8).fill("rendering"), "complete"],
        stallBody: (c) => isDownload(c) && (() => {}),
      });
      const { error, elapsed } = await underFakeTime(() =>
        run(api, { settings: { timeoutMs: 1000, pollIntervalMs: 100 } })
      );
      expectRecoverable(error, onlyProject(api));
      expect(elapsed).toBeLessThan(1200);
    }
  );

  test.each(endpoints)(
    "%s: without timeoutMs, a job finishing just inside 10 minutes succeeds",
    async (_, run) => {
      // 20 polls 29 s apart complete at 551 s, inside the 600 s default deadline.
      const api = fakeApi({ statuses: [...Array(19).fill("rendering"), "complete"] });
      const { error, elapsed } = await underFakeTime(
        () => run(api, { settings: { pollIntervalMs: 29_000 } }),
        500
      );
      expect(error).toBeUndefined();
      expect(elapsed).toBeGreaterThan(550_000);
    }
  );

  test("without timeoutMs, a job still pending at 10 minutes names its project", async () => {
    const api = fakeApi({ statuses: ["rendering"] });
    const { error, elapsed } = await underFakeTime(
      () => runTextVideo(api, { settings: { pollIntervalMs: 30_000 } }),
      500
    );
    expectRecoverable(error, onlyProject(api));
    expect(elapsed).toBeGreaterThanOrEqual(600_000);
    expect(elapsed).toBeLessThan(631_000);
  });

  test("timeoutMs also bounds a call whose caller passes its own signal", async () => {
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
});

describe("onProjectCreated", () => {
  for (const [endpoint, run, kind] of endpoints) {
    test(`${endpoint}: receives the accepted ${kind} project before polling starts`, async () => {
      const api = fakeApi({ statuses: ["complete"] });
      const seen: { id: string; kind: string; pollsSoFar: number }[] = [];
      await run(api, {
        settings: {
          onProjectCreated: (project) => {
            seen.push({ ...project, pollsSoFar: api.polls().length });
          },
        },
      });
      expect(seen).toEqual([{ id: onlyProject(api), kind, pollsSoFar: 0 }]);
    });

    test.each([
      [
        "throws",
        () => {
          throw new Error("database down");
        },
      ],
      ["rejects", async () => Promise.reject(new Error("database down"))],
    ])(
      `${endpoint}: a save that %s names the project and stops before polling`,
      async (_, save) => {
        const api = fakeApi();
        const error = await rejection(run(api, { settings: { onProjectCreated: save } }));
        expectRecoverable(error, onlyProject(api));
        expect(api.polls()).toHaveLength(0);
      }
    );

    test(`${endpoint}: a save that never finishes is bounded by timeoutMs`, async () => {
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
  }

  test("is awaited before polling", async () => {
    const api = fakeApi({ statuses: ["complete"] });
    let release!: () => void;
    let accepted!: () => void;
    const saved = new Promise<void>((resolve) => (release = resolve));
    const created = new Promise<void>((resolve) => (accepted = resolve));
    const run = runImage(api, {
      settings: {
        onProjectCreated: async () => {
          accepted();
          await saved;
        },
      },
    });
    await created;
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(api.polls()).toHaveLength(0);
    release();
    await run;
    expect(api.polls().length).toBeGreaterThan(0);
  });
});

describe("custom messages", () => {
  test.each(endpoints)(
    "%s: a formatMessage that throws still names the accepted project",
    async (_, run) => {
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
    }
  );

  test("formatMessage translates errors, including the recovery guidance", async () => {
    const api = fakeApi({ statuses: ["error"] });
    const seen: { id?: string; values?: Record<string, string | number> }[] = [];
    const error = await rejection(
      runImage(api, {
        settings: {
          formatMessage: (message, values) => {
            seen.push({ id: message.id, values });
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
    expect(seen).toContainEqual(
      expect.objectContaining({ values: expect.objectContaining({ projectId }) })
    );
  });

  test("formatMessage receives the HTTP status of a rejected submission", async () => {
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

describe("credentials and error contents", () => {
  const key = "mh_test_KEY_8f2a91";

  test.each(endpoints)(
    "%s: the key only goes to the API, never off-origin in any header, URL or body",
    async (_, run) => {
      const api = fakeApi();
      await run(api, { settings: { apiKey: key } });
      for (const call of api.calls.filter((c) => new URL(c.url).origin === API))
        expect(call.headers.get("Authorization")).toBe(`Bearer ${key}`);
      expect(api.offOrigin().length).toBeGreaterThan(0);
      for (const call of api.offOrigin()) {
        expect(call.url).not.toContain(key);
        for (const [, value] of call.headers) expect(value).not.toContain(key);
        const body =
          call.body instanceof Uint8Array
            ? Buffer.from(call.body).toString("latin1")
            : JSON.stringify(call.body ?? "");
        expect(body).not.toContain(key);
      }
    }
  );

  test.each<[string, FakeApiOptions]>([
    ["an error project", { statuses: ["error"] }],
    ["a failed poll", { projectStatus: 500 }],
    ["a failed download", { statuses: ["complete"], downloadStatus: 403 }],
    ["a failed upload", { uploadStatus: 403 }],
    ["a failed upload-URL request", { uploadUrlsStatus: 500 }],
  ])("the key stays on the API after %s", async (_, options) => {
    const api = fakeApi(options);
    await rejection(runImageVideo(api, { settings: { apiKey: key } }));
    for (const call of api.offOrigin()) {
      expect(call.headers.has("Authorization")).toBe(false);
      expect(call.url).not.toContain(key);
      for (const [, value] of call.headers) expect(value).not.toContain(key);
    }
  });

  test("two providers with different keys running at once each use their own key", async () => {
    const api = fakeApi({ statuses: ["queued", "rendering", "rendering", "complete"] });
    const keys = ["key-tenant-a", "key-tenant-b"];
    await Promise.all(
      keys.map((apiKey, i) =>
        generateImage({
          model: api.provider({ apiKey }).image(),
          prompt: `Tenant ${i}`,
          maxRetries: 0,
        })
      )
    );
    expect(api.projects()).toHaveLength(2);
    api.generations().forEach((call, i) => {
      const keyUsed = call.headers.get("Authorization");
      const tenant = Number(call.body.style.prompt.replace("Tenant ", ""));
      expect(keyUsed).toBe(`Bearer ${keys[tenant]}`);
      const project = api.projects()[i].id;
      for (const poll of api.polls().filter((c) => c.url.endsWith(`/${project}`)))
        expect(poll.headers.get("Authorization")).toBe(keyUsed);
    });
  });

  test.each(endpoints)(
    "%s: a caller's Authorization header can't replace the configured key",
    async (_, run) => {
      const api = fakeApi();
      await run(api, {
        settings: { apiKey: key },
        headers: { authorization: "Bearer someone-elses-key" },
      });
      const apiCalls = api.calls.filter((c) => new URL(c.url).origin === API);
      expect(apiCalls.length).toBeGreaterThan(1);
      for (const call of apiCalls) expect(call.headers.get("Authorization")).toBe(`Bearer ${key}`);
      for (const call of api.offOrigin()) expect(call.headers.has("Authorization")).toBe(false);
    }
  );

  test.each(endpoints)("%s: custom headers reach the API but not storage", async (_, run) => {
    const api = fakeApi();
    await run(api, { headers: { "X-Trace-Id": "trace-1" } });
    for (const call of [...api.generations(), ...api.polls()])
      expect(call.headers.get("X-Trace-Id")).toBe("trace-1");
    expect(api.polls().length).toBeGreaterThan(0);
    for (const call of api.offOrigin()) expect(call.headers.has("X-Trace-Id")).toBe(false);
  });

  const secret = "signed-url?X-Goog-Signature=SECRET_123";
  test.each<[string, Run, FakeApiOptions]>([
    ["a rejected submission", runImage, { createStatus: 400 }],
    ["a failed submission", runImage, { createStatus: 500 }],
    ["a failed poll", runImage, { projectStatus: 500 }],
    ["a failed download", runImage, { statuses: ["complete"], downloadStatus: 403 }],
    ["a failed upload-URL request", runImageVideo, { uploadUrlsStatus: 500 }],
    ["a failed upload", runImageVideo, { uploadStatus: 403 }],
    ["an insufficient-credits rejection", runImage, { createStatus: 402 }],
    [
      "a malformed upload-URL response",
      runImageVideo,
      {
        uploadUrlsResponse: () =>
          new Response('{"items": [{"upload_url": "SECRET_123', {
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  ])("%s never echoes the response", async (_, run, options) => {
    const api = fakeApi({ ...options, errorMessage: secret });
    const error = await rejection(run(api, { maxRetries: 0 }));
    expectNoSecret(error, "SECRET_123");
  });

  test.each<[string, (c: { url: string; method: string }) => boolean]>([
    ["the upload-URL request", (c) => c.url.endsWith("/files/upload-urls")],
    ["the upload", (c) => c.method === "PUT"],
    ["the download", (c) => c.method === "GET" && c.url.startsWith(STORAGE)],
    ["a poll", (c) => /-projects\//.test(c.url)],
    ["the paid submission", (c) => c.method === "POST" && /to-video$/.test(c.url)],
  ])("a fetch error on %s never echoes its message", async (_, match) => {
    const api = fakeApi({ statuses: ["complete"] });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (match({ url: request.url, method: request.method }))
        throw new TypeError(`connect failed for ${request.url} with ${key}`);
      return api.fetch(input, init);
    };
    const error = await rejection(runImageVideo(api, { settings: { apiKey: key, fetch } }));
    expect(error).toBeInstanceOf(Error);
    expectNoSecret(error, key);
    expectNoSecret(error, "Signature");
  });

  test("an API key that isn't a valid header value never appears in the error", async () => {
    const api = fakeApi();
    const error = await rejection(runImage(api, { settings: { apiKey: "bad\nKEY_SECRET_9" } }));
    expect((error as Error).message).not.toContain("KEY_SECRET_9");
    expect(api.generations()).toHaveLength(0);
  });

  test("a caller's abort reason during an upload never appears in the error", async () => {
    const controller = new AbortController();
    const api = fakeApi({
      hold: (c) => {
        if (c.method !== "PUT") return false;
        queueMicrotask(() => controller.abort(new Error("ABORT_REASON_SECRET")));
        return true;
      },
    });
    const error = await rejection(runImageVideo(api, { abortSignal: controller.signal }));
    expect(String((error as Error)?.message)).not.toContain("ABORT_REASON_SECRET");
    expect(api.generations()).toHaveLength(0);
  });

  test("the API key never appears in error messages", async () => {
    const api = fakeApi({ createStatus: 401 });
    const error = await rejection(runImage(api, { settings: { apiKey: key } }));
    expect(String((error as Error).message)).not.toContain(key);
  });
});
