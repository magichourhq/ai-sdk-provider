// Calls the real Magic Hour API and spends credits. Run with `yarn test:live` and a
// MAGIC_HOUR_API_KEY. Skipped in normal test runs.
import { generateImage } from "ai";
import { describe, expect, test } from "vitest";
import { createMagicHour, MagicHourError } from "../src/index.js";

describe.skipIf(!process.env.MAGIC_HOUR_LIVE)("live Magic Hour API", () => {
  test("generates a 640px image through the AI SDK", { timeout: 300_000 }, async () => {
    const result = await generateImage({
      model: createMagicHour().image("flux-2-klein"),
      prompt: "A small red apple on a white table",
      aspectRatio: "1:1",
      maxRetries: 0,
    });
    expect(Array.from(result.image.uint8Array.slice(0, 4))).toEqual([137, 80, 78, 71]);
    const [image] = result.providerMetadata.magichour.images as {
      projectId: string;
      creditsCharged: number;
    }[];
    expect(image.projectId).toBeTruthy();
    expect(image.creditsCharged).toBeGreaterThan(0);
  });

  test("an invalid key is rejected with HTTP 401 and no retry", async () => {
    const error = await generateImage({
      model: createMagicHour({ apiKey: "invalid-key" }).image(),
      prompt: "A small red apple",
      maxRetries: 3,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MagicHourError);
    expect((error as MagicHourError).status).toBe(401);
  });
});
