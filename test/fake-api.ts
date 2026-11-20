import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { createMagicHour, type MagicHourSettings } from "../src/index.js";

export const API = "https://api.magichour.ai";
// Signed media URLs live on a Magic Hour host, so credential checks must use the exact API origin.
export const STORAGE = "https://videos.magichour.ai";

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

/** A valid 1x1 PNG of the given color. */
export function makePng(red: number, green = 0, blue = 0): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
      pngChunk("IDAT", deflateSync(Buffer.from([0, red, green, blue]))),
      pngChunk("IEND", Buffer.alloc(0)),
    ])
  );
}

// A playable one-frame 16x16 H.264 MP4 (made with ffmpeg).
const tinyMp4 = readFileSync(new URL("./fixtures/tiny.mp4", import.meta.url));

/** A playable MP4, made unique with a trailing `free` box holding the marker. */
export function makeMp4(marker: number): Uint8Array {
  return new Uint8Array(
    Buffer.concat([tinyMp4, Buffer.from([0, 0, 0, 9]), Buffer.from("free"), Buffer.from([marker])])
  );
}

export const png = makePng(255, 0, 0);
export const jpeg = new Uint8Array(readFileSync(new URL("./fixtures/tiny.jpg", import.meta.url)));
export const webp = new Uint8Array(readFileSync(new URL("./fixtures/tiny.webp", import.meta.url)));

export type Call = {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestRedirect;
  credentials: RequestCredentials;
  /** Parsed JSON for JSON requests, otherwise the raw body bytes. */
  body: any;
};

export type Project = {
  id: string;
  kind: "image" | "video";
  /** The project type the API reports, from the creation route. */
  type: "AI_IMAGE" | "TEXT_TO_VIDEO" | "IMAGE_TO_VIDEO";
  /** The signed URL its output is served from. */
  url: string;
  bytes: Uint8Array;
};

export type Upload = { url: string; filePath: string; bytes?: Uint8Array };

export type FakeApiOptions = {
  /** Statuses returned by successive polls of each project. The last one repeats. */
  statuses?: string[];
  /** Per-project statuses, by acceptance order starting at 1. Overrides `statuses`. */
  statusesFor?: (n: number) => string[] | undefined;
  /** HTTP status for generation requests. Anything but 200 rejects the job. */
  createStatus?: number;
  /** Extra headers on generation error responses, such as Retry-After. */
  createErrorHeaders?: Record<string, string>;
  /** Raw response for accepted generation requests, replacing the normal one. */
  createResponse?: (n: number) => Response | undefined;
  /** Accepts generation requests, then fails like a connection reset before the response. */
  createNetworkError?: boolean;
  /** Answers matching requests with a 307 to the returned URL. */
  redirect?: (call: Call) => string | undefined;
  /** HTTP status for project polls. */
  projectStatus?: number;
  /** Raw response for project polls, replacing the normal one. */
  pollResponse?: () => Response | undefined;
  /** The `error` object on failed projects. */
  projectError?: { message: string; code: string };
  /** Overrides the downloads listed on a complete project. */
  downloads?: (project: Project) => { url: string; expires_at: string }[];
  /** The charge on every project, or per project. */
  creditsCharged?: number | ((project: Project) => number);
  /** HTTP status for media downloads. 204 sends no body. */
  downloadStatus?: number;
  /** Serves downloads with an empty HTTP 200 body. */
  emptyDownload?: boolean;
  /** Serves downloads as an unrequested 206 with only the first half of the file. */
  partialDownload?: boolean;
  /** HTTP status for the upload-URL request. */
  uploadUrlsStatus?: number;
  /** Response body for the upload-URL request. */
  uploadUrlsBody?: unknown;
  /** Raw response for the upload-URL request, replacing the normal one. */
  uploadUrlsResponse?: () => Response;
  /** HTTP status for the upload PUT. */
  uploadStatus?: number;
  /** Text in every error response's JSON `message`, to check it never reaches the caller. */
  errorMessage?: string;
  /** Requests that never get a response until they're aborted. */
  hold?: (call: Call) => boolean;
  /** Responses whose body stalls until aborted, after the headers arrive. Called on first read. */
  stallBody?: (call: Call) => (() => void) | false;
  /** Responses whose body breaks partway, like a connection reset after some of the data. */
  breakBody?: (call: Call) => boolean;
  /** Sets the deprecated single `download` field on video projects to null. */
  nullDownloadField?: boolean;
  /** Holds a request until the returned promise settles (or the request is aborted). */
  gate?: (call: Call) => Promise<void> | undefined;
  /** HTTP status for one project's download, overriding `downloadStatus`. */
  downloadStatusFor?: (project: Project) => number | undefined;
  /** Milliseconds to wait before answering a request (uses setTimeout, so fake timers apply). */
  delay?: (call: Call) => number;
};

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortError(signal));
    else signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true }
    );
  });
}

