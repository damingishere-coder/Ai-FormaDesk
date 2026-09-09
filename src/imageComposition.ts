import type { RenderSettings } from "./types";

export const imagePresets = {
  landscape: { width: 1280, height: 720 },
  square: { width: 1024, height: 1024 },
  portrait: { width: 720, height: 1280 },
};

export function imagePreset(settings: RenderSettings) {
  if (!validImageSettings(settings)) return "custom";
  if (settings.width * 9 === settings.height * 16) return "landscape";
  if (settings.width === settings.height) return "square";
  if (settings.width * 16 === settings.height * 9) return "portrait";
  return "custom";
}

export function validImageSettings(settings: RenderSettings) {
  return [settings.width, settings.height].every(
    (value) => Number.isInteger(value) && value >= 256 && value <= 4096,
  );
}
