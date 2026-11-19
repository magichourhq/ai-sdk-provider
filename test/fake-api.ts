import { createMagicHour, type MagicHourSettings } from "../src/index.js";

export const API = "https://api.magichour.ai";
export const STORAGE = "https://storage.example";

// A 1x1 PNG, so binary inputs and downloads carry real image bytes.
export const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64"
  )
);
export const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);

export type Call = {
  url: string;
  method: string;
  headers: Headers;
  /** Parsed JSON for API requests, raw bytes for uploads. */
  body: any;
};

export type FakeApiOptions = {
  /** Project statuses returned by successive polls. The last one repeats. */
  statuses?: string[];
  /** HTTP status for generation requests. Anything but 200 rejects the job. */
  createStatus?: number;
  /** Response body for accepted generation requests. Defaults to a new project ID. */
  createBody?: (n: number) => unknown;
  /** Makes generation requests fail like a dropped connection. */
  createNetworkError?: boolean;
  /** HTTP status for project polls. */
  projectStatus?: number;
  /** Downloads listed on a complete project. */
  downloads?: { url: string; expires_at: string }[];
  creditsCharged?: number;
  /** HTTP status for media downloads. */
  downloadStatus?: number;
  /** Bytes served for media downloads. */
  media?: Uint8Array;
  /** Response body for the upload-URL request. */
  uploadUrlsBody?: unknown;
  /** HTTP status for the upload PUT. */
  uploadStatus?: number;
  /** Text included in error responses, to check it never reaches error messages. */
  errorBody?: string;
};

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Records every request and answers like the Magic Hour API and its media storage. Requests
 * honor their abort signal the way the real `fetch` does.
 */
export function fakeApi(options: FakeApiOptions = {}) {
  const calls: Call[] = [];
  let created = 0;
  let polls = 0;
  const statuses = options.statuses ?? ["queued", "rendering", "complete"];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    // Like the real fetch, an already-aborted request never reaches the network.
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    calls.push({ url, method, headers, body });

    const error = (status: number) =>
      new Response(options.errorBody ?? `{"message":"HTTP ${status}"}`, { status });

    if (url.startsWith(STORAGE)) {
      if (method === "PUT") return new Response(null, { status: options.uploadStatus ?? 200 });
      const status = options.downloadStatus ?? 200;
      return status === 200
        ? new Response((options.media ?? png) as BodyInit, { status })
        : error(status);
    }
    if (!url.startsWith(`${API}/v1/`)) throw new Error(`Unexpected request: ${method} ${url}`);
    const path = url.slice(API.length);

    if (path === "/v1/files/upload-urls")
      return Response.json(
        options.uploadUrlsBody ?? {
          items: [{ upload_url: `${STORAGE}/upload`, file_path: "api-assets/test/input.png" }],
        }
      );
    if (method === "POST") {
      if (options.createNetworkError) throw new TypeError("fetch failed");
      if (options.createStatus && options.createStatus !== 200) return error(options.createStatus);
      created += 1;
      return Response.json(
        options.createBody?.(created) ?? { id: `project-${created}`, credits_charged: 5 }
      );
    }
    const match = /^\/v1\/(image|video)-projects\/([^/]+)$/.exec(path);
    if (method === "GET" && match) {
      if (options.projectStatus && options.projectStatus !== 200)
        return error(options.projectStatus);
      const status = statuses[Math.min(polls++, statuses.length - 1)];
      const extension = match[1] === "image" ? "png" : "mp4";
      return Response.json({
        id: decodeURIComponent(match[2]),
        status,
        credits_charged: options.creditsCharged ?? 5,
        downloads:
          status === "complete"
            ? (options.downloads ?? [
                { url: `${STORAGE}/output.${extension}`, expires_at: "2099-01-01T00:00:00Z" },
              ])
            : [],
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  return {
    calls,
    fetch,
    /** Requests that start a paid generation. */
    generations: () => calls.filter((c) => c.method === "POST" && !c.url.includes("/files/")),
    polls: () => calls.filter((c) => /-projects\//.test(c.url)),
    storage: () => calls.filter((c) => c.url.startsWith(STORAGE)),
    provider: (settings: MagicHourSettings = {}) =>
      createMagicHour({ apiKey: "test-key", fetch, pollIntervalMs: 0, ...settings }),
  };
}