const generationKinds: Record<string, "image" | "video"> = {
  "/v1/ai-image-generator": "image",
  "/v1/text-to-video": "video",
  "/v1/image-to-video": "video",
};
const projectTypes = {
  "/v1/ai-image-generator": "AI_IMAGE",
  "/v1/text-to-video": "TEXT_TO_VIDEO",
  "/v1/image-to-video": "IMAGE_TO_VIDEO",
} as const;

export function isGeneration(call: Call): boolean {
  return (
    call.method === "POST" &&
    new URL(call.url).origin === API &&
    new URL(call.url).pathname in generationKinds
  );
}

function isJson(headers: Headers): boolean {
  return headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/json";
}

/** The same response with a different body. */
function withBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: response.status, headers: response.headers });
}

function stalledBody(signal: AbortSignal, onStall: () => void): ReadableStream<Uint8Array> {
  let started = false;
  return new ReadableStream(
    {
      pull(controller) {
        if (!started) {
          started = true;
          // The abort may already have happened between the headers and this first read.
          if (signal.aborted) return controller.error(abortError(signal));
          signal.addEventListener("abort", () => controller.error(abortError(signal)), {
            once: true,
          });
          onStall();
        }
        return new Promise(() => {});
      },
    },
    // Pull only when the consumer reads, not as soon as the response exists.
    { highWaterMark: 0 }
  );
}

/** Streams bytes in three chunks. */
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const size = Math.ceil(bytes.length / 3);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/** Sends the first bytes of the real body, then fails like a reset connection. */
function brokenBody(prefix: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return controller.error(new TypeError("terminated: other side closed"));
      sent = true;
      controller.enqueue(prefix);
    },
  });
}

/**
 * A strict stand-in for the Magic Hour API and its signed-URL storage. It only answers the exact
 * method, route and media type the real API accepts, keeps separate state per project and per
 * upload, sends spec-shaped JSON errors, and follows real `fetch` semantics for aborts and
 * redirects.
 */
