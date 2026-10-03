import {
  AppConfig,
  Character,
  ChatMessage,
  ChatSummary,
  User,
  isSdApiGenerator,
  isLocalGenerator,
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

// The image hover hint: how it was generated (the generator command with the
// placeholders substituted / a request to SD API / just the prompt). With
// several enabled generators the image may have been made by any of them, so
// the command/URL details are shown only for a single one.
export function imageHintFor(config: AppConfig | null, m: ChatMessage, img: string): string {
  const base = 'Click — add as a reference for generation';
  const prompt = m.imagePrompts?.[img];
  if (prompt === undefined) return base;
  if (!config) return `Prompt: ${prompt}\n${base}`;
  const gens = config.imageGenerators.filter((g) => g.enabled !== false);
  const local = gens.length === 1 ? gens.find(isLocalGenerator) : undefined;
  if (local) {
    const refs = (m.imageRefs?.[img] ?? []).join(',');
    const line = [local.command, ...local.args]
      .map((a) =>
        a
          .replaceAll('{prompt}', prompt)
          .replaceAll('{absolutePathsToInputImages}', refs)
          .replaceAll('{absolutePathToOutputImage}', img),
      )
      .join(' ');
    return `${line}\n${base}`;
  }
  const sdapi = gens.length === 1 ? gens.find(isSdApiGenerator) : undefined;
  if (sdapi) {
    return `SD API (${sdapi.url}): ${prompt}\n${base}`;
  }
  return `Prompt: ${prompt}\n${base}`;
}
