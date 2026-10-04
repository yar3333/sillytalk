// llmModels entry value: the provider connection. The object key is the
// model's name inside the app (displayed); the id field is the identifier
// sent to the provider in the request.
export type LlmModel = {
  id: string; // ID sent to the provider (the id field of the llmModels entry)
  baseUrl: string;
  apiKey?: string; // API key directly
  envKey?: string; // name of an env var holding the key (takes priority over apiKey)
  contextSize: number;
  supportsImages: boolean;
  // Reasoning level: false/absent — off (nothing is sent to the provider), a
  // string — the level (one of reasoningLevels), sent as reasoning_effort
  // (OpenAI / llama.cpp) and reasoning.effort (OpenRouter).
  reasoning?: string | false;
  // The possible reasoning levels; absent — the default set
  // (low, medium, high, xhigh, max).
  reasoningLevels?: string[];
};

// Flat model used by the code: the llmModels key becomes name
// (it is also the internal ID — chat.modelId references it).
export type Model = LlmModel & {
  name: string; // llmModels key = internal ID + display name
};

export type Character = {
  id: string;
  name: string;
  description: string;
};

// A person (the persona card) is a users/<id>/ folder with user.json
// (name + persona description).
export type Person = {
  id: string;
  name: string;
  description: string;
};

export type SdApiSettings = {
  url: string;
  steps: number;
  width: number;
  height: number;
  denoisingStrength: number;
  negativePrompt: string;
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
};

export type LocalProgramSettings = {
  command: string;
  args: string[];
  maxInputImages: number; // how many references the generator supports (0 = unlimited)
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
};

// imageGenerators entry: the type is detected by which fields are present
// (command -> local, url -> sdapi). Type guard below.
export type ImageGenerator = SdApiSettings | LocalProgramSettings;

export function isLocalGenerator(g: ImageGenerator): g is LocalProgramSettings {
  return typeof (g as LocalProgramSettings).command === 'string';
}

export function isSdApiGenerator(g: ImageGenerator): g is SdApiSettings {
  return typeof (g as SdApiSettings).url === 'string';
}

// Characters and persons are not stored in the config: each one is a
// characters/<id>/ or users/<id>/ folder (see characters/CharactersService.ts /
// persons/PersonsService.ts). There is no selected "current" persona anymore:
// each chat specifies its own persona in the Chat.userId field.
export type Config = {
  listen: string; // "0.0.0.0:3210" — the server's listen address
  llmModels: Record<string, LlmModel>;
  imageGenerators: ImageGenerator[];
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images: string[];
  timestamp: number;
  error?: boolean;
  // Author of the message: for user — a persona (users/<id>), for assistant —
  // a character (characters/<id>). Messages keep their author at send time,
  // so switching active chat participants does not rewrite history.
  characterId?: string;
  userId?: string;
  // Prompts the message's images were generated with (file name -> prompt);
  // filled in when the model inserted an [IMG:...] tag in its reply.
  imagePrompts?: Record<string, string>;
  // References of each generated image (file name -> names in the chat files/).
  imageRefs?: Record<string, string[]>;
  // Generation status of the message's images (file name -> status). Only the
  // images that are still being generated ("pending") or whose generation
  // failed ("failed") or was cancelled ("cancelled") are listed — a name that
  // is absent from the map is a ready image. The generation runs in the
  // background: the reply is saved with the reserved file names BEFORE the
  // files exist.
  imageStatus?: Record<string, 'pending' | 'failed' | 'cancelled'>;
  // The reason a generated image is "failed" (file name -> error text) —
  // shown on the broken-image placeholder.
  imageErrors?: Record<string, string>;
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
  messages: ChatMessage[];
};

// Summary for the chat list: lastMessageAt is computed on the fly from the
// last message (0 for an empty chat); createdAt/updatedAt are not stored.
export type ChatSummary = Omit<Chat, 'messages'> & {
  messageCount: number;
  lastMessageAt: number;
};
