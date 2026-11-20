// A paid request is sent at most once, and a failed upload never leads to one. Calls use
// maxRetries: 3, so a provider that lets the AI SDK retry would send a second request.
import { generateImage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createMagicHour, MagicHourError } from "../src/index.js";
import { API, fakeApi, isGeneration, STORAGE } from "./fake-api.js";
import {
  endpoints,
  expectAcceptanceUnknown,
  expectNoSecret,
  isUpload,
  rejection,
  runImage,
  runImageVideo,
  underFakeTime,
} from "./helpers.js";

describe("paid submissions are never retried", () => {
  for (const [endpoint, run] of endpoints)
    describe(endpoint, () => {
      // Retry-After is set on every error response, since it invites a retry.
      test.each([400, 401, 402, 429])(
        "HTTP %i is a rejection: one request, status kept",
        async (status) => {
          const api = fakeApi({ createStatus: status, createErrorHeaders: { "Retry-After": "1" } });
          const error = await rejection(run(api));
          expect(api.generations()).toHaveLength(1);
          expect(api.generations()[0].url).toBe(`${API}/v1/${endpoint}`);
          expect(error).toBeInstanceOf(MagicHourError);
          expect((error as MagicHourError).isRetryable).toBe(false);
          expect((error as MagicHourError).status).toBe(status);
          expect((error as MagicHourError).projectId).toBeUndefined();
          expect((error as Error).message).not.toMatch(/Acceptance is unknown/);
        }
      );

      // The server may have accepted the job before failing, so the caller must check first.
      test.each([408, 500, 503])(
        "HTTP %i leaves acceptance unknown: one request, status kept",
        async (status) => {
          const api = fakeApi({ createStatus: status, createErrorHeaders: { "Retry-After": "1" } });
          const error = await rejection(run(api));
          expect(api.generations()).toHaveLength(1);
          expectAcceptanceUnknown(error);
          expect((error as MagicHourError).status).toBe(status);
        }
      );

      test("a dropped connection leaves acceptance unknown", async () => {
        const api = fakeApi({ createNetworkError: true });
        const error = await rejection(run(api));
        expect(api.generations()).toHaveLength(1);
        expectAcceptanceUnknown(error);
      });

      test("a response that breaks partway leaves acceptance unknown", async () => {
        const api = fakeApi({ breakBody: isGeneration });
        const error = await rejection(run(api));
        expect(api.generations()).toHaveLength(1);
        expectAcceptanceUnknown(error);
      });

      test("a response whose body stalls leaves acceptance unknown at timeoutMs", async () => {
        const api = fakeApi({ stallBody: (c) => isGeneration(c) && (() => {}) });
        const { error, elapsed } = await underFakeTime(() =>
          run(api, { settings: { timeoutMs: 1000 } })
        );
        expect(api.generations()).toHaveLength(1);
        expectAcceptanceUnknown(error);
        expect(elapsed).toBeLessThan(1200);
      });

      test.each([
        ["the same endpoint", `${API}/v1/${endpoint}`],
        ["another origin", `https://attacker.example/v1/${endpoint}`],
      ])("a redirect to %s is not followed", async (_, to) => {
        const api = fakeApi({ redirect: (c) => (isGeneration(c) ? to : undefined) });
        const error = await rejection(run(api));
        const posts = api.calls.filter((c) => c.method === "POST" && c.url.endsWith(endpoint));
        expect(posts).toHaveLength(1);
        expect(api.projects()).toHaveLength(0);
        expect(api.calls.some((c) => c.url.startsWith("https://attacker.example"))).toBe(false);
        expectAcceptanceUnknown(error);
      });
    });

  test("the global fetch is never retried after a dropped connection either", async () => {
    const api = fakeApi({ createNetworkError: true });
    vi.stubGlobal("fetch", api.fetch);
    const error = await rejection(
      generateImage({
        model: createMagicHour({ apiKey: "test-key" }).image(),
        prompt: "Mug",
        maxRetries: 3,
      })
    );
    expect(api.generations()).toHaveLength(1);
    expectAcceptanceUnknown(error);
  });

  test.each<[string, () => Response]>([
    ["no project ID", () => Response.json({ credits_charged: 5 })],
    ["a blank project ID", () => Response.json({ id: "   " })],
    ["a non-string project ID", () => Response.json({ id: 42 })],
    [
      "malformed JSON",
      // V8's parse error quotes the start of the text.
      () =>
        new Response('MALFORMED_SECRET {"id": "project-1"', {
          headers: { "Content-Type": "application/json" },
        }),
    ],
  ])(
    "an accepted response with %s fails without saving, polling or resubmitting",
    async (_, createResponse) => {
      const api = fakeApi({ createResponse });
      const saved: unknown[] = [];
      const error = await rejection(
        runImage(api, { settings: { onProjectCreated: (project) => void saved.push(project) } })
      );
      expect(saved).toEqual([]);
      expect(error).toBeInstanceOf(MagicHourError);
      expect((error as MagicHourError).projectId).toBeUndefined();
      expect((error as MagicHourError).isRetryable).toBe(false);
      expect((error as Error).message).toMatch(/check account history before submitting again/i);
      expectNoSecret(error, "MALFORMED_SECRET");
      expect(api.generations()).toHaveLength(1);
      expect(api.polls()).toHaveLength(0);
    }
  );
});

