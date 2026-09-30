import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Chat, ChatSummary } from './types';
import { chatsDir, chatDir, chatFilesDir, isDirEntry, listModels, loadConfig } from './config';

// Guarantees the new chat format: characterIds — an array of strings,
// userId — a string. After the one-off conversion of old chat.json files
// this is only a guard against garbage, not support for the old format.
function normalizeChat(chat: Chat): boolean {
  let dirty = false;
  if (!Array.isArray(chat.characterIds)) {
    chat.characterIds = [];
    dirty = true;
  } else {
    const before = chat.characterIds.length;
    chat.characterIds = chat.characterIds.filter((id) => typeof id === 'string' && id);
    if (chat.characterIds.length !== before) dirty = true;
  }
  if (typeof chat.userId !== 'string') {
    chat.userId = '';
    dirty = true;
  }
  return dirty;
}

// The chat's model may have disappeared from the config (renamed/deleted) —
// attach the first available one so the chat keeps working.
function ensureModelId(chat: Chat): boolean {
  const models = listModels(loadConfig());
  if (models.length === 0 || models.some((m) => m.name === chat.modelId)) return false;
  chat.modelId = models[0].name;
  return true;
}

function chatFile(chatId: string): string {
  return path.join(chatsDir(), chatId, 'chat.json');
}

export function newId(): string {
  return randomUUID();
}

export function listChats(): ChatSummary[] {
  const root = chatsDir();
  if (!fs.existsSync(root)) return [];
  const result: ChatSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!isDirEntry(root, entry)) continue;
    const file = chatFile(entry.name);
    if (!fs.existsSync(file)) continue;
    try {
      const chat = JSON.parse(fs.readFileSync(file, 'utf-8')) as Chat;
      const { messages, ...rest } = chat;
      const lastMessageAt =
        messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
      result.push({ ...rest, messageCount: messages.length, lastMessageAt });
    } catch {
      // skip a corrupted chat
    }
  }
  return result.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

export function getChat(chatId: string): Chat | null {
  const file = chatFile(chatId);
  if (!fs.existsSync(file)) return null;
  try {
    const chat = JSON.parse(fs.readFileSync(file, 'utf-8')) as Chat;
    const dirty = [normalizeChat, ensureModelId].some((fix) => fix(chat));
    if (dirty) saveChat(chat);
    return chat;
  } catch {
    return null;
  }
}

export function saveChat(chat: Chat): void {
  normalizeChat(chat);
  // Old chat.json files may still carry title/createdAt/updatedAt, a single
  // characterId and userIds — they are stripped on every write; the fields
  // are no longer stored.
  const legacy = chat as Record<string, unknown>;
  delete legacy.title;
  delete legacy.createdAt;
  delete legacy.updatedAt;
  delete legacy.characterId;
  delete legacy.userIds;
  fs.mkdirSync(chatDir(chat.id), { recursive: true });
  fs.writeFileSync(chatFile(chat.id), JSON.stringify(chat, null, 2), 'utf-8');
}

export function createChat(
  characterIds: string[],
  modelId: string,
  userId: string,
): Chat {
  const chat: Chat = {
    id: newId(),
    characterIds: [...characterIds],
    userId,
    modelId,
    messages: [],
  };
  saveChat(chat);
  return chat;
}

export function deleteChat(chatId: string): boolean {
  const dir = chatDir(chatId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Saves a data URL into the chat files/, returns the file name
export function saveChatImage(chatId: string, dataUrl: string, originalName?: string): string {
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Expected a data URL like data:image/...;base64,...');
  const ext = EXT_BY_MIME[match[1]] ?? '.png';
  const base = (originalName ? path.basename(originalName, path.extname(originalName)) : 'img')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 40);
  const filename = `${base || 'img'}-${randomUUID().slice(0, 8)}${ext}`;
  fs.mkdirSync(chatFilesDir(chatId), { recursive: true });
  fs.writeFileSync(path.join(chatFilesDir(chatId), filename), Buffer.from(match[2], 'base64'));
  return filename;
}

// Copies a character photo into the chat files/, returns the file name
export function importCharacterPhoto(chatId: string, photoPath: string): string | null {
  if (!fs.existsSync(photoPath)) return null;
  const filename = `char-${randomUUID().slice(0, 8)}${path.extname(photoPath)}`;
  fs.mkdirSync(chatFilesDir(chatId), { recursive: true });
  fs.copyFileSync(photoPath, path.join(chatFilesDir(chatId), filename));
  return filename;
}
