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
type Run = (
  api: Api,
  extra?: { settings?: MagicHourSettings; abortSignal?: AbortSignal; maxRetries?: number }
) => Promise<unknown>;

/** One way to start each paid endpoint through the AI SDK. */
const endpoints: [string, Run][] = [
  [
    "ai-image-generator",
    (api, { settings, abortSignal, maxRetries = 3 } = {}) =>
      generateImage({
        model: api.provider(settings).image(),
        prompt: "Mug",
        abortSignal,
        maxRetries,
      }),
  ],
  [
    "text-to-video",
    (api, { settings, abortSignal, maxRetries = 3 } = {}) =>
      generateVideo({
        model: api.provider(settings).video(),
        prompt: "Waves",
        abortSignal,
        maxRetries,
      }),
  ],
  [
    "image-to-video",
    (api, { settings, abortSignal, maxRetries = 3 } = {}) =>
      generateVideo({
        model: api.provider(settings).video(),
        prompt: { image: png, text: "Animate" },
        abortSignal,
        maxRetries,
      }),
  ],
];
const [runImage, runTextVideo] = [endpoints[0][1], endpoints[1][1]];
const kinds: [string, Run][] = [
  ["image", runImage],
  ["video", runTextVideo],
];

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
}

/** Asserts the error names the project the API actually accepted, so the caller can resume it. */
function expectRecoverable(error: unknown, api: Api) {
  const accepted = api.projects();
  expect(accepted).toHaveLength(1);
  expect(error).toBeInstanceOf(MagicHourError);
  expect((error as MagicHourError).projectId).toBe(accepted[0].id);
  expect((error as MagicHourError).isRetryable).toBe(false);
  expect((error as MagicHourError).message).toContain(accepted[0].id);
}

/** Runs a call to completion under fake timers and reports the virtual time it took. */
async function underFakeTime(start: () => Promise<unknown>) {
  vi.useFakeTimers();
  const began = Date.now();
  let settled = false;
  const outcome = start().then(
    (value): { value?: unknown; error?: unknown } => ({ value }),
    (error: unknown) => ({ error })
  );
  outcome.finally(() => (settled = true));
  for (let i = 0; i < 100_000 && !settled; i++) await vi.advanceTimersByTimeAsync(5);
  expect(settled).toBe(true);
  return { ...(await outcome), elapsed: Date.now() - began };
}

