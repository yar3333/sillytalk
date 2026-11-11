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
  // The character's pictures are ordinary files of its folder, addressed by
  // their image id (a path relative to the data root). The "starter" set is
  // offered to the 🎨 reference picker; the avatar is one of them.
  photos?: string[];
  // The avatar is an image id (a picture of the folder) the row keeps, or null.
  // Its preview is loaded with mediaUrl(avatar).
  avatar?: string | null;
}

// A user (persona card) is a row of the persons table in the backend's catalogs
// database (served by the backend via /api/persons). Its avatar is an image id
// too (a picture of its folder), previewed through mediaUrl.
export interface User {
  id: string;
  name: string;
  description: string;
  avatar?: string | null;
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

// Characters and users are not in the config — each one is a row of the
// characters / persons table of the backend's catalogs database (catalogs.db);
// the characters/<id>/ and users/<id>/ folders hold only their pictures
// (the backend serves them via /api/characters and /api/persons).
// There is no "current" user in the config: each chat picks its own persona (Chat.userId).
export interface AppConfig {
  listen: string; // "0.0.0.0:3210"
  llmModels: Record<string, LlmModel>;
  // The llmModels key of the model the app TALKS with (replies, and the default
  // of every other role); empty/absent — the first model of llmModels. A global
  // pick: the header's model chip writes it.
  chatModel?: string;
  // The llmModels key of the model that LOOKS at pictures (card captions, the
  // describe helpers); empty/absent — the chat model when it can see, else the
  // first model that can.
  visionModel?: string;
  // The llmModels key of the model that WRITES the picture prompts (the 📷
  // planner and "From the chat"); empty/absent — the chat model is used.
  imagePromptModel?: string;
  // The language of a picture's DESCRIPTION — a code of the list the backend
  // reports in imageStatus().pictureLanguages ("en", "ru"…); empty/absent —
  // English. It is what the vision captions and the 📷 plan's caption say; the
  // generation PROMPT stays English.
  pictureLanguage?: string;
  imageGenerators: ImageGenerator[];
}

// A language a picture's description can be written in: the code the config
// stores, and the name the Settings pick shows (the backend owns the list).
export interface PictureLanguage {
  code: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  // 'text' (default) — a line of the dialogue: the author's words AND, when they
  // show pictures, those pictures too (rendered right under the words).
  // 'image' — the NEUTRAL picture card: nothing but one picture, belonging to
  // the conversation and nobody else. Only the two controls that hand a picture
  // to the chat make one (the 🖼 disk pick and the 📷 picture of the turn) and
  // their files live in the chat's own folder — which is what their id says.
  kind?: 'text' | 'image';
  // A text line: the words. A neutral card: that picture's caption — the card
  // has no words of its own, so the caption of its row stands as its text.
  text: string;
  // Image identifiers — paths relative to the data folder
  // ("chats/<chatId>/a-sunset-3f2a1c.png"). Whose picture it is, is written in
  // the id itself: "characters/<id>/…" is a character's, "users/<id>/…" a
  // persona's, "chats/<id>/…" one the conversation owns. A line carries the
  // pictures its author shows (any number); a neutral card carries exactly one.
  images: string[];
  timestamp: number;
  error?: boolean;
  // The message author: for user — a persona (users/<id>), for assistant —
  // a character (characters/<id>); stored at send time. A neutral card has no
  // author, and that is the point of it.
  characterId?: string;
  userId?: string;
  // What is known about each picture of `images` (id -> its facts): the caption,
  // the generation block, the cast on it. Filled from the one images table on
  // every read, so a picture inside a line and a picture of a card are described
  // by exactly one source — and there is no per-message copy of it.
  pictures?: Record<string, PictureFacts>;
  // Generation status of the message's images (id -> status): only the images
  // still being generated ("pending") or whose generation failed ("failed") or
  // was cancelled ("cancelled") are listed — an id absent from the map is a
  // ready image.
  imageStatus?: Record<string, 'pending' | 'failed' | 'cancelled'>;
  // The reason a generated image is "failed" (id -> error text).
  imageErrors?: Record<string, string>;
}

// What the app knows about ONE picture of a message. All three fields are the
// picture's row of the global images table; the message only names the picture
// by its id.
export interface PictureFacts {
  // What is visible on it — the caption under the picture, and the sentence a
  // model without vision is told in place of it.
  description?: string;
  // How it was made (absent for a file somebody brought).
  generation?: ImageGenerationData;
  // Who is ON the picture ("char:alice", "user:carol") — content, not
  // ownership: it is what keeps the same face in the next picture.
  depicts?: string[];
}

// How a picture was made: the prompt it was drawn from, the pictures it was
// drawn from, and who asked for it. This is a slice of the picture's row in the
// one global images table — the same row an image card is filled from, so a card
// and the picture browser can never show two different versions of it.
export interface ImageGenerationData {
  prompt?: string;
  refs?: string[];
  negativePrompt?: string;
  // upload — somebody brought the file; manual — a picture that was ASKED FOR in
  // words (the 🎨 dialog, a character's [IMAGE_BY_PROMPT]); auto — a picture the
  // app drew on its own (the 📷 picture of the turn).
  source?: 'upload' | 'manual' | 'auto';
  generator?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  createdAt?: string;
}

// One row of the picture browser: a picture of the data folder plus whatever the
// images table says about it. The `id` is the image identifier — the path
// relative to the data root — which is also what a rename changes.
// `exists: false` is a row whose file is gone: not a picture, but the record of
// one the user should still be able to see and clear.
export interface Picture extends ImageGenerationData {
  id: string;
  description?: string;
  depicts?: string[];
  exists: boolean;
  // When the file was last written (ms) — the browser's order.
  modifiedAt?: number;
  // How many OTHER pictures name this one in the reference set of their prompt
  // (their rows' refs) — the browser shows it, so the user sees what depends
  // on the picture before renaming it. Computed on every read.
  referencedBy?: number;
  // The other pictures whose bytes are this picture's (the same extension, size
  // and sha256 at another path) — a cloned chat owns a copy of each picture it
  // had, and a name is a path, so the table keeps both; the browser says so
  // instead of hiding it. Computed on every read.
  sameAs?: string[];
  // The facts of the file the images table keeps (see shared/ImageMeta.ts): its
  // size and sha256 identify the picture's BYTES wherever the file sits, which
  // is how a disk pick is recognised as a picture the user already owns before
  // it is uploaded.
  fileSize?: number;
  fileHash?: string;
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
  // The models are GLOBAL settings, not fields of a chat: AppConfig.chatModel
  // is the model the app talks with, AppConfig.visionModel the one that looks at
  // pictures (AppConfig.imagePromptModel writes the picture prompts). The header
  // chips write them.
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

