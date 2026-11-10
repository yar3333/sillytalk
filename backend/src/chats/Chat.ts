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
  // The chat's own name as the user typed it (the header title). Absent — the
  // header shows the creation date instead, so a chat always has a title.
  name?: string;
  // When the chat was created (ms since the epoch) — the title of a nameless
  // chat. Set once at create; a chat imported without it takes the date of its
  // first message (see ChatsService.normalize).
  createdAt: number;
  // The chat's characters in priority order: for every user message they
  // reply in turns (a silent one — [SILENT] — writes no message).
  characterIds: string[];
  // The active persona — new messages are sent under its name. The personas
  // that ever participated are not stored: they are derived on the fly from
  // message authors (ChatMessage.userId).
  userId: string;
  // The models are GLOBAL settings, not fields of a chat: Config.chatModel is
  // the model the app talks with and Config.visionModel the one that looks at
  // pictures (Config.imagePromptModel writes the picture prompts). A chat that
  // still carries its old per-chat pick loses it on the next read
  // (ChatsService.normalize).
  sampling?: ChatSampling; // per-chat sampling overrides (absent fields = provider default)
  // A free-text addition appended to the system prompt of every reply in
  // this chat (the user's extra instructions — style, quirks, etc.).
  systemSuffix?: string;
  // One look for every picture of this chat, appended to each generation
  // prompt ("photorealistic, 35mm, warm light"). Without it every plan invents
  // its own style and the pictures of one conversation drift apart.
  stylePrompt?: string;
  messages: ChatMessage[];
};
