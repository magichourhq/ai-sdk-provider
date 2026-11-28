import {
  LoadAPIKeyError,
  NoSuchModelError,
  type ImageModelV4,
  type Experimental_VideoModelV4 as VideoModelV4,
  type ProviderV4,
} from "@ai-sdk/provider";
import type {
  EstimateAudioListParams,
  EstimateAudioListResponse,
  EstimateImageListParams,
  EstimateImageListResponse,
  EstimateVideoListParams,
  EstimateVideoListResponse,
} from "@magichourhq/api-types";
import { MagicHourClient, type ClientSettings } from "@magichourhq/browser-client";
import { imageModel, type MagicHourImageModelId } from "./image.js";
import { estimateCredits, isEstimateType } from "./requests.js";
import { videoModel, type MagicHourVideoModelId } from "./video.js";
export { MagicHourError } from "@magichourhq/browser-client";
export type {
  EstimateAudioListParams,
  EstimateAudioListResponse,
  EstimateImageListParams,
  EstimateImageListResponse,
  EstimateVideoListParams,
  EstimateVideoListResponse,
} from "@magichourhq/api-types";
export type { MagicHourImageModelId } from "./image.js";
export type { MagicHourVideoModelId } from "./video.js";
export type MagicHourSettings = Omit<ClientSettings, "apiKey"> & { apiKey?: string };
type EstimateOptions = { abortSignal?: AbortSignal };
export interface MagicHourProvider extends Omit<ProviderV4, "imageModel"> {
  image(modelId?: MagicHourImageModelId): ImageModelV4;
  imageModel(modelId?: MagicHourImageModelId): ImageModelV4;
  video(modelId?: MagicHourVideoModelId): VideoModelV4;
  videoModel(modelId?: MagicHourVideoModelId): VideoModelV4;
  estimate(
    type: "image",
    params: EstimateImageListParams,
    options?: EstimateOptions
  ): Promise<EstimateImageListResponse>;
  estimate(type: "video", params: EstimateVideoListParams, options?: EstimateOptions): Promise<EstimateVideoListResponse>;
  estimate(type: "audio", params: EstimateAudioListParams, options?: EstimateOptions): Promise<EstimateAudioListResponse>;
}
export function createMagicHour(settings: MagicHourSettings = {}): MagicHourProvider {
  // Resolve credentials lazily so merely importing or registering the provider needs no key.
  function apiKey(): string {
    const apiKey = settings.apiKey ?? process.env.MAGIC_HOUR_API_KEY;
    if (!apiKey?.trim())
      throw new LoadAPIKeyError({
        message:
          "Magic Hour API key is missing. Pass it with the apiKey setting or the MAGIC_HOUR_API_KEY environment variable.",
      });
    return apiKey.trim();
  }
  function client(key = apiKey()): MagicHourClient {
    return new MagicHourClient({ ...settings, apiKey: key });
  }
  function image(modelId: MagicHourImageModelId = "default"): ImageModelV4 {
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
    async estimate(
      type: string,
      params: EstimateAudioListParams | EstimateImageListParams | EstimateVideoListParams,
      options?: EstimateOptions
    ) {
      if (!isEstimateType(type)) throw new TypeError(`Unsupported estimate type: ${type}`);
      const key = apiKey();
      const signal = client(key).signal(options?.abortSignal);
      return estimateCredits(type, params, key, settings.fetch ?? fetch, signal);
    },
    languageModel(modelId: string): never {
      throw new NoSuchModelError({ modelId, modelType: "languageModel" });
    },
    embeddingModel(modelId: string): never {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
  };
}
export const magichour = createMagicHour();
