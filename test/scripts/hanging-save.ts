// Run in a separate Node process: a save callback that never settles, with nothing else keeping
// the process alive. The call must still end with the accepted project ID at the deadline.
import { generateImage } from "ai";
import { createMagicHour, MagicHourError } from "../../src/index.js";

const fetch: typeof globalThis.fetch = async () =>
  Response.json({ id: "image-77-hang", frame_cost: 1, credits_charged: 1 });
const model = createMagicHour({
  apiKey: "test-key",
  fetch,
  timeoutMs: 300,
  onProjectCreated: () => new Promise<void>(() => {}),
}).image();
try {
  await generateImage({ model, prompt: "Mug", maxRetries: 0 });
  console.log("unexpected success");
} catch (error) {
  console.log(error instanceof MagicHourError ? `projectId=${error.projectId}` : `other: ${error}`);
}
