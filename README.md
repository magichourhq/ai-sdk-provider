# Magic Hour provider for the AI SDK

Generate and edit images, and generate videos, with [Magic Hour](https://magichour.ai) from the [AI SDK](https://ai-sdk.dev).

## Install

```sh
npm install @magichourhq/ai-sdk-provider ai
```

Requires AI SDK 7 and Node.js 22 or newer.

## Usage

Set `MAGIC_HOUR_API_KEY`, then:

```ts
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { magichour } from "@magichourhq/ai-sdk-provider";

const { image } = await generateImage({
  model: magichour.image("flux-2-klein"),
  prompt: "A ceramic mug on a studio background",
  aspectRatio: "1:1",
});

const { video } = await generateVideo({
  model: magichour.video("ltx-2.5"),
  prompt: { image: image.uint8Array, text: "A slow camera push toward the mug" },
});
```

For text-to-video, pass a string prompt. An input image can be bytes, base64 or an HTTPS URL.

To edit images, pass them with the prompt. Up to 10 PNG, JPEG or WebP images:

```ts
const { image: edited } = await generateImage({
  model: magichour.image("flux-2-klein"),
  prompt: { text: "Make the mug matte blue", images: [image.uint8Array] },
});
```

To configure the provider in code, use `createMagicHour`:

```ts
import { createMagicHour } from "@magichourhq/ai-sdk-provider";

const magichour = createMagicHour({ apiKey: process.env.MY_KEY, timeoutMs: 300_000 });
```

| Setting | Default |
| --- | --- |
| `apiKey` | `MAGIC_HOUR_API_KEY`, read when each call starts |
| `timeoutMs` | 10 minutes for the whole call: upload, generation and download |
| `pollIntervalMs` | 2 seconds |
| `onProjectCreated` | Called with `{ id, kind }` as soon as the job is accepted |
| `fetch` | The global `fetch` |

## Models and options

Every model in the [Magic Hour API](https://docs.magichour.ai/api-reference/models) works, for example `flux-2-klein`, `nano-banana-2.1` or `gpt-image-2` for images, and `ltx-2.5`, `kling-4.0` or `veo3.1` for video. Known model IDs come from the API spec for autocomplete, and any other ID is passed through, so a new model works before the next release. Each model has its own resolutions, durations, aspect ratios and plan tiers. The API checks them and rejects a request it can't run before charging anything.

| | Image | Video |
| --- | --- | --- |
| Resolution | `640px`, `1k`, `2k`, `4k` | `360p`, `480p`, `720p`, `1080p`, `4k` |
| Aspect ratio | `1:1`, `16:9`, `9:16`; editing also takes `auto`, `4:3`, `3:2`, `4:5` and `2:3` | `1:1`, `16:9` (default), `9:16` |

- Without a resolution, the API picks the model's default. Set one with `providerOptions: { magichour: { resolution } }`, or with the AI SDK's `size` for images (640, 1024 or 2048 on the longest edge) and `resolution` for videos (360, 480, 720, 1080 or 2160 on the shortest edge).
- Video `duration` is 5 seconds by default. Some models only take certain durations; Kling 2.6, for example, takes 5 or 10. `generateAudio` is passed through.
- Image-to-video keeps the input image's shape, so it takes no aspect ratio.
- Editing uses Magic Hour's AI Image Editor, with any model the editor offers. Without an aspect ratio, the editor uses `auto`. Each model accepts a different number of input images.
- Seeds, FPS, masks and video frame or reference inputs aren't supported. They throw before anything is sent.
- `default` follows Magic Hour's current recommendation, so its output and cost can change. Choose a model to keep them fixed. See [pricing](https://docs.magichour.ai/pricing).

## Credits and plans

Each generation uses credits from your Magic Hour account. The cost depends on the model, the resolution and, for video, the duration. See [pricing](https://docs.magichour.ai/pricing).

Some models and settings need a paid plan (Creator, Pro or Business). On a plan that doesn't include them, the API refuses the request.

When the API refuses a request, nothing is charged. The error is a `MagicHourError` with the API's `status` and `code`, and names the operation and model. Credit and plan problems have status 402:

| Code | Meaning |
| --- | --- |
| `insufficient_credits` | Your account doesn't have enough credits. |
| `subscription_required` | This needs a subscription. |
| `plan_upgrade_required` | Your plan doesn't include this model or setting. |

```
Magic Hour can't edit images with gpt-image-2: Please upgrade to creator, pro, or business to create an edit with this model
```

Each image's or video's project ID and credits charged are in `providerMetadata.magichour.images` or `providerMetadata.magichour.videos`.

## Failures

Because generations cost credits, the provider submits each request once, waits for it to finish and downloads the result.

- **Requests are never retried**, by the provider or by the AI SDK, so a retry can't charge you twice. Don't wrap calls in your own retry.
- **Once Magic Hour accepts a job, every error has its `projectId`.** Fetch the result with `GET /v1/image-projects/{id}` or `GET /v1/video-projects/{id}` instead of generating again. To keep the ID even if your process stops, save it in `onProjectCreated`.
- **If it's unknown whether a submission went through**, for example after a dropped connection, the error says so and has no `projectId`. Check your account history before submitting again.
- **Aborting stops waiting.** It doesn't cancel the job on Magic Hour.

## Development

```sh
yarn install
yarn check
yarn test
yarn build
```

`yarn example` generates a real image, and `yarn example --video` a video too. Both spend credits.

## License

MIT
