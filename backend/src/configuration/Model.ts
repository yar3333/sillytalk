import { LlmModel } from "./LlmModel";

// Flat model used by the code: the llmModels key becomes name
// (it is also the internal ID — chat.modelId references it).
export type Model = LlmModel & {
  name: string; // llmModels key = internal ID + display name
};
