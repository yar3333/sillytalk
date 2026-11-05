import { Injectable } from '@angular/core';

// The value of an llmModels entry: the provider connection.
export interface LlmModel {
  id: string; // the ID sent to the provider
  baseUrl: string;
  apiKey?: string; // the API key directly
  envKey?: string; // the name of an env var holding the key (takes priority over apiKey)
  contextSize: number;
  supportsImages: boolean;
  // Reasoning level: a string — the level (one of reasoningLevels), sent as
  // reasoning_effort / reasoning.effort; false/absent — off, sent as
  // chat_template_kwargs.enable_thinking=false (the cross-backend off-switch).
  reasoning?: string | false;
  // The possible reasoning levels; absent — the default set.
  reasoningLevels?: string[];
}

// The flat model for templates: the llmModels key becomes name
// (internal ID + display name).
export interface Model extends LlmModel {
  name: string;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  // How the character looks, in English, written for the image generator (the
  // generator has never heard their name). "Fill from photos" writes it from
  // the character's photo set; the picture planner puts it into every prompt.
  look?: string;
  photos?: string[]; // the character's "starter" photo set (🎨 reference picker)
  hasAvatar?: boolean; // is there a characters/<id>/avatar.*
}

// A user is stored in users/<id>/user.json (served by the backend via /api/persons).
export interface User {
  id: string;
  name: string;
  description: string;
  // The persona's appearance, as in Character.look.
  look?: string;
  hasAvatar?: boolean; // is there a users/<id>/avatar.*
}

export interface SdApiSettings {
  kind: 'sdapi';
  url: string;
  steps: number;
  width: number;
  height: number;
  denoisingStrength: number;
  negativePrompt: string;
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
}

// A ComfyUI server. One entry runs ONE model — the workflows are shipped with
// the app and the server has to have the models of the chosen one, so a server
// serving two models is configured as two generators.
export interface ComfyUiSettings {
  kind: 'comfyui';
  url: string;
  // The model this generator runs, a name of the catalogue the backend answers
  // in imageStatus() (the models the app has a workflow for).
  model: string;
  // The GPU the model loaders of the workflow are pinned to ("cuda:0").
  device: string;
  width: number;
  height: number;
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
}

// An imageGenerators entry: every generator names its own kind ("comfyui" /
// "sdapi") — the app never guesses a type from the fields that happen to be
// set, and an entry without a known kind is dropped by the backend.
export type ImageGenerator = SdApiSettings | ComfyUiSettings;

export function isComfyUiGenerator(g: ImageGenerator): g is ComfyUiSettings {
  return (g as { kind?: string }).kind === 'comfyui';
}

export function isSdApiGenerator(g: ImageGenerator): g is SdApiSettings {
  return (g as { kind?: string }).kind === 'sdapi';
}

