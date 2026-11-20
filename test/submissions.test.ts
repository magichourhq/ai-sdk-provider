// A paid request is sent at most once, and a failed upload never leads to one. Calls use
// maxRetries: 3, so a provider that lets the AI SDK retry would send a second request.
import { describe, expect, test } from "vitest";
import { MagicHourError } from "../src/index.js";
import { fakeApi, isGeneration, STORAGE } from "./fake-api.js";
import {
  expectAcceptanceUnknown,
  expectNoSecret,
  isUpload,
  kinds,
  rejection,
  runImage,
  runImageVideo,
  underFakeTime,
} from "./helpers.js";

describe("paid submissions are never retried", () => {
  // The AI SDK retries 408, 429 and 5xx by default. Retry-After invites it to.
  for (const [kind, run] of kinds) {
    test.each([400, 429])(
      `${kind}: HTTP %i is a rejection: one request, status kept`,
      async (status) => {
        const api = fakeApi({ createStatus: status, createErrorHeaders: { "Retry-After": "1" } });
        const error = await rejection(run(api));
        expect(api.generations()).toHaveLength(1);
        expect(error).toBeInstanceOf(MagicHourError);
        expect((error as MagicHourError).isRetryable).toBe(false);
        expect((error as MagicHourError).status).toBe(status);
        expect((error as MagicHourError).projectId).toBeUndefined();
        expect((error as Error).message).not.toMatch(/Acceptance is unknown/);
      }
    );

    // The server may have accepted the job before failing, so the caller must check first.
    test.each([408, 500])(
      `${kind}: HTTP %i leaves acceptance unknown: one request, status kept`,
      async (status) => {
        const api = fakeApi({ createStatus: status, createErrorHeaders: { "Retry-After": "1" } });
        const error = await rejection(run(api));
        expect(api.generations()).toHaveLength(1);
        expectAcceptanceUnknown(error);
        expect((error as MagicHourError).status).toBe(status);
      }
    );
  }

  test("a dropped connection leaves acceptance unknown", async () => {
    const api = fakeApi({ createNetworkError: true });
    const error = await rejection(runImage(api));
    expect(api.generations()).toHaveLength(1);
    expectAcceptanceUnknown(error);
  });

  test("a response that breaks partway leaves acceptance unknown", async () => {
    const api = fakeApi({ breakBody: isGeneration });
    const error = await rejection(runImage(api));
    expect(api.generations()).toHaveLength(1);
    expectAcceptanceUnknown(error);
  });

  test("a response whose body stalls leaves acceptance unknown at timeoutMs", async () => {
    const api = fakeApi({ stallBody: (c) => isGeneration(c) && (() => {}) });
    const { error, elapsed } = await underFakeTime(() =>
      runImage(api, { settings: { timeoutMs: 1000 } })
    );
    expect(api.generations()).toHaveLength(1);
    expectAcceptanceUnknown(error);
    expect(elapsed).toBeLessThan(1200);
  });

  // Following a redirect would send the paid request a second time.
  test("a redirect is not followed", async () => {
    const api = fakeApi({ redirect: (c) => (isGeneration(c) ? c.url : undefined) });
    const error = await rejection(runImage(api));
    expect(api.generations()).toHaveLength(1);
    expect(api.projects()).toHaveLength(0);
    expectAcceptanceUnknown(error);
  });

  test.each<[string, () => Response]>([
    ["no project ID", () => Response.json({ credits_charged: 5 })],
    ["a blank project ID", () => Response.json({ id: "   " })],
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
  test("an upload that fails", async () => {
    const api = fakeApi({ uploadStatus: 403 });
    await rejection(runImageVideo(api));
    expect(api.storage().filter(isUpload)).toHaveLength(1);
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
  // Without a file path the job would be sent as text-to-video, which is still paid for.
  test.each([
    ["no file path", item({ file_path: undefined })],
    ["a blank file path", item({ file_path: "    " })],
    ["a plain-HTTP upload URL", item({ upload_url: signedUpload.replace("https:", "http:") })],
  ])("an upload-URL response with %s", async (_, uploadUrlsBody) => {
    const api = fakeApi({ uploadUrlsBody });
    await rejection(runImageVideo(api, { maxRetries: 0 }));
    expect(api.uploadUrlRequests()).toHaveLength(1);
    expect(api.offOrigin()).toHaveLength(0);
    expect(api.generations()).toHaveLength(0);
  });
});
