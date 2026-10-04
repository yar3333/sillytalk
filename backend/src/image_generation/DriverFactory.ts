import { ImageGenerator, isLocalGenerator } from "../configuration/ImageGenerator";
import { IMachineService } from "../machine/IMachineService";
import { LocalProgramDriver } from "./drivers/LocalProgramDriver";
import { SdApiDriver } from "./drivers/SdApiDriver";
import { IImageGeneratorDriver } from "./IImageGeneratorDriver";

// Builds the driver for a config entry: a local program by `command`,
// the SD API by `url` (the same type guard the config parsing uses).
// The machine service is passed down to the local-program driver.
export class DriverFactory {
  constructor(private readonly machine: IMachineService) {}

  create(gen: ImageGenerator): IImageGeneratorDriver {
    return isLocalGenerator(gen) ? new LocalProgramDriver(gen, this.machine) : new SdApiDriver(gen);
  }
}
