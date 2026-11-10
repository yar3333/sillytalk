import { ImageGenerator } from "./ImageGenerator";
import { LlmModel } from "./LlmModel";

// Characters and persons are not stored in the config: each one is a
// characters/<id>/ or users/<id>/ folder (see characters/CharactersService.ts /
// persons/PersonsService.ts). There is no selected "current" persona anymore:
// each chat specifies its own persona in the Chat.userId field.
export type Config = {
  listen: string; // "0.0.0.0:3210" — the server's listen address
  llmModels: Record<string, LlmModel>;
  // The llmModels key of the model the app TALKS with — the replies, and the
  // default of every other role. A global pick (the header's model chip writes
  // it), not a per-chat one: absent or unknown — the first model of llmModels.
  chatModel?: string;
  // The llmModels key of the model that LOOKS at pictures (card captions, the
  // describe helpers). Absent or unknown — the chat model when it can see, else
  // the first model that can.
  visionModel?: string;
  // The llmModels key of the model that WRITES the picture prompts (the 📷
  // planner and "From the chat"). A global pick that may differ from the model
  // running the replies; absent or unknown — the chat model is used.
  imagePromptModel?: string;
  imageGenerators: ImageGenerator[];
};
