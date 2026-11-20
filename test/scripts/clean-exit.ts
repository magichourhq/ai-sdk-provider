// Run in a separate Node process: calls with the default timeoutMs, successful or failed, must
// leave nothing keeping the process alive, or a script or serverless function would hang for ten
// minutes.
import { experimental_generateVideo as generateVideo, generateImage } from "ai";
import { MagicHourError } from "../../src/index.js";
import { fakeApi, png } from "../fake-api.js";

const api = fakeApi({ statuses: ["complete"] });
const provider = api.provider();
await generateImage({ model: provider.image(), prompt: "Mug", maxRetries: 0 });
await generateVideo({
  model: provider.video(),
  prompt: { image: png, text: "Animate" },
  maxRetries: 0,
});
console.log(`done=${api.projects().length}`);

const failing = fakeApi({ statuses: ["error"] });
try {
  await generateImage({ model: failing.provider().image(), prompt: "Mug", maxRetries: 0 });
  console.log("unexpected success");
} catch (error) {
  console.log(error instanceof MagicHourError ? `failed=${error.projectId}` : `other: ${error}`);
}
