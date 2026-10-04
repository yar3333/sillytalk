import { ChatMessage } from "./ChatMessage";

export type Chat = {
  id: string;
  // The chat's characters in priority order: for every user message they
  // reply in turns (a silent one — [SILENT] — writes no message).
  characterIds: string[];
  // The active persona — new messages are sent under its name. The personas
  // that ever participated are not stored: they are derived on the fly from
  // message authors (ChatMessage.userId).
  userId: string;
  modelId: string; // llmModels key of the chosen model
  messages: ChatMessage[];
};
