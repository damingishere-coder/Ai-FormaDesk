import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { correctionBounds, correctionMask } from "../server/image-correction";

const patch = {
  view: 0,
  left: 0.25,
  top: 0.25,
  right: 0.5,
  bottom: 0.5,
  prompt: "Plain cream cushion on the original wooden chair",
};
describe("automatic local texture correction boundary", () => {
  it("rejects broad repainting, reversed boxes and invalid coordinates", () => {
    for (const change of [
      { left: 0, top: 0, right: 1, bottom: 1 },
      { right: 0.1 },
      { left: NaN },
      { view: 4 },
      { bottom: 0.2501 },
      { prompt: " " },
    ])
      expect(() => correctionBounds({ ...patch, ...change })).toThrow();
  });
  it("writes an exact black outside region and opaque selection", async () => {
    const data = await sharp(await correctionMask(patch))
      .greyscale()
      .raw()
      .toBuffer();
    expect(data.length).toBe(512 * 512);
    let selected = 0,
      mismatched = 0;
    for (let y = 0; y < 512; y++)
      for (let x = 0; x < 512; x++) {
        const expected = x >= 128 && x < 256 && y >= 128 && y < 256 ? 255 : 0;
        if (data[y * 512 + x] !== expected) mismatched++;
        if (expected) selected++;
      }
    expect(selected).toBe(128 * 128);
    expect(mismatched).toBe(0);
  });
});
