import { ImageGenerator, isComfyUiGenerator } from "../configuration/ImageGenerator";
import { ComfyUiDriver } from "./drivers/ComfyUiDriver";
import { IImageGeneratorDriver } from "./IImageGeneratorDriver";

// Builds the driver for a config entry. The app draws through one backend — a
// ComfyUI server running the comfyui-sillytalk plugin — so the guard is the
// backstop for an entry the config normalization somehow let through, not a
// branch between backends.
export class DriverFactory {
  create(gen: ImageGenerator): IImageGeneratorDriver {
    if (!isComfyUiGenerator(gen)) {
      throw new Error(`Unknown image generator kind "${String((gen as { kind?: unknown }).kind)}"`);
    }
    return new ComfyUiDriver(gen);
  }
}
