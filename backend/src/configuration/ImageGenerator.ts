import { ComfyUiSettings } from "./ComfyUiSettings";

// imageGenerators entry. The app draws through one backend only — a ComfyUI
// server running the comfyui-sillytalk plugin — so every entry names its kind
// with the explicit `kind` field ("comfyui"); an entry without a known kind is
// dropped by the config normalization, the app never guesses a type from the
// fields that happen to be set. The settings types live in the configuration
// domain because they describe the config.json schema — the image_generation
// domain imports them, never the other way.
export type ImageGenerator = ComfyUiSettings;

export function isComfyUiGenerator(g: ImageGenerator): g is ComfyUiSettings {
  return (g as { kind?: unknown }).kind === "comfyui";
}
