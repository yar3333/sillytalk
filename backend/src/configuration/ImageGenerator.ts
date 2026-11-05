import { ComfyUiSettings } from "./ComfyUiSettings";
import { SdApiSettings } from "./SdApiSettings";

// imageGenerators entry: every generator names its own kind with the explicit
// `kind` field ("comfyui" / "sdapi") — an entry without a known kind is
// dropped by the config normalization, the app never guesses a type from the
// fields that happen to be set. The settings types live in the configuration
// domain because they describe the config.json schema — the image_generation
// domain imports them, never the other way.
export type ImageGenerator = SdApiSettings | ComfyUiSettings;

export function isComfyUiGenerator(g: ImageGenerator): g is ComfyUiSettings {
  return (g as { kind?: unknown }).kind === "comfyui";
}

export function isSdApiGenerator(g: ImageGenerator): g is SdApiSettings {
  return (g as { kind?: unknown }).kind === "sdapi";
}