  // Creates or updates ONE character; the id is the path segment (it is also the
  // folder of its pictures, so a rename is renameCharacter, not this). The
  // answer is the whole catalog, the shape GET returns.
  putCharacter(character: Character): Promise<Character[]> {
    return this.req<Character[]>('/characters/' + character.id, {
      method: 'PUT',
      body: JSON.stringify({ name: character.name, description: character.description }),
    });
  }

  // Deletes one character and its folder; answers with the updated catalog.
  deleteCharacter(id: string): Promise<{ deleted: boolean; characters: Character[] }> {
    return this.req<{ deleted: boolean; characters: Character[] }>('/characters/' + id, {
      method: 'DELETE',
    });
  }

  getUsers(): Promise<User[]> {
    return this.req<User[]>('/persons');
  }

  // Creates or updates ONE persona — the mirror of putCharacter (the domain name
  // is person, the body/response keys stay "users").
  putUser(user: User): Promise<User[]> {
    return this.req<User[]>('/persons/' + user.id, {
      method: 'PUT',
      body: JSON.stringify({ name: user.name, description: user.description }),
    });
  }

  // Deletes one persona and its folder; answers with the updated catalog.
  deleteUser(id: string): Promise<{ deleted: boolean; users: User[] }> {
    return this.req<{ deleted: boolean; users: User[] }>('/persons/' + id, { method: 'DELETE' });
  }

