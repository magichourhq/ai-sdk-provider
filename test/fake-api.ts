import { createMagicHour, type MagicHourSettings } from "../src/index.js";

export const API = "https://api.magichour.ai";
// Uploads and outputs live on a separate host, behind signed URLs.
export const STORAGE = "https://videos.magichour.ai";

// Only the first bytes of each format, which is all the provider and the AI SDK look at.
export const png = new Uint8Array([0x89, ...Buffer.from("PNG\r\n\x1a\n"), 1, 2, 3]);
export const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
export const webp = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
export const gif = new Uint8Array([...Buffer.from("GIF89a"), 1, 2, 3]);

export type Call = {
  url: string;
  method: string;
  headers: Headers;
  /** Parsed JSON for JSON requests, otherwise the raw bytes. */
  body: any;
};

export type FakeApiOptions = {
  /** Statuses returned by successive polls of a project. The last one repeats. */
  statuses?: string[];
  /** Rejects generation requests with this HTTP status. */
  createStatus?: number;
  /** Accepts generation requests, then fails like a dropped connection. */
  createNetworkError?: boolean;
  /** Fails the input image upload with this HTTP status. */
  uploadStatus?: number;
  /** Fails the output download with this HTTP status. */
  downloadStatus?: number;
};

const kinds = {
  "/v1/ai-image-generator": "image",
  "/v1/text-to-video": "video",
  "/v1/image-to-video": "video",
} as const;

/** A stand-in for the Magic Hour API and its storage, passed to the provider as `fetch`. */
export function fakeApi(options: FakeApiOptions = {}) {
  const calls: Call[] = [];
  const projects: { id: string; kind: string; url: string; bytes: Uint8Array; polls: number }[] =
    [];
  const uploads: { url: string; filePath: string; bytes?: Uint8Array }[] = [];

  function error(status: number): Response {
    // Retry-After invites a retry, which a paid request must never get.
    return Response.json(
      { message: `Request failed (${status})` },
      { status, headers: { "Retry-After": "1" } }
    );
  }

  function respond({ url, method, body }: Call): Response {
    const { origin, pathname } = new URL(url);

    if (origin === STORAGE && method === "PUT") {
      const upload = uploads.find((u) => u.url === url);
      if (!upload) return error(403);
      if (options.uploadStatus) return error(options.uploadStatus);
      upload.bytes = body;
      return new Response(null);
    }
    if (origin === STORAGE && method === "GET") {
      const project = projects.find((p) => p.url === url);
      if (!project) return error(404);
      if (options.downloadStatus) return error(options.downloadStatus);
      return new Response(project.bytes as BodyInit);
    }
    if (origin !== API) return error(404);

    if (method === "POST" && pathname === "/v1/files/upload-urls") {
      const n = uploads.length + 1;
      const upload = {
        url: `${STORAGE}/uploads/input-${n}?X-Goog-Signature=up%2F${n}`,
        filePath: `api-assets/input-${n}`,
      };
      uploads.push(upload);
      return Response.json({
        items: [
          {
            upload_url: upload.url,
            file_path: upload.filePath,
            expires_at: "2099-01-01T00:00:00Z",
          },
        ],
      });
    }

    if (method === "POST" && pathname in kinds) {
      if (options.createStatus) return error(options.createStatus);
      const kind = kinds[pathname as keyof typeof kinds];
      const n = projects.length + 1;
      const id = `${kind}-${n}`;
      projects.push({
        id,
        kind,
        url: `${STORAGE}/outputs/${id}?X-Goog-Signature=out%2F${n}`,
        bytes: new Uint8Array([...png, n]),
        polls: 0,
      });
      if (options.createNetworkError) throw new TypeError("fetch failed");
      // The charge here is an estimate. The project's own charge comes from polling.
      return Response.json({ id, credits_charged: 1 });
    }

    const match = /^\/v1\/(image|video)-projects\/([^/]+)$/.exec(pathname);
    const project = match && projects.find((p) => p.kind === match[1] && p.id === match[2]);
    if (method === "GET" && project) {
      const statuses = options.statuses ?? ["queued", "rendering", "complete"];
      const status = statuses[Math.min(project.polls++, statuses.length - 1)];
      return Response.json({
        id: project.id,
        status,
        credits_charged: 5,
        downloads:
          status === "complete" ? [{ url: project.url, expires_at: "2099-01-01T00:00:00Z" }] : [],
      });
    }
    return error(404);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    // Like the real fetch, an aborted request never reaches the network.
    if (request.signal.aborted) throw request.signal.reason;
    const bytes = new Uint8Array(await request.arrayBuffer());
    const json = request.headers.get("Content-Type")?.startsWith("application/json");
    const call: Call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: json ? JSON.parse(new TextDecoder().decode(bytes)) : bytes,
    };
    calls.push(call);
    return respond(call);
  };

  return {
    calls,
    fetch,
    /** Accepted projects, in order. */
    projects,
    /** Upload URLs issued, in order, with the bytes sent to each. */
    uploads,
    /** Requests that start a paid job. */
    generations: () => calls.filter((c) => c.method === "POST" && new URL(c.url).pathname in kinds),
    polls: () => calls.filter((c) => /-projects\//.test(c.url)),
    storage: () => calls.filter((c) => c.url.startsWith(STORAGE)),
    provider: (settings: MagicHourSettings = {}) =>
      createMagicHour({ apiKey: "test-key", fetch, pollIntervalMs: 0, ...settings }),
  };
}
