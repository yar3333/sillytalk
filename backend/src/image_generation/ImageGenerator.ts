import { LocalProgramSettings } from "./LocalProgramSettings";
import { SdApiSettings } from "./SdApiSettings";

// imageGenerators entry: the type is detected by which fields are present
// (command -> local, url -> sdapi). Type guards below.
export type ImageGenerator = SdApiSettings | LocalProgramSettings;

export function isLocalGenerator(g: ImageGenerator): g is LocalProgramSettings {
  return typeof (g as LocalProgramSettings).command === 'string';
}

export function isSdApiGenerator(g: ImageGenerator): g is SdApiSettings {
  return typeof (g as SdApiSettings).url === 'string';
}
