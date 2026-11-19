import { crc32, deflateSync } from "node:zlib";
import { createMagicHour, type MagicHourSettings } from "../src/index.js";

export const API = "https://api.magichour.ai";
export const STORAGE = "https://storage.example";
export const UPLOAD_URL = `${STORAGE}/uploads/input.png?X-Goog-Signature=upload-signature`;

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

/** A well-formed MP4 box sequence (ftyp, then a free box that makes each file unique). */
export function makeMp4(marker: number): Uint8Array {
  return new Uint8Array([
    ...[0, 0, 0, 24, ...Buffer.from("ftypisom"), 0, 0, 2, 0, ...Buffer.from("isommp42")],
    ...[0, 0, 0, 9, ...Buffer.from("free"), marker],
  ]);
}

export const png = makePng(255, 0, 0);

export type Call = {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestRedirect;
  /** Parsed JSON for JSON requests, otherwise the raw body bytes. */
  body: any;
};

export type Project = {
  id: string;
  kind: "image" | "video";
  /** The signed URL its output is served from. */
  url: string;
  bytes: Uint8Array;
};

export type FakeApiOptions = {
  /** Statuses returned by successive polls of each project. The last one repeats. */
  statuses?: string[];
  /** HTTP status for generation requests. Anything but 200 rejects the job. */
  createStatus?: number;
  /** Response body for accepted generation requests. */
  createBody?: (n: number) => unknown;
  /** Makes generation requests fail like a dropped connection. */
  createNetworkError?: boolean;
  /** Answers generation requests with a 307 redirect to the same endpoint. */
  createRedirect?: boolean;
  /** HTTP status for project polls. */
  projectStatus?: number;
  /** The `error` object on failed projects. */
  projectError?: { message: string; code: string };
  /** Overrides the downloads listed on a complete project. */
  downloads?: (project: Project) => { url: string; expires_at: string }[];
  creditsCharged?: number;
  /** HTTP status for media downloads. */
  downloadStatus?: number;
  /** Response body for the upload-URL request. */
  uploadUrlsBody?: unknown;
  /** HTTP status for the upload PUT. */
  uploadStatus?: number;
  /** Text included in error responses, to check it never reaches error messages. */
  errorBody?: string;
  /** Requests that never get a response until they're aborted. */
  hold?: (call: Call) => boolean;
  /** Requests whose response headers arrive but whose body stalls until aborted. */
  holdBody?: (call: Call) => boolean;
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

export function isGeneration(call: Call): boolean {
  return (
    call.method === "POST" &&
    call.url.startsWith(`${API}/`) &&
    new URL(call.url).pathname in generationKinds
  );
}

/**
 * A strict stand-in for the Magic Hour API and its signed-URL storage. It only answers the exact
 * method, route and media type the real API accepts, keeps separate state per project, and
 * follows real `fetch` semantics for aborts and redirects.
 */
export function fakeApi(options: FakeApiOptions = {}) {
  const calls: Call[] = [];
  const projects = new Map<string, Project & { polls: number }>();
  const statuses = options.statuses ?? ["queued", "rendering", "complete"];

  function error(status: number): Response {
    return new Response(options.errorBody ?? `{"message":"HTTP ${status}"}`, { status });
  }

  function accept(path: string): Response {
    if (options.createStatus && options.createStatus !== 200) return error(options.createStatus);
    const n = projects.size + 1;
    const custom = options.createBody?.(n);
    if (custom !== undefined) return Response.json(custom);
    const kind = generationKinds[path];
    const id = `${kind}-${n}-${(n * 7919).toString(36)}`;
    const extension = kind === "image" ? "png" : "mp4";
    projects.set(id, {
      id,
      kind,
      url: `${STORAGE}/outputs/${id}.${extension}?X-Goog-Signature=signature-${n}&X-Goog-Expires=86400`,
      bytes: kind === "image" ? makePng(n * 40, 255 - n * 40, n) : makeMp4(n),
      polls: 0,
    });
    return Response.json({ id, credits_charged: 5 });
  }

  async function respond(call: Call, request: Request): Promise<Response> {
    const { url, method } = call;
    const path = url.startsWith(`${API}/`) ? new URL(url).pathname : "";
    const json = call.headers.get("Content-Type")?.startsWith("application/json");

    if (url.startsWith(`${STORAGE}/`)) {
      if (method === "PUT" && url === UPLOAD_URL)
        return new Response(null, { status: options.uploadStatus ?? 200 });
      const project = [...projects.values()].find((p) => p.url === url);
      if (method !== "GET" || !project) return error(404);
      const status = options.downloadStatus ?? 200;
      if (status !== 200) return error(status);
      if (options.holdBody?.(call))
        return new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener("abort", () =>
                controller.error(abortError(request.signal))
              );
            },
          })
        );
      return new Response(project.bytes as BodyInit);
    }

    if (method === "POST" && path === "/v1/files/upload-urls") {
      if (!json) return error(415);
      return Response.json(
        options.uploadUrlsBody ?? {
          items: [
            {
              upload_url: UPLOAD_URL,
              file_path: "api-assets/test/input.png",
              expires_at: "2099-01-01T00:00:00Z",
            },
          ],
        }
      );
    }

    if (method === "POST" && path in generationKinds) {
      if (!json) return error(415);
      if (options.createNetworkError) throw new TypeError("fetch failed");
      if (options.createRedirect) {
        // What the real fetch does with a 307 in each redirect mode.
        if (call.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
        if (call.redirect === "manual") return new Response(null, { status: 307 });
        calls.push({ ...call }); // "follow" replays the POST, body included
      }
      return accept(path);
    }

    const match = /^\/v1\/(image|video)-projects\/([^/]+)$/.exec(path);
    if (method === "GET" && match) {
      if (options.projectStatus && options.projectStatus !== 200)
        return error(options.projectStatus);
      const project = projects.get(decodeURIComponent(match[2]));
      if (!project || project.kind !== match[1]) return error(404);
      const status = statuses[Math.min(project.polls++, statuses.length - 1)];
      return Response.json({
        id: project.id,
        status,
        credits_charged: options.creditsCharged ?? 5,
        error: status === "error" ? (options.projectError ?? null) : null,
        downloads:
          status === "complete"
            ? (options.downloads?.(project) ?? [
                { url: project.url, expires_at: "2099-01-01T00:00:00Z" },
              ])
            : [],
      });
    }
    return error(404);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    // Like the real fetch, an already-aborted request never reaches the network.
    if (request.signal.aborted) throw abortError(request.signal);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const type = request.headers.get("Content-Type") ?? "";
    const call: Call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      body: bytes.length
        ? type.startsWith("application/json")
          ? JSON.parse(new TextDecoder().decode(bytes))
          : bytes
        : undefined,
    };
    calls.push(call);
    if (options.hold?.(call)) return untilAborted(request.signal);
    const delay = options.delay?.(call);
    if (delay) await sleep(delay, request.signal);
    return respond(call, request);
  };

  return {
    calls,
    fetch,
    /** Accepted projects, in order. */
    projects: () => [...projects.values()],
    /** Requests that start a paid generation. */
    generations: () => calls.filter(isGeneration),
    polls: () => calls.filter((c) => /-projects\//.test(c.url)),
    storage: () => calls.filter((c) => c.url.startsWith(`${STORAGE}/`)),
    /** Requests that leave https://api.magichour.ai. */
    offOrigin: () => calls.filter((c) => new URL(c.url).origin !== API),
    provider: (settings: MagicHourSettings = {}) =>
      createMagicHour({ apiKey: "test-key", fetch, pollIntervalMs: 0, ...settings }),
  };
}