// Characters and users are not in the config — each one is stored in a
// characters/<id>/character.json and users/<id>/user.json folder respectively
// (the backend serves them via /api/characters and /api/persons).
// There is no "current" user in the config: each chat picks its own persona (Chat.userId).
export interface AppConfig {
  listen: string; // "0.0.0.0:3210"
  llmModels: Record<string, LlmModel>;
  imageGenerators: ImageGenerator[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  // 'text' (default) — a line of the dialogue; 'image' — an image card: one
  // picture with its own description and generation data. Only the user
  // produces cards; a character reply is text.
  kind?: 'text' | 'image';
  // A text message: the line. An image card: what is on the picture.
  text: string;
  // Image identifiers — paths relative to the data folder
  // ("chats/<chatId>/files/a-sunset-3f2a1c.png"). A card carries exactly one.
  images: string[];
  timestamp: number;
  error?: boolean;
  // The message author: for user — a persona (users/<id>), for assistant —
  // a character (characters/<id>); stored at send time.
  characterId?: string;
  userId?: string;
  // The card's generation data (absent when the user uploaded the file).
  generation?: ImageGenerationData;
  // Who is ON the picture: the participant ids ("char:alice", "user:carol")
  // the picture planner uses to draw the same person twice in a row.
  depicts?: string[];
  // Generation status of the message's images (id -> status): only the images
  // still being generated ("pending") or whose generation failed ("failed") or
  // was cancelled ("cancelled") are listed — an id absent from the map is a
  // ready image.
  imageStatus?: Record<string, 'pending' | 'failed' | 'cancelled'>;
  // The reason a generated image is "failed" (id -> error text).
  imageErrors?: Record<string, string>;
}

// How a picture was made: the prompt it was drawn from, the pictures it was
// drawn from, and who asked for it. The same block lives in the sidecar *.json
// next to the file, where the user can edit it by hand.
export interface ImageGenerationData {
  prompt?: string;
  refs?: string[];
  negativePrompt?: string;
  // upload — the user attached it; manual — the 🎨 mode; auto — the picture of
  // the user's turn, planned by the model.
  source?: 'upload' | 'manual' | 'auto';
  generator?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  createdAt?: string;
}

export interface Chat {
  id: string;
  // The chat's own name — the title in the header. Absent: the header shows the
  // creation date instead, so a chat always has a title.
  name?: string;
  // When the chat was created (ms) — the title of a nameless chat.
  createdAt: number;
  // The character participants in priority order: they reply in turn,
  // a silent one ([SILENT]) writes no message.
  characterIds: string[];
  // The active persona — messages are sent under its name. The personas
  // that participated in the chat are derived from message authors (msg.userId).
  userId: string;
  modelId: string; // the llmModels key of the chosen model
  // Per-chat sampling overrides for the provider request; a field left
  // undefined is not sent at all (the provider default applies).
  sampling?: {
    temperature?: number;
    minP?: number;
    repetitionPenalty?: number;
  };
  // A free-text addition appended to the system prompt of every reply in
  // this chat (empty/absent — nothing is added).
  systemSuffix?: string;
  // One look for every picture of this chat, appended to each generation prompt
  // ("photorealistic, 35mm, warm light"). Without it every plan picks its own
  // style and the pictures of one conversation drift apart.
  stylePrompt?: string;
  messages: ChatMessage[];
}

export interface ChatSummary extends Omit<Chat, 'messages'> {
  messageCount: number;
  // The last message date, computed by the server on the fly (0 for an empty chat).
  // The name and createdAt come from the chat row itself — they title it.
  lastMessageAt: number;
}

const API = '/api';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private async req<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      let msg = String(res.status);
      try {
        const j = (await res.json()) as { error?: string };
        msg = j.error || msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  }

  getConfig(): Promise<AppConfig> {
    return this.req<AppConfig>('/config');
  }

  putConfig(cfg: AppConfig): Promise<AppConfig> {
    return this.req<AppConfig>('/config', { method: 'PUT', body: JSON.stringify(cfg) });
  }

  getCharacters(): Promise<Character[]> {
    return this.req<Character[]>('/characters');
  }

  // Full sync of the character list (create/update/delete).
  putCharacters(characters: Character[]): Promise<Character[]> {
    return this.req<Character[]>('/characters', {
      method: 'PUT',
      body: JSON.stringify({ characters }),
    });
  }

  getUsers(): Promise<User[]> {
    return this.req<User[]>('/persons');
  }

  // Full sync of the user list (create/update/delete).
  putUsers(users: User[]): Promise<User[]> {
    return this.req<User[]>('/persons', { method: 'PUT', body: JSON.stringify({ users }) });
  }

  userAvatarUrl(userId: string): string {
    return API + '/persons/' + userId + '/avatar';
  }

  characterAvatarUrl(characterId: string): string {
    return API + '/characters/' + characterId + '/avatar';
  }

