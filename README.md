# Magic Hour provider for the AI SDK

Generate images and videos with [Magic Hour](https://magichour.ai) from the [AI SDK](https://ai-sdk.dev).

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

| | Image | Video |
| --- | --- | --- |
| Models | `default`, `flux-2-klein`, `z-image-turbo`, `qwen-image-2.1` | `default`, `ltx-2.5`, `minimax-h3`, `wan-2.2` |
| Resolution | `640px` (default), `1k`, `2k` | `360p`, `480p` (default), `720p`, `1080p`, `4k` |
| Aspect ratio | `1:1`, `16:9`, `9:16` | `1:1`, `16:9` (default), `9:16` |

- Set the resolution with `providerOptions: { magichour: { resolution } }`, or with the AI SDK's `size` for images (640, 1024 or 2048 on the longest edge) and `resolution` for videos (360, 480, 720, 1080 or 2160 on the shortest edge).
- Video `duration` is 1 to 60 seconds, 5 by default. `generateAudio` is passed through.
- Image-to-video keeps the input image's shape, so it takes no aspect ratio.
- Seeds, FPS, image editing and frame or reference inputs aren't supported. They throw before anything is sent.
- `default` follows Magic Hour's current recommendation, so its output and cost can change. Choose a model to keep them fixed. See [pricing](https://docs.magichour.ai/pricing).

## Credits and failures

Every generation is a paid job. The provider submits it once, waits for it to finish and downloads the result.

- **Paid requests are never retried**, by the provider or by the AI SDK. Don't wrap calls in your own retry.
- **Once a job is accepted, every error names it.** Errors are `MagicHourError` with a `projectId`. Fetch the result with `GET /v1/image-projects/{id}` or `GET /v1/video-projects/{id}` instead of generating again. To keep the ID even if the process dies, save it in `onProjectCreated`.
- **If a submission's outcome is unknown**, for example after a dropped connection, the error says so and has no `projectId`. Check your account history before submitting again.
- **Aborting stops waiting.** It doesn't cancel the job on Magic Hour.

Each job's project ID and credits charged are in `providerMetadata.magichour.images` or `providerMetadata.magichour.videos`, one entry per image or video.

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