  // Picks the avatar of a user/character from a picture the user chose: either a
  // disk file (`data` — a data URL) or an existing picture id (`image`). The
  // server de-duplicates (a byte-identical picture already in the data folders
  // is reused) and returns the avatar's image id, which the row now keeps.
  setAvatar(
    kind: 'user' | 'character',
    id: string,
    source: { data?: string; image?: string },
  ): Promise<{ id: string }> {
    const base = kind === 'user' ? '/persons' : '/characters';
    return this.req<{ id: string }>(base + '/' + id + '/avatar', {
      method: 'POST',
      body: JSON.stringify(source),
    });
  }

  // Drops the avatar designation (the picture file itself stays).
  clearAvatar(kind: 'user' | 'character', id: string): Promise<{ deleted: boolean }> {
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

  // Gives the character a new ID — which is the name of its folder, so the
  // server moves it and takes the chats, the photos and the picture rows with
  // it. Returns the new id + the updated list; a 400 says why the name is not
  // usable (taken, not a folder name).
  renameCharacter(id: string, newId: string): Promise<{ id: string; characters: Character[] }> {
    return this.req<{ id: string; characters: Character[] }>(`/characters/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ newId }),
    });
  }

  // Gives the persona a new ID (the same move on users/<id>/).
  renameUser(id: string, newId: string): Promise<{ id: string; users: User[] }> {
    return this.req<{ id: string; users: User[] }>(`/persons/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ newId }),
    });
  }

  getChats(): Promise<ChatSummary[]> {
    return this.req<ChatSummary[]>('/chats');
  }

  // A new chat: the participants (reply priority order) and the persona. The
  // model is a global setting now, so it is not part of a chat.
  createChat(characterIds: string[], userId: string): Promise<Chat> {
    return this.req<Chat>('/chats', {
      method: 'POST',
      body: JSON.stringify({ characterIds, userId }),
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

  // Gives the chat a new ID — a folder move like a character rename: chats/<id>/
  // and every picture id of the chat follow it. Returns the new id and the
  // renamed chat; a 400 says why the name was refused (taken, not a folder
  // name, a picture still drawing).
  renameChat(id: string, newId: string): Promise<{ id: string; chat: Chat }> {
    return this.req<{ id: string; chat: Chat }>(`/chats/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ newId }),
    });
  }

  // Saves what the user sends: ONE message of theirs — their text and, when they
  // showed pictures, those pictures inside the same line. The characters' replies
  // are separate nextReply calls.
  postMessage(id: string, text: string, images: string[]): Promise<{ chat: Chat; message: ChatMessage }> {
    return this.req<{ chat: Chat; message: ChatMessage }>('/chats/' + id + '/messages', {
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

  // Edits what ONE picture of a message says about itself — the picture-editor
  // dialog: the description (what is on it), the prompt it is redrawn with,
  // another picture of the data folder to point the line at instead
  // (`repointTo`) and what the picture IS now (`kind`). `image` names WHICH
  // picture of the line is meant — a line may show several — and is the same
  // field every other per-picture route uses. Everything edited here is a field
  // of the picture's row of the images table, so the picture and every line that
  // shows it are never two versions of the same thing.
  patchPicture(
    chatId: string,
    messageId: string,
    image: string,
    patch: {
      description?: string;
      prompt?: string;
      repointTo?: string;
      kind?: 'generated' | 'file';
      refs?: string[];
      depicts?: string[];
    },
  ): Promise<{ chat: Chat }> {
    return this.req('/chats/' + chatId + '/messages/' + messageId + '/picture', {
      method: 'PATCH',
      body: JSON.stringify({ image, ...patch }),
    });
  }

  // The picture browser: every picture of the data folder with the row of the
  // images table that describes it, newest first. Also the "from a file" pick of
  // the picture editor — one catalog for both, so the two can never disagree
  // about what the data folder holds.
  listPictures(): Promise<{ pictures: Picture[] }> {
    return this.req<{ pictures: Picture[] }>('/pictures');
  }

  // Edits what the images table says about a picture, wherever it came from:
  // the description, the prompt and its references, the cast on it. A card of
  // any chat that shows this picture reads the change on its next poll, because
  // the card is the row.
  editPicture(
    id: string,
    patch: { description?: string; prompt?: string; refs?: string[]; depicts?: string[] },
  ): Promise<{ picture: Picture }> {
    return this.req<{ picture: Picture }>('/pictures', {
      method: 'PATCH',
      body: JSON.stringify({ id, ...patch }),
    });
  }

  // Renames a picture. An id is a path, so this is a real file move: the chat
  // cards and the stored reference lists that named the old path follow it.
  // A name that is taken or points outside the picture folders comes back as a
  // 400 with the reason in the banner.
  renamePicture(id: string, newId: string): Promise<{ picture: Picture }> {
    return this.req<{ picture: Picture }>('/pictures/rename', {
      method: 'POST',
      body: JSON.stringify({ id, newId }),
    });
  }

  // Drops the record of a picture whose file is gone. The one delete the browser
  // has: the app never removes a picture file, so a picture that still exists
  // comes back as a 400 with the reason instead of losing its caption.
  forgetPicture(id: string): Promise<{ forgotten: string }> {
    return this.req<{ forgotten: string }>('/pictures', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
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

  // Writes the caption of ONE picture of a message that has none: the chat's
  // vision model looks at the file and its sentence becomes the picture's
  // description (the row of the images table). A picture that already has a
  // caption and a chat with nothing that can see both come back unchanged — so
  // this is safe to fire after every attachment.
  captionPicture(chatId: string, messageId: string, image: string): Promise<{ chat: Chat }> {
    return this.req<{ chat: Chat }>('/image/caption', {
      method: 'POST',
      body: JSON.stringify({ chatId, messageId, image }),
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
  // the server saves it into the chat's folder (reusing an identical picture it
  // already has rather than copying) and swaps it for the old one.
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

  // A picture the user asked for in their own words: it belongs to THEIR line,
  // so the sentence becomes the caption of a new picture of that message, shown
  // "pending" at once, and the model turns the words into a drawing prompt plus
  // a reference set before the generator draws it — all in the background, so
  // the answer already carries the placeholder.
  requestPicture(chatId: string, text: string): Promise<{ chat: Chat; message: ChatMessage }> {
    return this.req<{ chat: Chat; message: ChatMessage }>(`/chats/${chatId}/picture-request`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  // The 🖼 button: a file from the disk as a NEUTRAL picture of this
  // conversation — a card of its own, owned by nobody but the chat, so its file
  // goes to the chat's folder (unless the app already holds exactly these bytes).
  addPictureFile(chatId: string, data: string): Promise<{ chat: Chat; message: ChatMessage }> {
    return this.req<{ chat: Chat; message: ChatMessage }>(`/chats/${chatId}/picture-file`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  // The picture of the user's turn: the model plans it from the dialogue and
  // the generator draws it, both in the background. The answer comes back with
  // the placeholder card already in the chat, so the user can go on writing.
  autoImage(chatId: string): Promise<{ chat: Chat }> {
    return this.req(`/chats/${chatId}/auto-image`, { method: 'POST' });
  }

  // Whether an image generator is available (any enabled one that answers), the
  // image models a ComfyUI generator can be pointed at (the models the app
  // ships a workflow for) and the languages a picture's description can be
  // written in.
  imageStatus(): Promise<{
    available: boolean;
    comfyUiModels?: string[];
    pictureLanguages?: PictureLanguage[];
  }> {
    return this.req<{
      available: boolean;
      comfyUiModels?: string[];
      pictureLanguages?: PictureLanguage[];
    }>('/image/status');
  }

  // The URL of an image by its id (a path relative to the data folder).
  mediaUrl(id: string): string {
    return API + '/media?path=' + encodeURIComponent(id);
  }
}
