import {
  AppConfig,
  Character,
  ChatMessage,
  ChatSummary,
  User,
  isSdApiGenerator,
  isComfyUiGenerator,
} from './api';

// Date format "29.09.2026, 19:46" (en-GB) — in the header and the chat list.
export function formatTime(t: number): string {
  return new Date(t).toLocaleString('en-GB', {
    year: 'numeric',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// The chat label in the list: the names of the character participants.
// With several — the first + "+N" (the characterIds order = reply priority).
export function chatLabelOf(characters: Character[], cs: ChatSummary): string {
  const names = (cs.characterIds ?? [])
    .map((id) => characters.find((x) => x.id === id)?.name ?? id);
  if (names.length === 0) return '—';
  const extra = names.length - 1;
  return extra > 0 ? `${names[0]} +${extra}` : names[0];
}

// The label of the active persona in the chat list.
export function chatUserLabelOf(users: User[], cs: ChatSummary): string {
  return users.find((x) => x.id === cs.userId)?.name ?? '—';
}

// The last message date of a chat (0 for an empty one — an empty string).
export function chatTimeOf(cs: ChatSummary): string {
  return cs.lastMessageAt ? formatTime(cs.lastMessageAt) : '';
}

// Whether a character/persona ID is a usable folder name: letters, digits,
// ".", "-" and "_", no leading dot, at most 100 characters — the backend's
// isValidId mirrored here so the dialog can say it before the server does.
export function isEntityId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 100 &&
    !id.startsWith('.') &&
    !id.includes('/') &&
    !id.includes('\\') &&
    /^[\p{L}\p{N}._-]+$/u.test(id)
  );
}

// The sentence both dialogs show when the typed ID is not a usable folder name
// (one place: both catalogs carry the same rule and must say it the same way).
export const ENTITY_ID_RULE =
  'The ID is the name of a folder: letters, digits and ". - _", no leading dot, at most 100 characters';

// A suggested ID for a new character or persona: the name in lower case with
// what a folder name cannot hold collapsed into single "-"
// ("Alice of the Green Coat" → "alice-of-the-green-coat"). The ID is the name of
// the entity's folder, so the suggestion follows the folder rules; nothing
// usable in the name leaves the field empty for the user to fill.
export function suggestEntityId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
    .replace(/[-.]+$/g, '');
  return slug;
}

// The title of a chat: its own name, or the date it was created when it has
// none (that is a chat's default name). A row that carries no creation date at
// all falls back to its last message date, so the header is never empty.
export function chatTitleOf(chat: {
  name?: string;
  createdAt?: number;
  lastMessageAt?: number;
}): string {
  const name = chat.name?.trim();
  if (name) return name;
  const t = chat.createdAt || chat.lastMessageAt || 0;
  return t ? formatTime(t) : '';
}

// The hover hint of a chat list row: who is in the chat (the character
// participants + the active persona) and the date of its last message — the row
// itself shows the chat's title instead.
export function chatHintOf(characters: Character[], users: User[], cs: ChatSummary): string {
  const who = `${chatLabelOf(characters, cs)} / ${chatUserLabelOf(users, cs)}`;
  const time = chatTimeOf(cs);
  return time ? `${who} · ${time}` : who;
}

// The message count label: "1 message", "2 messages", "5 messages".
export function messageCountLabel(n: number): string {
  return `${n} message${n === 1 ? '' : 's'}`;
}

// The first letter of the name for the placeholder avatar.
export function avatarLetter(name: string): string {
  const ch = name.trim().charAt(0).toUpperCase();
  return ch || '•';
}

// Splits the message text into regular lines and author descriptions /* ... */
// (setting, actions — everything that is not the heroes' dialogue). The slash
// markers themselves do not appear in the display; an unclosed /* stays regular text.
export function splitNarration(text: string): Array<{ text: string; narration: boolean }> {
  const parts: Array<{ text: string; narration: boolean }> = [];
  const re = /\/\*([\s\S]*?)\*\//g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), narration: false });
    parts.push({ text: m[1], narration: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), narration: false });
  return parts;
}

// The image hover hint: how it was generated (a ComfyUI server and the model
// of its workflow / a request to SD API / just the prompt). With several
// enabled generators the image may have been made by any of them, so the
// server details are shown only for a single one. An uploaded picture has no
// generation data — its hint is the plain click note.
export function imageHintFor(config: AppConfig | null, m: ChatMessage, img: string): string {
  const base = 'Click — add as a reference for generation';
  const prompt = m.generation?.prompt;
  if (prompt === undefined) return base;
  if (!config) return `Prompt: ${prompt}\n${base}`;
  const gens = config.imageGenerators.filter((g) => g.enabled !== false);
  const comfy = gens.length === 1 ? gens.find(isComfyUiGenerator) : undefined;
  if (comfy) {
    return `ComfyUI ${comfy.model} (${comfy.url}): ${prompt}\n${base}`;
  }
  const sdapi = gens.length === 1 ? gens.find(isSdApiGenerator) : undefined;
  if (sdapi) {
    return `SD API (${sdapi.url}): ${prompt}\n${base}`;
  }
  return `Prompt: ${prompt}\n${base}`;
}

// The default reasoning levels (mirrors the backend DEFAULT_REASONING_LEVELS).
export const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Parses the comma-separated reasoning levels text; an empty list — the
// default set (the model dialog shows it in the placeholder).
export function parseReasoningLevels(text: string): string[] {
  const levels = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return levels.length > 0 ? levels : [...DEFAULT_REASONING_LEVELS];
}
