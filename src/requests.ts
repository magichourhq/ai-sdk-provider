import type { ImageModelV4File } from "@ai-sdk/provider";
import type {
  EstimateAudioListResponse,
  EstimateImageListResponse,
  EstimateVideoListResponse,
} from "@magichourhq/api-types";
import { MagicHourClient, MagicHourError, httpsURL } from "@magichourhq/browser-client";

const estimateFields = {
  image: ["tool", "model", "resolution", "image_count", "scale_factor", "mode"],
  video: ["tool", "end_seconds", "start_seconds", "model", "resolution", "audio", "has_video_reference"],
  audio: ["tool", "character_count", "duration"],
} as const;

type EstimateType = keyof typeof estimateFields;

export function isEstimateType(type: string): type is EstimateType {
  return Object.hasOwn(estimateFields, type);
}

export async function estimateCredits(
  type: EstimateType,
  params: Record<string, unknown>,
  apiKey: string,
  request: typeof fetch,
  signal: AbortSignal
): Promise<EstimateImageListResponse | EstimateVideoListResponse | EstimateAudioListResponse> {
  const query = new URLSearchParams();
  for (const name of estimateFields[type]) {
    const value = params[name];
    if (value !== undefined) query.set(name, String(value));
  }
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await request(`https://api.magichour.ai/v1/estimate/${type}?${query}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new MagicHourError(`Magic Hour ${type} estimate request failed.`);
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new MagicHourError(
      error?.message || `Magic Hour ${type} estimate failed (HTTP ${response.status}).`,
      undefined,
      response.status,
      undefined,
      error?.code
    );
  }
  return response.json();
}

// Input images and paid submissions: everything that sends something to Magic Hour.
function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}
/** Checks the file signature, so mislabeled or non-image data never reaches a paid job. */
function hasSignature(bytes: Uint8Array, extension: string): boolean {
  function startsWith(offset: number, signature: number[]): boolean {
    return signature.every((byte, i) => bytes[offset + i] === byte);
  }
  if (extension === "png") return startsWith(0, [0x89, ...ascii("PNG\r\n"), 0x1a, 0x0a]);
  if (extension === "jpg") return startsWith(0, [0xff, 0xd8, 0xff]);
  return startsWith(0, ascii("RIFF")) && startsWith(8, ascii("WEBP"));
}
/** Decodes strict base64, which `Buffer.from` would otherwise accept with characters dropped. */
function base64Bytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("Image data must be base64.");
  return new Uint8Array(Buffer.from(value, "base64"));
}
export type InputImage = { url: string } | { bytes: Uint8Array; extension: string };
/** Checks an input image without uploading it, so a bad file never follows a good upload. */
export function inputImage(file: ImageModelV4File): InputImage {
  if (file.type === "url") return { url: httpsURL(file.url) };
  const extension = (
    { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>
  )[file.mediaType];
  if (!extension) throw new Error("Input images must be PNG, JPEG, or WebP.");
  const bytes = typeof file.data === "string" ? base64Bytes(file.data) : file.data;
  if (!hasSignature(bytes, extension))
    throw new Error(`The input image data isn't a ${extension.toUpperCase()} file.`);
  return { bytes, extension };
}
export async function filePath(
  transport: MagicHourClient,
  input: InputImage,
  signal: AbortSignal
): Promise<string> {
  if ("url" in input) return input.url;
  return transport.uploadImage(input.bytes, input.extension, signal);
}
/**
 * Names the operation and model in an API rejection. One model setting reaches several endpoints,
 * so the API's own message ("model must be one of …") doesn't say which one refused it.
 */
export async function submit(action: string, modelId: string, create: () => Promise<string>) {
  try {
    return await create();
  } catch (error) {
    if (error instanceof MagicHourError && error.status! < 500 && !error.projectId)
      throw new MagicHourError(
        `Magic Hour can't ${action} with ${modelId}: ${error.message}`,
        undefined,
        error.status,
        undefined,
        error.code,
        error.creditShortfall,
        error
      );
    throw error;
  }
}
