import { ChatMessage } from "./ChatMessage";

// Per-chat sampling overrides for the provider request. A field left
// undefined is not sent at all — the provider applies its own default.
export type ChatSampling = {
  temperature?: number;
  minP?: number;
  repetitionPenalty?: number;
};

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
  sampling?: ChatSampling; // per-chat sampling overrides (absent fields = provider default)
  // A free-text addition appended to the system prompt of every reply in
  // this chat (the user's extra instructions — style, quirks, etc.).
  systemSuffix?: string;
  messages: ChatMessage[];
};
