import type { Experimental_VideoModelV4 as VideoModelV4 } from "@ai-sdk/provider";
import { MagicHourError, type CreateBody, type MagicHourClient } from "@magichourhq/browser-client";
import {
  dimensions,
  extra,
  isOneOf,
  ratio,
  ratioFromSize,
  videoResolutions,
  type VideoResolution,
} from "./options.js";
import { filePath, inputImage, submit } from "./requests.js";

type VideoModel = NonNullable<CreateBody<"text-to-video">["model"]>;
export type MagicHourVideoModelId = VideoModel | NonNullable<CreateBody<"image-to-video">["model"]>;

/** Generates videos from text, or from an input image. */
export function videoModel(
  modelId: MagicHourVideoModelId,
  client: () => MagicHourClient
): VideoModelV4 {
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
      const aspectRatio = options.image ? undefined : ratio(options.aspectRatio ?? dimensionsRatio);
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
