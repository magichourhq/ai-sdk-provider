import type { ImageModelV4 } from "@ai-sdk/provider";
import { MagicHourError, type CreateBody, type MagicHourClient } from "@magichourhq/browser-client";
import { extra, imageResolution, isOneOf, ratio, ratioFromSize } from "./options.js";
import { filePath, inputImage, submit } from "./requests.js";

// Model IDs come from the API spec through @magichourhq/api-types. The API checks each model's
// own limits (resolutions, durations, plan) and rejects a bad request before it charges anything.
type GenerateImageModel = NonNullable<CreateBody<"ai-image-generator">["model"]>;
type EditImageModel = NonNullable<CreateBody<"ai-image-editor">["model"]>;
const editAspectRatios = ["auto", "1:1", "16:9", "9:16", "4:3", "3:2", "4:5", "2:3"] as const;
export type MagicHourImageModelId = GenerateImageModel | EditImageModel;

/** Generates images, or edits them when the prompt includes input images. */
export function imageModel(modelId: string, client: () => MagicHourClient): ImageModelV4 {
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
