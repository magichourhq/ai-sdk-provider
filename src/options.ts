import type {
  ImageModelV4CallOptions,
  Experimental_VideoModelV4CallOptions as VideoModelV4CallOptions,
} from "@ai-sdk/provider";

// Checks and conversions for the AI SDK's call options, shared by the image and video models.
export const aspectRatios = ["1:1", "16:9", "9:16"] as const;
export type AspectRatio = (typeof aspectRatios)[number];
export const imageResolutions = ["640px", "1k", "2k", "4k"] as const;
export type ImageResolution = (typeof imageResolutions)[number];
export const videoResolutions = ["360p", "480p", "720p", "1080p", "4k"] as const;
export type VideoResolution = (typeof videoResolutions)[number];
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}
export function ratio(value: string | undefined): AspectRatio | undefined {
  if (value === undefined) return undefined;
  if (!isOneOf(aspectRatios, value)) throw new Error("Supported aspect ratios: 1:1, 16:9, 9:16.");
  return value;
}
export function extra(
  options: ImageModelV4CallOptions | VideoModelV4CallOptions,
  allowed: string[]
) {
  const values = options.providerOptions?.magichour ?? {};
  for (const key of Object.keys(values))
    if (!allowed.includes(key)) throw new Error(`Unsupported Magic Hour option: ${key}.`);
  return values;
}
/** Parses "WIDTHxHEIGHT" with positive whole numbers. */
export function dimensions(value: string): [width: number, height: number] {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (!match) throw new Error("Dimensions must look like 1024x1024.");
  return [Number(match[1]), Number(match[2])];
}
export function imageResolution(
  size: string | undefined,
  option: unknown
): ImageResolution | undefined {
  if (option !== undefined && !isOneOf(imageResolutions, option))
    throw new Error("Image resolution must be 640px, 1k, 2k, or 4k.");
  if (!size) return option;
  if (option !== undefined)
    throw new Error("Use either size or providerOptions.magichour.resolution.");
  // Magic Hour exposes longest-edge tiers, rather than arbitrary pixel sizes.
  const edge = Math.max(...dimensions(size));
  const tier = new Map<number, ImageResolution>([
    [640, "640px"],
    [1024, "1k"],
    [2048, "2k"],
  ]).get(edge);
  if (!tier)
    throw new Error(
      "Use a 640, 1024, or 2048 longest edge, or set providerOptions.magichour.resolution."
    );
  return tier;
}
export function ratioFromSize(size: string | undefined): AspectRatio | undefined {
  if (!size) return undefined;
  const [w, h] = dimensions(size);
  for (const r of aspectRatios) {
    const [rw, rh] = r.split(":").map(Number);
    if (Math.abs(w / h - rw / rh) < 0.002) return r;
  }
  throw new Error("Dimensions must have a 1:1, 16:9, or 9:16 aspect ratio.");
}
