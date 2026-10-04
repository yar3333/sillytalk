import { ImageGenerator } from "./ImageGenerator";
import { LlmModel } from "./LlmModel";

// Characters and persons are not stored in the config: each one is a
// characters/<id>/ or users/<id>/ folder (see characters/CharactersService.ts /
// persons/PersonsService.ts). There is no selected "current" persona anymore:
// each chat specifies its own persona in the Chat.userId field.
export type Config = {
  listen: string; // "0.0.0.0:3210" — the server's listen address
  llmModels: Record<string, LlmModel>;
  imageGenerators: ImageGenerator[];
};
