import { LocalProgramSettings } from "./LocalProgramSettings";
import { SdApiSettings } from "./SdApiSettings";

// imageGenerators entry: the type is detected by which fields are present
// (command -> local, url -> sdapi). Type guards below. The settings types
// live in the configuration domain because they describe the config.json
// schema — the image_generation domain imports them, never the other way.
export type ImageGenerator = SdApiSettings | LocalProgramSettings;

export function isLocalGenerator(g: ImageGenerator): g is LocalProgramSettings {
  return typeof (g as LocalProgramSettings).command === 'string';
}

export function isSdApiGenerator(g: ImageGenerator): g is SdApiSettings {
  return typeof (g as SdApiSettings).url === 'string';
}