  // Uploads an avatar (a data URL) to the user/character folder.
  uploadAvatar(kind: 'user' | 'character', id: string, data: string): Promise<{ ok: boolean }> {
    const base = kind === 'user' ? '/persons' : '/characters';
    return this.req(base + '/' + id + '/avatar', {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  deleteAvatar(kind: 'user' | 'character', id: string): Promise<{ deleted: boolean }> {
    const base = kind === 'user' ? '/persons' : '/characters';
    return this.req(base + '/' + id + '/avatar', { method: 'DELETE' });
  }

  // Clones the character folder (the photos and the avatar go along); the copy
  // is named "<name> (copy)". Returns the new id + the updated character list.
  cloneCharacter(id: string): Promise<{ id: string; characters: Character[] }> {
    return this.req<{ id: string; characters: Character[] }>(`/characters/${id}/clone`, {
      method: 'POST',
    });
  }

  // Clones the user folder (the avatar goes along); returns the new id +
  // the updated user list.
  cloneUser(id: string): Promise<{ id: string; users: User[] }> {
    return this.req<{ id: string; users: User[] }>(`/persons/${id}/clone`, { method: 'POST' });
  }

  // Writes the appearance note of a character / persona from their pictures
  // (their photo set and avatar, or, with none to look at, from the card text).
  // The answer goes into the dialog's Look field — the user saves it themselves.
  fillLook(kind: 'character' | 'user', id: string): Promise<{ look: string }> {
    const base = kind === 'user' ? '/persons' : '/characters';
    return this.req<{ look: string }>(base + '/' + id + '/look', { method: 'POST' });
  }

  getChats(): Promise<ChatSummary[]> {
    return this.req<ChatSummary[]>('/chats');
  }

  createChat(characterIds: string[], modelId: string, userId: string): Promise<Chat> {
    return this.req<Chat>('/chats', {
      method: 'POST',
      body: JSON.stringify({ characterIds, modelId, userId }),
    });
  }

  getChat(id: string): Promise<Chat> {
    return this.req<Chat>('/chats/' + id);
  }

  patchChat(id: string, patch: Partial<Chat>): Promise<Chat> {
    return this.req<Chat>('/chats/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  deleteChat(id: string): Promise<{ deleted: boolean }> {
    return this.req<{ deleted: boolean }>('/chats/' + id, { method: 'DELETE' });
  }

  // Duplicates the chat — its messages, its pictures (copied into the copy's own
  // folder) and its settings. The answer is the copy, which the store opens.
  cloneChat(id: string): Promise<Chat> {
    return this.req<{ chat: Chat }>(`/chats/${id}/clone`, { method: 'POST' }).then((r) => r.chat);
  }

  // Imports a character photo into the chat files/ as a 🎨 reference; the
  // answer is the new image id.
  importPhoto(chatId: string, characterId: string, photo: string): Promise<{ id: string }> {
    return this.req<{ id: string }>('/chats/' + chatId + '/import-photo', {
      method: 'POST',
      body: JSON.stringify({ characterId, photo }),
    });
  }

  // Saves what the user sends: their text becomes a text message and every
  // attached picture an image card right after it. The characters' replies are
  // separate nextReply calls.
  postMessage(id: string, text: string, images: string[]): Promise<{ chat: Chat; messages: ChatMessage[] }> {
    return this.req<{ chat: Chat; messages: ChatMessage[] }>('/chats/' + id + '/messages', {
      method: 'POST',
      body: JSON.stringify({ text, images }),
    });
  }

  // The line of one chat character; reply === null — the character stayed
  // silent ([SILENT]). The frontend calls it in turn for each participant.
  // The signal lets the caller abort the request (canceling the generation).
  // `replaceLast` (regeneration): the backend replaces the last assistant
  // message with the new reply, removing it only after the new one is saved
  // — so a cancel keeps the original reply.
  nextReply(
    id: string,
    characterId: string,
    signal?: AbortSignal,
    replaceLast = false,
  ): Promise<{ chat: Chat; reply: ChatMessage | null }> {
    return this.req<{ chat: Chat; reply: ChatMessage | null }>('/chats/' + id + '/reply', {
      method: 'POST',
      body: JSON.stringify({ characterId, replaceLast }),
      signal,
    });
  }

  // Cancels the in-flight reply of the chat: the model call is aborted on the
  // server and no message is saved for it. Returns the current chat (re-sync).
  cancelReply(id: string): Promise<{ chat: Chat }> {
    return this.req(`/chats/${id}/cancel`, { method: 'POST' });
  }

  // Message edit: the text of a line, or the description (caption) of a card.
  patchMessage(chatId: string, messageId: string, patch: { text: string }): Promise<{ chat: Chat }> {
    return this.req('/chats/' + chatId + '/messages/' + messageId, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  // Edits what a card says about its picture — the picture-editor dialog: the
  // description (what is on it), the prompt to redraw it with, the picture the
  // card should point at (`image` — an existing id of the data folder) and what
  // the card IS now (`kind`). The sidecar next to the file is updated along
  // with the message.
  patchPicture(
    chatId: string,
    messageId: string,
    patch: {
      description?: string;
      prompt?: string;
      image?: string;
      kind?: 'generated' | 'file';
      refs?: string[];
      depicts?: string[];
    },
  ): Promise<{ chat: Chat }> {
    return this.req('/chats/' + chatId + '/messages/' + messageId + '/picture', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  // The picture catalog: every picture of the data folder as an image id,
  // newest first — the "from a file" pick of the picture editor.
  pictureCatalog(): Promise<{ images: string[] }> {
    return this.req<{ images: string[] }>('/image/pictures');
  }

  // The prompt for a picture card, planned from the dialogue ("From the chat").
  // The references come back with it: the prompt says what each of them is for,
  // so saving one without the others would redraw something else.
  composePicturePrompt(
    chatId: string,
    messageId?: string,
  ): Promise<{ prompt: string; description: string; refs: string[] }> {
    return this.req<{ prompt: string; description: string; refs: string[] }>('/image/prompt', {
      method: 'POST',
      body: JSON.stringify({ chatId, messageId }),
    });
  }

  // Rewrites a prompt into English and shapes it for the generator
  // ("Make it English").
  tunePicturePrompt(chatId: string, prompt: string): Promise<{ prompt: string }> {
    return this.req<{ prompt: string }>('/image/tune-prompt', {
      method: 'POST',
      body: JSON.stringify({ chatId, prompt }),
    });
  }

  // One sentence about a picture ("Describe the picture"): an existing picture
  // of the data folder or a data URL of a file just picked from disk. Needs a
  // model with vision — the backend answers a clear 400 without one.
  describePicture(chatId: string, body: { image?: string; data?: string }): Promise<{ description: string }> {
    return this.req<{ description: string }>('/image/describe', {
      method: 'POST',
      body: JSON.stringify({ chatId, ...body }),
    });
  }

  // Deletes the message and all subsequent ones in the chat.
  deleteMessageFrom(chatId: string, messageId: string): Promise<{ chat: Chat }> {
    return this.req('/chats/' + chatId + '/messages/' + messageId, { method: 'DELETE' });
  }

  // Deletes a single message (the rest of the chat is kept as is).
  deleteMessage(chatId: string, messageId: string): Promise<{ chat: Chat }> {
    return this.req('/chats/' + chatId + '/messages/' + messageId + '?single=1', {
      method: 'DELETE',
    });
  }

  // Regenerates a card's picture from its stored prompt. The server marks it
  // "pending" right away (the generation runs in the background) and returns
  // the updated chat; the result arrives with the next poll. An optional
  // `prompt` (the "edit prompt then regenerate" flow) overrides the stored one.
  regenerateImage(
    chatId: string,
    messageId: string,
    image: string,
    prompt?: string,
  ): Promise<{ chat: Chat }> {
    return this.req(`/chats/${chatId}/messages/${messageId}/regenerate-image`, {
      method: 'POST',
      body: JSON.stringify({ image, prompt }),
    });
  }

  // Replaces a ready message image with a file the user picked (a data URL):
  // the server saves it into the chat files/ and swaps it for the old one.
  replaceImage(chatId: string, messageId: string, image: string, data: string): Promise<{ chat: Chat }> {
    return this.req(`/chats/${chatId}/messages/${messageId}/replace-image`, {
      method: 'POST',
      body: JSON.stringify({ image, data }),
    });
  }

  // Cancels the in-flight generation of one message image. The image becomes
  // the "failed" (broken) one with the Regenerate button.
  cancelImage(chatId: string, messageId: string, image: string): Promise<{ chat: Chat }> {
    return this.req(`/chats/${chatId}/messages/${messageId}/cancel-image`, {
      method: 'POST',
      body: JSON.stringify({ image }),
    });
  }

  postImage(
    chatId: string,
    prompt: string,
    refs: string[],
  ): Promise<{ chat: Chat; message: ChatMessage }> {
    return this.req<{ chat: Chat; message: ChatMessage }>('/image', {
      method: 'POST',
      body: JSON.stringify({ chatId, prompt, refs }),
    });
  }

  // The picture of the user's turn: the model plans it from the dialogue and
  // the generator draws it, both in the background. The answer comes back with
  // the placeholder card already in the chat, so the user can go on writing.
  autoImage(chatId: string): Promise<{ chat: Chat }> {
    return this.req(`/chats/${chatId}/auto-image`, { method: 'POST' });
  }

  // Whether an image generator is available (any enabled one that answers),
  // and the image models a ComfyUI generator can be pointed at — the models
  // the app ships a workflow for.
  imageStatus(): Promise<{ available: boolean; comfyUiModels?: string[] }> {
    return this.req<{ available: boolean; comfyUiModels?: string[] }>('/image/status');
  }

  // The URL of an image by its id (a path relative to the data folder).
  mediaUrl(id: string): string {
    return API + '/media?path=' + encodeURIComponent(id);
  }

  photoUrl(characterId: string, name: string): string {
    return API + '/characters/' + characterId + '/photos/' + encodeURIComponent(name);
  }
}
