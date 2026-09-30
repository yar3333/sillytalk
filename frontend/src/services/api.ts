import { Injectable } from '@angular/core';

// The value of an llmModels entry: the provider connection.
export interface LlmModel {
  id: string; // the ID sent to the provider
  baseUrl: string;
  apiKey?: string; // the API key directly
  envKey?: string; // the name of an env var holding the key (takes priority over apiKey)
  contextSize: number;
  supportsImages: boolean;
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
  photos?: string[];
  hasAvatar?: boolean; // is there a characters/<id>/avatar.*
}

// A user is stored in users/<id>/user.json (served by the backend via /api/users).
export interface User {
  id: string;
  name: string;
  description: string;
  hasAvatar?: boolean; // is there a users/<id>/avatar.*
}

export interface SdApiSettings {
  url: string;
  steps: number;
  width: number;
  height: number;
  denoisingStrength: number;
  negativePrompt: string;
}

export interface LocalProgramSettings {
  command: string;
  args: string[];
  maxInputImages: number; // how many references the generator supports (0 = unlimited)
}

// An imageGenerators entry: the type is determined by which fields are
// present (command -> local, url -> sdapi), as in the config.
export type ImageGenerator = SdApiSettings | LocalProgramSettings;

export function isLocalGenerator(g: ImageGenerator): g is LocalProgramSettings {
  return typeof (g as LocalProgramSettings).command === 'string';
}

export function isSdApiGenerator(g: ImageGenerator): g is SdApiSettings {
  return typeof (g as SdApiSettings).url === 'string';
}

// Characters and users are not in the config — each one is stored in a
// characters/<id>/character.json and users/<id>/user.json folder respectively
// (the backend serves them via /api/characters and /api/users).
// There is no "current" user in the config: each chat picks its own persona (Chat.userId).
export interface AppConfig {
  listen: string; // "0.0.0.0:3210"
  llmModels: Record<string, LlmModel>;
  imageGenerators: ImageGenerator[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images: string[];
  timestamp: number;
  error?: boolean;
  // The message author: for user — a persona (users/<id>), for assistant —
  // a character (characters/<id>); stored at send time.
  characterId?: string;
  userId?: string;
  // Prompts of the generated images (file name -> prompt) — for regeneration.
  imagePrompts?: Record<string, string>;
  // References of each generated image (file name -> names in the chat files/).
  imageRefs?: Record<string, string[]>;
  // Generation status of the message's images (file name -> status): only
  // the images still being generated ("pending") or whose generation failed
  // or was cancelled ("failed") are listed — a name absent from the map is a
  // ready image.
  imageStatus?: Record<string, 'pending' | 'failed'>;
  // The reason a generated image is "failed" (file name -> error text).
  imageErrors?: Record<string, string>;
}

export interface Chat {
  id: string;
  // The character participants in priority order: they reply in turn,
  // a silent one ([SILENT]) writes no message.
  characterIds: string[];
  // The active persona — messages are sent under its name. The personas
  // that participated in the chat are derived from message authors (msg.userId).
  userId: string;
  modelId: string; // the llmModels key of the chosen model
  messages: ChatMessage[];
}

export interface ChatSummary extends Omit<Chat, 'messages'> {
  messageCount: number;
  // The last message date, computed by the server on the fly (0 for an empty chat).
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
    return this.req<User[]>('/users');
  }

  // Full sync of the user list (create/update/delete).
  putUsers(users: User[]): Promise<User[]> {
    return this.req<User[]>('/users', { method: 'PUT', body: JSON.stringify({ users }) });
  }

  userAvatarUrl(userId: string): string {
    return API + '/users/' + userId + '/avatar';
  }

  characterAvatarUrl(characterId: string): string {
    return API + '/characters/' + characterId + '/avatar';
  }

  // Uploads an avatar (a data URL) to the user/character folder.
  uploadAvatar(kind: 'user' | 'character', id: string, data: string): Promise<{ ok: boolean }> {
    const base = kind === 'user' ? '/users' : '/characters';
    return this.req(base + '/' + id + '/avatar', {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  deleteAvatar(kind: 'user' | 'character', id: string): Promise<{ deleted: boolean }> {
    const base = kind === 'user' ? '/users' : '/characters';
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
    return this.req<{ id: string; users: User[] }>(`/users/${id}/clone`, { method: 'POST' });
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

  importPhoto(chatId: string, characterId: string, photo: string): Promise<{ name: string }> {
    return this.req<{ name: string }>('/chats/' + chatId + '/import-photo', {
      method: 'POST',
      body: JSON.stringify({ characterId, photo }),
    });
  }

  // Saves the user message; the characters' replies are separate nextReply calls.
  postMessage(id: string, text: string, images: string[]): Promise<{ chat: Chat }> {
    return this.req<{ chat: Chat }>('/chats/' + id + '/messages', {
      method: 'POST',
      body: JSON.stringify({ text, images }),
    });
  }

  // The line of one chat character; reply === null — the character stayed
  // silent ([SILENT]). The frontend calls it in turn for each participant.
  nextReply(id: string, characterId: string): Promise<{ chat: Chat; reply: ChatMessage | null }> {
    return this.req<{ chat: Chat; reply: ChatMessage | null }>('/chats/' + id + '/reply', {
      method: 'POST',
      body: JSON.stringify({ characterId }),
    });
  }

  // Message edit: the text and the image list (a data URL — a new image,
  // a file name — an already uploaded one).
  patchMessage(
    chatId: string,
    messageId: string,
    patch: { text: string; images: string[] },
  ): Promise<{ chat: Chat }> {
    return this.req('/chats/' + chatId + '/messages/' + messageId, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  // Deletes the message and all subsequent ones in the chat.
  deleteMessageFrom(chatId: string, messageId: string): Promise<{ chat: Chat }> {
    return this.req('/chats/' + chatId + '/messages/' + messageId, { method: 'DELETE' });
  }

  // Regenerates one message image from its stored prompt. The server marks
  // the image "pending" right away (the generation runs in the background)
  // and returns the updated chat; the result arrives with the next poll.
  regenerateImage(chatId: string, messageId: string, image: string): Promise<{ chat: Chat }> {
    return this.req(`/chats/${chatId}/messages/${messageId}/regenerate-image`, {
      method: 'POST',
      body: JSON.stringify({ image }),
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

  // Whether the active image generator is available (the first available one from the config).
  imageStatus(): Promise<{ available: boolean }> {
    return this.req<{ available: boolean }>('/image/status');
  }

  mediaUrl(chatId: string, name: string): string {
    return API + '/chats/' + chatId + '/files/' + encodeURIComponent(name);
  }

  photoUrl(characterId: string, name: string): string {
    return API + '/characters/' + characterId + '/photos/' + encodeURIComponent(name);
  }
}
