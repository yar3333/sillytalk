import { ImageGenerator, isComfyUiGenerator } from "../configuration/ImageGenerator";
import { ComfyUiDriver } from "./drivers/ComfyUiDriver";
import { SdApiDriver } from "./drivers/SdApiDriver";
import { IImageGeneratorDriver } from "./IImageGeneratorDriver";

// Builds the driver for a config entry: the generator names its own kind
// ("comfyui" / "sdapi"), and the guard picks the backend that speaks it.
export class DriverFactory {
  create(gen: ImageGenerator): IImageGeneratorDriver {
    return isComfyUiGenerator(gen) ? new ComfyUiDriver(gen) : new SdApiDriver(gen);
  }
}