describe("a failed upload starts no paid job", () => {
  test.each([403, 500])("an upload that returns HTTP %i", async (uploadStatus) => {
    const api = fakeApi({ uploadStatus });
    await rejection(runImageVideo(api));
    expect(api.storage().filter(isUpload)).toHaveLength(1);
    expect(api.generations()).toHaveLength(0);
  });

  // Catches a rewrite that starts the job while the upload is still running.
  test("an upload that fails slowly", async () => {
    const api = fakeApi({ uploadStatus: 403, delay: (c) => (isUpload(c) ? 30 : 0) });
    await rejection(runImageVideo(api));
    expect(api.generations()).toHaveLength(0);
  });

  test("an upload-URL request that fails", async () => {
    const api = fakeApi({ uploadUrlsStatus: 500 });
    await rejection(runImageVideo(api));
    expect(api.uploadUrlRequests()).toHaveLength(1);
    expect(api.offOrigin()).toHaveLength(0);
    expect(api.generations()).toHaveLength(0);
  });

  const signedUpload = `${STORAGE}/uploads/input-1.png?X-Goog-Signature=sig`;
  function item(overrides: Record<string, unknown>) {
    return {
      items: [
        {
          upload_url: signedUpload,
          file_path: "api-assets/x.png",
          expires_at: "2099-01-01T00:00:00Z",
          ...overrides,
        },
      ],
    };
  }
  test.each([
    ["no items", { items: [] }],
    ["no file path", item({ file_path: undefined })],
    ["a numeric file path", item({ file_path: 123 })],
    ["an object file path", item({ file_path: {} })],
    ["a blank file path", item({ file_path: "    " })],
    ["no upload URL", item({ upload_url: undefined })],
    ["a non-string upload URL", item({ upload_url: 42 })],
    ["a plain-HTTP upload URL", item({ upload_url: signedUpload.replace("https:", "http:") })],
    [
      "an upload URL containing credentials",
      item({ upload_url: signedUpload.replace("https://", "https://user:pass@") }),
    ],
  ])("an upload-URL response with %s", async (_, uploadUrlsBody) => {
    const api = fakeApi({ uploadUrlsBody });
    await rejection(runImageVideo(api, { maxRetries: 0 }));
    expect(api.uploadUrlRequests()).toHaveLength(1);
    expect(api.offOrigin()).toHaveLength(0);
    expect(api.generations()).toHaveLength(0);
  });
});
