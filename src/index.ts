import {
  NoSuchModelError,
  type ImageModelV4,
  type ImageModelV4CallOptions,
  type ImageModelV4File,
  type Experimental_VideoModelV4 as VideoModelV4,
  type Experimental_VideoModelV4CallOptions as VideoModelV4CallOptions,
  type ProviderV4,
} from "@ai-sdk/provider";
import {
  MagicHourClient,
  MagicHourError,
  httpsURL,
  type ClientSettings,
  type CreateBody,
} from "@magichourhq/browser-client";
export { MagicHourError } from "@magichourhq/browser-client";
export type MagicHourSettings = Omit<ClientSettings, "apiKey"> & { apiKey?: string };
// Model IDs come from the API spec through @magichourhq/api-types. The API checks each model's
// own limits (resolutions, durations, plan) and rejects a bad request before it charges anything.
type GenerateImageModel = NonNullable<CreateBody<"ai-image-generator">["model"]>;
type EditImageModel = NonNullable<CreateBody<"ai-image-editor">["model"]>;
type VideoModel = NonNullable<CreateBody<"text-to-video">["model"]>;
const editAspectRatios = ["auto", "1:1", "16:9", "9:16", "4:3", "3:2", "4:5", "2:3"] as const;
export type MagicHourImageModelId = GenerateImageModel | EditImageModel;
export type MagicHourVideoModelId = VideoModel | NonNullable<CreateBody<"image-to-video">["model"]>;
const aspectRatios = ["1:1", "16:9", "9:16"] as const;
type AspectRatio = (typeof aspectRatios)[number];
const imageResolutions = ["640px", "1k", "2k", "4k"] as const;
type ImageResolution = (typeof imageResolutions)[number];
const videoResolutions = ["360p", "480p", "720p", "1080p", "4k"] as const;
type VideoResolution = (typeof videoResolutions)[number];
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}
export interface MagicHourProvider extends Omit<ProviderV4, "imageModel"> {
  image(modelId?: MagicHourImageModelId): ImageModelV4;
  imageModel(modelId?: string): ImageModelV4;
  video(modelId?: MagicHourVideoModelId): VideoModelV4;
  videoModel(modelId?: MagicHourVideoModelId): VideoModelV4;
}
function ratio(value: string | undefined): AspectRatio | undefined {
  if (value === undefined) return undefined;
  if (!isOneOf(aspectRatios, value)) throw new Error("Supported aspect ratios: 1:1, 16:9, 9:16.");
  return value;
}
function extra(options: ImageModelV4CallOptions | VideoModelV4CallOptions, allowed: string[]) {
  const values = options.providerOptions?.magichour ?? {};
  for (const key of Object.keys(values))
    if (!allowed.includes(key)) throw new Error(`Unsupported Magic Hour option: ${key}.`);
  return values;
}
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
/** Parses "WIDTHxHEIGHT" with positive whole numbers. */
function dimensions(value: string): [width: number, height: number] {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (!match) throw new Error("Dimensions must look like 1024x1024.");
  return [Number(match[1]), Number(match[2])];
}
type InputImage = { url: string } | { bytes: Uint8Array; extension: string };
/** Checks an input image without uploading it, so a bad file never follows a good upload. */
function inputImage(file: ImageModelV4File): InputImage {
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
async function filePath(
  transport: MagicHourClient,
  input: InputImage,
  signal: AbortSignal
): Promise<string> {
  if ("url" in input) return input.url;
  return transport.uploadImage(input.bytes, input.extension, signal);
}
function imageResolution(size: string | undefined, option: unknown): ImageResolution | undefined {
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
function ratioFromSize(size: string | undefined): AspectRatio | undefined {
  if (!size) return undefined;
  const [w, h] = dimensions(size);
  for (const r of aspectRatios) {
    const [rw, rh] = r.split(":").map(Number);
    if (Math.abs(w / h - rw / rh) < 0.002) return r;
  }
  throw new Error("Dimensions must have a 1:1, 16:9, or 9:16 aspect ratio.");
}
/**
 * Names the operation and model in an API rejection. One model setting reaches several endpoints,
 * so the API's own message ("model must be one of …") doesn't say which one refused it.
 */
async function submit(action: string, modelId: string, create: () => Promise<string>) {
  try {
    return await create();
  } catch (error) {
    if (error instanceof MagicHourError && error.status! < 500 && !error.projectId)
      throw new MagicHourError(
        `Magic Hour can't ${action} with ${modelId}. ${error.message}`,
        undefined,
        error.status,
        undefined,
        error.code
      );
    throw error;
  }
}
export function createMagicHour(settings: MagicHourSettings = {}): MagicHourProvider {
  // Resolve credentials lazily so merely importing or registering the provider needs no key.
  const client = () =>
    new MagicHourClient({
      ...settings,
      apiKey: settings.apiKey ?? process.env.MAGIC_HOUR_API_KEY ?? "",
    });
  function image(modelId: string = "default"): ImageModelV4 {
    return {
      specificationVersion: "v4",
      provider: "magichour.image",
      modelId,
      maxImagesPerCall: 1,
      // The API rejects input images for a model that can't edit, before charging anything.
      supportsFileInputs: true,
      supportsMaskInputs: false,
      async doGenerate(options) {
        const prompt = options.prompt;
        if (!prompt?.trim()) throw new Error("An image prompt is required.");
        if (options.n !== 1) throw new Error("One image per request is supported.");
        if (options.mask) throw new Error("Masks are not supported.");
        const files = options.files ?? [];
        if (files.length > 10) throw new Error("Image editing accepts up to 10 input images.");
        if (options.seed !== undefined)
          throw new Error("Magic Hour does not expose a seed parameter.");
        const extras = extra(options, ["resolution"]);
        const resolution = imageResolution(options.size, extras.resolution);
        const sizeRatio = ratioFromSize(options.size);
        if (sizeRatio && options.aspectRatio && sizeRatio !== options.aspectRatio)
          throw new Error("size and aspectRatio disagree.");
        const requestedRatio = options.aspectRatio ?? sizeRatio;
        if (files.length && requestedRatio && !isOneOf(editAspectRatios, requestedRatio))
          throw new Error(`Supported aspect ratios for editing: ${editAspectRatios.join(", ")}.`);
        const inputs = files.map(inputImage);
        const transport = client();
        const signal = transport.signal(options.abortSignal);
        let id: string;
        let timestamp: Date;
        if (inputs.length) {
          const paths: string[] = [];
          for (const input of inputs) paths.push(await filePath(transport, input, signal));
          timestamp = new Date();
          id = await submit("edit images", modelId, () =>
            transport.create(
              "ai-image-editor",
              {
                model: modelId as EditImageModel,
                image_count: 1,
                ...(resolution ? { resolution } : {}),
                // Without one, the editor uses `auto`.
                ...(requestedRatio
                  ? { aspect_ratio: requestedRatio as (typeof editAspectRatios)[number] }
                  : {}),
                style: { prompt },
                assets: { image_file_paths: paths },
              },
              signal,
              options.headers
            )
          );
        } else {
          const aspectRatio = ratio(requestedRatio);
          timestamp = new Date();
          id = await submit("generate images", modelId, () =>
            transport.create(
              "ai-image-generator",
              {
                model: modelId as GenerateImageModel,
                image_count: 1,
                ...(resolution ? { resolution } : {}),
                ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
                style: { prompt },
              },
              signal,
              options.headers
            )
          );
        }
        const project = await transport.wait(id, "image", signal, options.headers);
        try {
          const images = await Promise.all(
            project.downloads.slice(0, 1).map((d) => transport.download(d.url, signal))
          );
          return {
            images,
            warnings: [],
            isRetryable: false,
            response: { timestamp, modelId, headers: undefined },
            // The AI SDK keeps only this list, and joins it across calls.
            providerMetadata: {
              magichour: { images: [{ projectId: id, creditsCharged: project.credits_charged }] },
            },
          };
        } catch {
          throw new MagicHourError("Could not download the generated image.", id);
        }
      },
    };
  }
  function video(modelId: MagicHourVideoModelId = "default"): VideoModelV4 {
    return {
      specificationVersion: "v4",
      provider: "magichour.video",
      modelId,
      maxVideosPerCall: 1,
      async doGenerate(options) {
        if (options.n !== 1) throw new Error("One video per request is supported.");
        if (!options.prompt?.trim() && !options.image)
          throw new Error("A prompt or input image is required.");
        if (options.seed !== undefined || options.fps !== undefined)
          throw new Error("Magic Hour does not expose seed or FPS parameters.");
        if (options.frameImages?.length || options.inputReferences?.length)
          throw new Error("Frame and reference inputs are not supported by this adapter.");
        const extras = extra(options, ["resolution"]);
        if (extras.resolution !== undefined && !isOneOf(videoResolutions, extras.resolution))
          throw new Error("Invalid Magic Hour video resolution.");
        if (options.resolution && extras.resolution !== undefined)
          throw new Error("Use either resolution or providerOptions.magichour.resolution.");
        let resolution: VideoResolution | undefined = extras.resolution;
        const dimensionsRatio = ratioFromSize(options.resolution);
        if (options.resolution) {
          const shortEdge = Math.min(...dimensions(options.resolution));
          const mapped = new Map<number, VideoResolution>([
            [360, "360p"],
            [480, "480p"],
            [720, "720p"],
            [1080, "1080p"],
            [2160, "4k"],
          ]).get(shortEdge);
          if (!mapped)
            throw new Error(
              "Unsupported video dimensions; use a resolution tier in providerOptions.magichour."
            );
          resolution = mapped;
        }
        if (options.image && options.aspectRatio && options.aspectRatio !== "adaptive")
          throw new Error(
            "Image-to-video inherits the input image ratio; omit aspectRatio or use adaptive."
          );
        if (!options.image && options.aspectRatio === "adaptive")
          throw new Error("adaptive requires an input image.");
        const aspectRatio = options.image
          ? undefined
          : ratio(options.aspectRatio ?? dimensionsRatio);
        if (
          !options.image &&
          dimensionsRatio &&
          options.aspectRatio &&
          dimensionsRatio !== options.aspectRatio
        )
          throw new Error("resolution and aspectRatio disagree.");
        const duration = options.duration ?? 5;
        if (!Number.isFinite(duration) || duration < 1 || duration > 60)
          throw new Error(
            "Duration must be between 1 and 60 seconds; model-specific limits also apply."
          );
        // Validate all options before uploading input or submitting a paid generation.
        const transport = client();
        const signal = transport.signal(options.abortSignal);
        const imagePath = options.image
          ? await filePath(transport, inputImage(options.image), signal)
          : undefined;
        const timestamp = new Date();
        const shared = {
          model: modelId,
          end_seconds: duration,
          ...(resolution ? { resolution } : {}),
          ...(options.generateAudio !== undefined ? { audio: options.generateAudio } : {}),
        };
        const id = imagePath
          ? await submit("animate images", modelId, () =>
              transport.create(
                "image-to-video",
                {
                  ...shared,
                  ...(options.prompt ? { style: { prompt: options.prompt } } : {}),
                  assets: { image_file_path: imagePath },
                },
                signal,
                options.headers
              )
            )
          : await submit("generate videos", modelId, () =>
              transport.create(
                "text-to-video",
                {
                  ...shared,
                  style: { prompt: options.prompt ?? "" },
                  aspect_ratio: aspectRatio ?? "16:9",
                },
                signal,
                options.headers
              )
            );
        const project = await transport.wait(id, "video", signal, options.headers);
        try {
          const data = await transport.download(project.downloads[0].url, signal);
          return {
            videos: [{ type: "binary", data, mediaType: "video/mp4" }],
            warnings: [],
            response: { timestamp, modelId, headers: undefined },
            // A list, because the AI SDK joins only `videos` across calls and overwrites the rest.
            providerMetadata: {
              magichour: { videos: [{ projectId: id, creditsCharged: project.credits_charged }] },
            },
          };
        } catch {
          throw new MagicHourError("Could not download the generated video.", id);
        }
      },
    };
  }
  return {
    specificationVersion: "v4",
    image,
    imageModel: image,
    video,
    videoModel: video,
    languageModel(modelId: string): never {
      throw new NoSuchModelError({ modelId, modelType: "languageModel" });
    },
    embeddingModel(modelId: string): never {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
  };
}
export const magichour = createMagicHour();
