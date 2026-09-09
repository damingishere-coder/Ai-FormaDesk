import { describe, expect, it } from "vitest";
import { imagePreset, validImageSettings } from "../src/imageComposition";
import { defaultRenderSettings } from "../src/types";

describe("图片取景尺寸", () => {
  it("比例按实际尺寸识别，不依赖用户是否点过预设", () => {
    expect(imagePreset(defaultRenderSettings)).toBe("landscape");
    expect(imagePreset({ width: 1920, height: 1080, transparent: true })).toBe(
      "landscape",
    );
    expect(imagePreset({ width: 512, height: 512, transparent: false })).toBe(
      "square",
    );
    expect(imagePreset({ width: 1080, height: 1920, transparent: false })).toBe(
      "portrait",
    );
    expect(imagePreset({ width: 900, height: 700, transparent: false })).toBe(
      "custom",
    );
  });
  it("编辑中的空值、非法尺寸不能进入渲染请求", () => {
    for (const width of [0, 255, 4097, NaN, Infinity, 800.5]) {
      const settings = { width, height: 720, transparent: false };
      expect(validImageSettings(settings)).toBe(false);
      expect(imagePreset(settings)).toBe("custom");
    }
    expect(
      validImageSettings({ width: 256, height: 4096, transparent: false }),
    ).toBe(true);
  });
});
