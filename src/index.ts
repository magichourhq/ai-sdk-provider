import {
  NoSuchModelError,
  type ImageModelV4,
  type Experimental_VideoModelV4 as VideoModelV4,
  type ProviderV4,
} from "@ai-sdk/provider";
import { MagicHourClient, type ClientSettings } from "@magichourhq/browser-client";
import { imageModel, type MagicHourImageModelId } from "./image.js";
import { videoModel, type MagicHourVideoModelId } from "./video.js";
export { MagicHourError } from "@magichourhq/browser-client";
export type { MagicHourImageModelId } from "./image.js";
export type { MagicHourVideoModelId } from "./video.js";
export type MagicHourSettings = Omit<ClientSettings, "apiKey"> & { apiKey?: string };
export interface MagicHourProvider extends Omit<ProviderV4, "imageModel"> {
  image(modelId?: MagicHourImageModelId): ImageModelV4;
  imageModel(modelId?: string): ImageModelV4;
  video(modelId?: MagicHourVideoModelId): VideoModelV4;
  videoModel(modelId?: MagicHourVideoModelId): VideoModelV4;
}
export function createMagicHour(settings: MagicHourSettings = {}): MagicHourProvider {
  // Resolve credentials lazily so merely importing or registering the provider needs no key.
  const client = () =>
    new MagicHourClient({
      ...settings,
      apiKey: settings.apiKey ?? process.env.MAGIC_HOUR_API_KEY ?? "",
    });
  function image(modelId: string = "default"): ImageModelV4 {
    return imageModel(modelId, client);
  }
  function video(modelId: MagicHourVideoModelId = "default"): VideoModelV4 {
    return videoModel(modelId, client);
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
