import { inspect } from "node:util";
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { expect, vi } from "vitest";
import { MagicHourError, type MagicHourSettings } from "../src/index.js";
import { type Call, fakeApi, type FakeApiOptions, png, STORAGE } from "./fake-api.js";

export type Api = ReturnType<typeof fakeApi>;
export type RunOptions = {
  settings?: MagicHourSettings;
  abortSignal?: AbortSignal;
  maxRetries?: number;
  headers?: Record<string, string>;
};
export type Run = (api: Api, options?: RunOptions) => Promise<unknown>;

// maxRetries defaults to 3 so a provider that lets the AI SDK retry a paid request gets caught.

export function runImage(
  api: Api,
  { settings, abortSignal, maxRetries = 3, headers }: RunOptions = {}
) {
  return generateImage({
    model: api.provider(settings).image(),
    prompt: "Mug",
    abortSignal,
    maxRetries,
    headers,
  });
}

export function runTextVideo(
  api: Api,
  { settings, abortSignal, maxRetries = 3, headers }: RunOptions = {}
) {
  return generateVideo({
    model: api.provider(settings).video(),
    prompt: "Waves",
    abortSignal,
    maxRetries,
    headers,
  });
}

export function runImageVideo(
  api: Api,
  { settings, abortSignal, maxRetries = 3, headers }: RunOptions = {}
) {
  return generateVideo({
    model: api.provider(settings).video(),
    prompt: { image: png, text: "Animate" },
    abortSignal,
    maxRetries,
    headers,
  });
}

/** Every paid endpoint. Used where each endpoint submits or uploads differently. */
export const endpoints: [endpoint: string, run: Run][] = [
  ["ai-image-generator", runImage],
  ["text-to-video", runTextVideo],
  ["image-to-video", runImageVideo],
];

/** One run per project kind. Both video endpoints share the same path after acceptance. */
export const kinds: [kind: "image" | "video", run: Run][] = [
  ["image", runImage],
  ["video", runTextVideo],
];

/** The error a call rejects with. Fails the test if the call succeeds. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject");
}

/** The only project the fake accepted. */
export function onlyProject(api: Api): string {
  expect(api.projects()).toHaveLength(1);
  return api.projects()[0].id;
}

/** Asserts the error names the accepted project, so the caller can resume it instead of paying again. */
export function expectRecoverable(error: unknown, projectId: string) {
  expect(error).toBeInstanceOf(MagicHourError);
  expect((error as MagicHourError).name).toBe("MagicHourError");
  expect((error as MagicHourError).projectId).toBe(projectId);
  expect((error as MagicHourError).isRetryable).toBe(false);
  expect((error as MagicHourError).message).toContain(projectId);
}

/** Asserts a submission whose outcome is unknown: no project ID, and a warning not to resubmit. */
export function expectAcceptanceUnknown(error: unknown) {
  expect(error).toBeInstanceOf(MagicHourError);
  expect((error as MagicHourError).isRetryable).toBe(false);
  expect((error as MagicHourError).projectId).toBeUndefined();
  expect((error as Error).message).toMatch(/Acceptance is unknown/);
}

/** Asserts the secret appears nowhere a caller or a log could see it, including causes. */
export function expectNoSecret(error: unknown, secret: string) {
  expect(inspect(error, { depth: 10 })).not.toContain(secret);
  for (let e: unknown = error, depth = 0; e && depth < 10; e = (e as Error).cause, depth++) {
    expect(String((e as Error).message ?? e)).not.toContain(secret);
    expect(String((e as Error).stack ?? "")).not.toContain(secret);
  }
}

/** Runs a call to completion under fake timers and reports the virtual time it took. */
export async function underFakeTime(start: () => Promise<unknown>, step = 5) {
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

/** Waits until a condition holds, letting pending I/O run in between. */
export async function until(condition: () => boolean) {
  for (let i = 0; i < 1000 && !condition(); i++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

/** A promise to hold a request on (with the fake's `gate`) and the function that releases it. */
export function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** Holds the first matching request open and aborts the call once it's in flight. */
export function abortWhenHeld(match: (call: Call) => boolean, options: FakeApiOptions = {}) {
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

/** A fetch that throws `error` for matching requests and sends the rest to the fake. */
export function failingFetch(
  api: Api,
  match: (call: Call) => boolean,
  error: (request: Request) => Error
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (match({ url: request.url, method: request.method } as Call)) throw error(request);
    return api.fetch(input, init);
  };
}

export function isPoll(call: Call): boolean {
  return /-projects\//.test(call.url);
}
export function isDownload(call: Call): boolean {
  return call.method === "GET" && call.url.startsWith(STORAGE);
}
export function isUpload(call: Call): boolean {
  return call.method === "PUT";
}
export function isUploadUrlRequest(call: Call): boolean {
  return call.url.endsWith("/files/upload-urls");
}

/** Video call options the AI SDK would pass, for inputs `generateVideo` can't produce. */
export function videoCall(overrides: Record<string, unknown> = {}): any {
  return {
    prompt: "Animate",
    n: 1,
    image: undefined,
    aspectRatio: undefined,
    resolution: undefined,
    duration: undefined,
    fps: undefined,
    seed: undefined,
    providerOptions: {},
    ...overrides,
  };
}