export function fakeApi(options: FakeApiOptions = {}) {
  const calls: Call[] = [];
  const projects = new Map<string, Project & { polls: number; statuses: string[] }>();
  const uploads: Upload[] = [];
  const providers = new WeakMap<MagicHourSettings, ReturnType<typeof createMagicHour>>();

  function error(status: number): Response {
    if (status === 204) return new Response(null, { status });
    const code = status === 402 ? "insufficient_credits" : `http_${status}`;
    return Response.json(
      { code, message: options.errorMessage ?? `Request failed (${status})` },
      { status }
    );
  }

  function accept(path: string): Response {
    if (options.createStatus && options.createStatus !== 200) {
      const response = error(options.createStatus);
      for (const [name, value] of Object.entries(options.createErrorHeaders ?? {}))
        response.headers.set(name, value);
      return response;
    }
    const n = projects.size + 1;
    const custom = options.createResponse?.(n);
    if (custom) return custom;
    const kind = generationKinds[path];
    const id = `${kind}-${n}-${(n * 7919).toString(36)}`;
    const extension = kind === "image" ? "png" : "mp4";
    projects.set(id, {
      id,
      kind,
      type: projectTypes[path as keyof typeof projectTypes],
      // Real signatures contain percent-encoded characters that must reach storage unchanged.
      url: `${STORAGE}/outputs/${id}.${extension}?X-Goog-Signature=sig%2Bout%2F${n}%26x%3D&X-Goog-Expires=86400`,
      bytes: kind === "image" ? makePng(n * 40, 255 - n * 40, n) : makeMp4(n),
      polls: 0,
      statuses: options.statusesFor?.(n) ?? options.statuses ?? ["queued", "rendering", "complete"],
    });
    // Submission reports an estimate; the project's charge comes from polling.
    return Response.json(
      kind === "image"
        ? { id, frame_cost: 1, credits_charged: 1 }
        : { id, estimated_frame_cost: 1, credits_charged: 1 }
    );
  }

  async function respond(call: Call, signal: AbortSignal): Promise<Response> {
    const { url, method } = call;
    const origin = new URL(url).origin;
    const path = new URL(url).pathname;

    if (origin === STORAGE) {
      if (method === "PUT") {
        const upload = uploads.find((u) => u.url === url && !u.bytes);
        if (!upload) return error(403); // unknown or already used signed URL
        if (options.uploadStatus && options.uploadStatus !== 200)
          return error(options.uploadStatus);
        upload.bytes = call.body;
        return new Response(null, { status: 200 });
      }
      const project = [...projects.values()].find((p) => p.url === url);
      if (method !== "GET" || !project) return error(404);
      const status = options.downloadStatusFor?.(project) ?? options.downloadStatus ?? 200;
      if (status !== 200) return error(status);
      if (options.emptyDownload) return new Response(new Uint8Array(0));
      if (options.partialDownload) {
        const half = project.bytes.subarray(0, project.bytes.length >> 1);
        return new Response(half as BodyInit, {
          status: 206,
          headers: { "Content-Range": `bytes 0-${half.length - 1}/${project.bytes.length}` },
        });
      }
      // Real downloads arrive in several chunks; every one of them must be kept.
      return new Response(chunked(project.bytes));
    }
    if (origin !== API) return error(404);

    if (method === "POST" && path === "/v1/files/upload-urls") {
      if (!isJson(call.headers)) return error(415);
      if (options.uploadUrlsStatus && options.uploadUrlsStatus !== 200)
        return error(options.uploadUrlsStatus);
      if (options.uploadUrlsResponse) return options.uploadUrlsResponse();
      const n = uploads.length + 1;
      const upload = {
        url: `${STORAGE}/uploads/input-${n}.png?X-Goog-Signature=sig%2Bup%2F${n}%26y%3D`,
        filePath: `api-assets/test/input-${n}.png`,
      };
      uploads.push(upload);
      return Response.json(
        options.uploadUrlsBody ?? {
          items: [
            {
              upload_url: upload.url,
              file_path: upload.filePath,
              expires_at: "2099-01-01T00:00:00Z",
            },
          ],
        }
      );
    }

    if (method === "POST" && path in generationKinds) {
      if (!isJson(call.headers)) return error(415);
      if (options.createNetworkError) {
        accept(path);
        // What Node's fetch throws when the socket resets.
        const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        throw new TypeError("fetch failed", { cause: reset });
      }
      return accept(path);
    }

    const match = /^\/v1\/(image|video)-projects\/([^/]+)$/.exec(path);
    if (method === "GET" && match) {
      if (options.projectStatus && options.projectStatus !== 200)
        return error(options.projectStatus);
      const project = projects.get(decodeURIComponent(match[2]));
      if (!project || project.kind !== match[1]) return error(404);
      const raw = options.pollResponse?.();
      if (raw) return raw;
      const status = project.statuses[Math.min(project.polls++, project.statuses.length - 1)];
      const downloads =
        status === "complete"
          ? (options.downloads?.(project) ?? [
              { url: project.url, expires_at: "2099-01-01T00:00:00Z" },
            ])
          : [];
      const credits =
        typeof options.creditsCharged === "function"
          ? options.creditsCharged(project)
          : (options.creditsCharged ?? 5);
      // Every field the spec marks required, so a stricter parser still accepts these.
      const common = {
        id: project.id,
        name: `Project ${project.id}`,
        status,
        created_at: "2026-11-19T00:00:00Z",
        enabled: true,
        // Deprecated and different from the charge; it must never be reported as one.
        total_frame_cost: credits * 10,
        credits_charged: credits,
        error: status === "error" ? (options.projectError ?? null) : null,
        downloads,
      };
      return Response.json(
        project.kind === "image"
          ? { ...common, type: project.type, image_count: 1 }
          : {
              ...common,
              type: project.type,
              width: 854,
              height: 480,
              start_seconds: 0,
              end_seconds: 5,
              fps: 24,
              // Deprecated. It points somewhere the fake doesn't serve, so preferring it over
              // downloads[0] fails the download.
              download:
                options.nullDownloadField || !downloads[0]
                  ? null
                  : { url: `${downloads[0].url}&legacy=1`, expires_at: "2000-01-01T00:00:00Z" },
            }
      );
    }
    return error(404);
  }

  async function handle(call: Call, signal: AbortSignal): Promise<Response> {
    calls.push(call);
    if (options.hold?.(call)) return untilAborted(signal);
    const gate = options.gate?.(call);
    if (gate) await Promise.race([gate, untilAborted(signal)]);
    const delay = options.delay?.(call);
    if (delay) await sleep(delay, signal);
    const onStall = options.stallBody?.(call);
    if (onStall) return withBody(await respond(call, signal), stalledBody(signal, onStall));
    if (options.breakBody?.(call)) {
      const response = await respond(call, signal);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return withBody(response, brokenBody(bytes.subarray(0, Math.min(16, bytes.length >> 1))));
    }
    const location = options.redirect?.(call);
    if (location) {
      // What the real fetch does with a 307 in each redirect mode.
      if (call.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
      if (call.redirect === "manual")
        return new Response(null, { status: 307, headers: { Location: location } });
      // "follow" repeats the request, body included, and drops credentials across origins.
      const headers = new Headers(call.headers);
      if (new URL(location).origin !== new URL(call.url).origin) headers.delete("Authorization");
      return handle({ ...call, url: location, headers }, signal);
    }
    return respond(call, signal);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    // The caller's own signal, so aborts reach the fake without an extra hop.
    const signal = init?.signal ?? request.signal;
    // Like the real fetch, an already-aborted request never reaches the network.
    if (signal.aborted) throw abortError(signal);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const call: Call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      credentials: request.credentials,
      body: bytes.length
        ? isJson(request.headers)
          ? JSON.parse(new TextDecoder().decode(bytes))
          : bytes
        : undefined,
    };
    const response = await handle(call, signal);
    // Like the real fetch, responses carry the URL they answer, signature included.
    if (!response.url) Object.defineProperty(response, "url", { value: call.url });
    return response;
  };

  return {
    calls,
    fetch,
    /** Accepted projects, in order. */
    projects: () => [...projects.values()],
    /** Upload URLs issued, in order, with the bytes PUT to each. */
    uploads: () => uploads,
    /** Requests that start a paid generation. */
    generations: () => calls.filter(isGeneration),
    polls: () => calls.filter((c) => /-projects\//.test(c.url)),
    uploadUrlRequests: () => calls.filter((c) => c.url === `${API}/v1/files/upload-urls`),
    storage: () => calls.filter((c) => new URL(c.url).origin === STORAGE),
    /** Requests that leave https://api.magichour.ai. */
    offOrigin: () => calls.filter((c) => new URL(c.url).origin !== API),
    /** A provider for these settings. Passing the same settings object reuses the provider. */
    provider(settings: MagicHourSettings = {}) {
      let provider = providers.get(settings);
      if (!provider) {
        provider = createMagicHour({ apiKey: "test-key", fetch, pollIntervalMs: 0, ...settings });
        providers.set(settings, provider);
      }
      return provider;
    },
  };
}
