import { describe, expect, it } from "vitest";
import { videoFrameClock } from "../src/videoTiming";
import { videoSettingsSchema } from "../src/types";

describe("video frame timing", () => {
  it.each([30, 60])("maintains %i fps despite animation callback jitter", (fps) => {
    const due = videoFrameClock(fps);
    let count = 0;
    for (let i = 1; i <= 600; i++) {
      if (due(i / 60 + (i % 2 ? -0.0003 : 0.0003))) count++;
    }
    expect(count).toBe(fps * 10);
  });
  it("skips missed frames without a burst or shifting later deadlines", () => {
    const due = videoFrameClock(60);
    expect(due(0.1)).toBe(true);
    expect(due(0.1)).toBe(false);
    expect(due(7 / 60)).toBe(true);
  });
  it("accepts 60 fps live recordings and older 30 fps files, keeping fine render at 30", () => {
    const settings = { width: 1280, height: 720, mode: "realtime" };
    expect(videoSettingsSchema.safeParse({ ...settings, fps: 60 }).success).toBe(true);
    expect(videoSettingsSchema.safeParse({ ...settings, fps: 30 }).success).toBe(true);
    expect(videoSettingsSchema.safeParse({ ...settings, fps: 60, mode: "blender" }).success).toBe(false);
  });
});