describe("paid generations are never retried", () => {
  const rejected = [400, 401, 402, 404, 409, 422, 429];
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
          expect(error).toBeInstanceOf(MagicHourError);
          expect((error as MagicHourError).isRetryable).toBe(false);
          expect((error as MagicHourError).status).toBe(status);
          expect((error as Error).message).toMatch(/Acceptance is unknown/);
        }
      );

      test("a dropped connection leaves acceptance unknown and isn't retried", async () => {
        const api = fakeApi({ createNetworkError: true });
        const error = await rejection(run(api));
        expect(api.generations()).toHaveLength(1);
        expect(error).toBeInstanceOf(MagicHourError);
        expect((error as Error).message).toMatch(/Acceptance is unknown/);
      });

      test("a redirect is never followed, so the POST isn't replayed", async () => {
        const api = fakeApi({ createRedirect: true });
        const error = await rejection(run(api));
        expect(api.generations()).toHaveLength(1);
        expect(api.projects()).toHaveLength(0);
        expect((error as Error).message).toMatch(/Acceptance is unknown/);
      });
    });
  }

  test.each([
    ["no project ID", () => ({ credits_charged: 5 })],
    ["an empty project ID", () => ({ id: "" })],
    ["a non-string project ID", () => ({ id: 42 })],
    ["a non-JSON body", () => "not json"],
  ])("an accepted response with %s fails without resubmitting", async (_, createBody) => {
    const api = fakeApi({ createBody });
    await expect(runImage(api)).rejects.toBeInstanceOf(MagicHourError);
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
    ["a failed download", { statuses: ["complete"], downloadStatus: 403 }],
  ];

  for (const [kind, run] of kinds)
    describe(kind, () => {
      test.each(cases)("%s", async (_, options) => {
        const api = fakeApi(options);
        const error = await rejection(run(api));
        expectRecoverable(error, api);
        expect(api.generations()).toHaveLength(1);
        expect(api.calls.some((c) => c.url.startsWith("http://"))).toBe(false);
      });

      test("a render error's server message is not shown to the caller", async () => {
        const api = fakeApi({
          statuses: ["error"],
          projectError: { message: "internal token tk_SECRET_123 leaked", code: "internal" },
        });
        const error = await rejection(run(api));
        expectRecoverable(error, api);
        expect((error as Error).message).not.toContain("tk_SECRET_123");
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
  const isPoll = (c: Call) => /-projects\//.test(c.url);

  test("an already-aborted signal sends nothing", async () => {
    const api = fakeApi();
    const controller = new AbortController();
    controller.abort();
    await expect(runImage(api, { abortSignal: controller.signal })).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });

  test("aborting during submission stops it and leaves acceptance unknown", async () => {
    const { api, signal } = abortWhenHeld((c) => c.method === "POST");
    const error = await rejection(runImage(api, { abortSignal: signal }));
    expect(error).toBeInstanceOf(MagicHourError);
    expect((error as Error).message).toMatch(/Acceptance is unknown/);
    expect(api.generations()).toHaveLength(1);
  });

  for (const [kind, run] of kinds) {
    test(`aborting an in-flight ${kind} poll names the project and stops polling`, async () => {
      const { api, signal } = abortWhenHeld(isPoll);
      expectRecoverable(await rejection(run(api, { abortSignal: signal })), api);
      expect(api.polls()).toHaveLength(1);
    });

    test(`aborting an in-flight ${kind} download names the project`, async () => {
      const { api, signal } = abortWhenHeld((c) => c.url.startsWith(STORAGE), {
        statuses: ["complete"],
      });
      expectRecoverable(await rejection(run(api, { abortSignal: signal })), api);
    });

    test(`aborting while a ${kind} download body streams names the project`, async () => {
      const controller = new AbortController();
      const api = fakeApi({
        statuses: ["complete"],
        holdBody: () => {
          queueMicrotask(() => controller.abort());
          return true;
        },
      });
      expectRecoverable(await rejection(run(api, { abortSignal: controller.signal })), api);
    });
  }

  test("aborting an in-flight upload starts no paid job", async () => {
    const { api, signal } = abortWhenHeld((c) => c.method === "PUT");
    const run = endpoints[2][1];
    await expect(run(api, { abortSignal: signal })).rejects.toThrow();
    expect(api.generations()).toHaveLength(0);
  });

  test("aborting during the upload-URL request starts no paid job", async () => {
    const { api, signal } = abortWhenHeld((c) => c.url.endsWith("/files/upload-urls"));
    const run = endpoints[2][1];
    await expect(run(api, { abortSignal: signal })).rejects.toThrow();
    expect(api.generations()).toHaveLength(0);
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
      endpoints[2][1](api, { settings: { timeoutMs: 1000, pollIntervalMs: 100 } })
    );
    expectRecoverable(error, api);
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(1200);
  });

  test("timeoutMs also bounds a call whose caller passes its own signal", async () => {
    const api = fakeApi({ statuses: ["rendering"] });
    const { error, elapsed } = await underFakeTime(() =>
      runImage(api, {
        settings: { timeoutMs: 500, pollIntervalMs: 50 },
        abortSignal: new AbortController().signal,
      })
    );
    expectRecoverable(error, api);
    expect(elapsed).toBeLessThan(600);
  });
});

describe("onProjectCreated", () => {
  for (const [kind, run] of kinds) {
    test(`receives the accepted ${kind} project before polling starts`, async () => {
      const api = fakeApi({ statuses: ["complete"] });
      const seen: { id: string; kind: string; pollsSoFar: number }[] = [];
      await run(api, {
        settings: {
          onProjectCreated: (project) => {
            seen.push({ ...project, pollsSoFar: api.polls().length });
          },
        },
      });
      expect(seen).toEqual([{ id: api.projects()[0].id, kind, pollsSoFar: 0 }]);
    });

    test.each([
      [
        "throws",
        () => {
          throw new Error("database down");
        },
      ],
      ["rejects", async () => Promise.reject(new Error("database down"))],
    ])(`a ${kind} save that %s names the project and stops before polling`, async (_, save) => {
      const api = fakeApi();
      const error = await rejection(run(api, { settings: { onProjectCreated: save } }));
      expectRecoverable(error, api);
      expect(api.polls()).toHaveLength(0);
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
  test.each(kinds)(
    "a formatMessage that throws still names the accepted %s project",
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
      expectRecoverable(error, api);
    }
  );

  test("formatMessage receives each message and its values", async () => {
    const api = fakeApi({ createStatus: 402 });
    const seen: unknown[] = [];
    const error = await rejection(
      runImage(api, {
        settings: {
          formatMessage: (message, values) => {
            seen.push({ id: message.id, values });
            return `translated: ${message.defaultMessage}`;
          },
        },
      })
    );
    expect((error as Error).message).toMatch(/^translated: /);
    expect(seen).toContainEqual(expect.objectContaining({ values: { status: 402 } }));
  });
});

describe("credentials and error contents", () => {
  const key = "mh_test_KEY_8f2a91";

  test.each(endpoints)(
    "%s: the key only goes to the API, never to storage in any header, URL or body",
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

  test.each(kinds)("%s: custom headers reach the API but not storage", async (_, run) => {
    const api = fakeApi();
    const headers = { "X-Trace-Id": "trace-1" };
    if (run === runImage)
      await generateImage({ model: api.provider().image(), prompt: "Mug", headers, maxRetries: 0 });
    else
      await generateVideo({
        model: api.provider().video(),
        prompt: "Waves",
        headers,
        maxRetries: 0,
      });
    for (const call of [...api.generations(), ...api.polls()])
      expect(call.headers.get("X-Trace-Id")).toBe("trace-1");
    expect(api.polls().length).toBeGreaterThan(0);
    for (const call of api.offOrigin()) expect(call.headers.has("X-Trace-Id")).toBe(false);
  });

  test.each<[string, FakeApiOptions]>([
    ["a rejected submission", { createStatus: 400 }],
    ["a failed submission", { createStatus: 500 }],
    ["a failed poll", { projectStatus: 500 }],
    ["a failed download", { statuses: ["complete"], downloadStatus: 403 }],
  ])("%s never echoes the response body", async (_, options) => {
    const secret = "signed-url?X-Goog-Signature=secret123";
    const api = fakeApi({ ...options, errorBody: secret });
    const error = await rejection(runImage(api, { maxRetries: 0 }));
    expect(String((error as Error).message)).not.toContain("secret123");
  });

  test("the API key never appears in error messages", async () => {
    const api = fakeApi({ createStatus: 401 });
    const error = await rejection(runImage(api, { settings: { apiKey: key } }));
    expect(String((error as Error).message)).not.toContain(key);
  });
});
