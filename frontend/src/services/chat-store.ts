import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService, Character, Chat, ChatMessage, ChatSummary, Model, User } from './api';
import { ConfigStore } from './config-store';
import { formatTime } from './helpers';
import { UiStore } from './ui-store';

// The current chat and the chat list: messages, sending, the 📎 attachments,
// message editing, chat management, the "New chat" dialog.
// The image-GENERATION domain (mode, references, draw, cancel/regenerate, the
// background-job polling) lives in ImageStore; the catalog — ConfigStore, the
// error banner — UiStore. The store graph stays acyclic:
// ImageStore -> ChatStore -> ConfigStore -> UiStore (ChatStore never reads
// ImageStore — InputPanel orchestrates the "what to send" decision).
// DOM concerns stay in the components: scroll to the bottom — an effect in
// MessageList, the input field text — an effect in InputPanel.
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private api = inject(ApiService);
  protected configStore = inject(ConfigStore);
  protected ui = inject(UiStore);

  // ---- chat ----
  readonly chats = signal<ChatSummary[]>([]);
  readonly chat = signal<Chat | null>(null);
  readonly sending = signal(false);
  // The character whose line is being generated right now (for the
  // "Alice is typing" indicator). null — no queue / the author is unknown.
  readonly typingCharacterId = signal<string | null>(null);

  // ---- the generation (reply-queue) session ----
  // One generation session = one reply queue (a send, an empty send, a
  // regeneration). The seq is bumped when a queue starts and on cancel, so a
  // cancelled queue stops quietly and can never clobber the new one.
  private generationSeq = 0;
  // The in-flight POST /reply fetch (one at a time) — aborted on cancel.
  private replyAbort: AbortController | null = null;
  // The chat the running queue belongs to: the user may switch chats while a
  // reply is generating, and the cancel must reach THAT chat's model call.
  private replyChatId: string | null = null;

  // ---- input ----
  // The 📎 attachments of the message being composed (data URLs / file names).
  // Part of the message composition (send/edit), so it stays here, not in
  // ImageStore (which owns the generation references, genRefs).
  readonly pendingImages = signal<string[]>([]);
  // the id of the message loaded into the bottom field for editing (null — normal input)
  readonly editTargetId = signal<string | null>(null);

  // The "New chat" dialog: open + preselected ids (from the current chat).
  readonly newChatOpen = signal(false);
  readonly newChatUserDefault = signal('');
  readonly newChatCharsDefault = signal<string[]>([]);
  // While the last assistant message is being regenerated (the in-place
  // "Regenerating…" state in its bubble; the bottom typing row is hidden).
  readonly regenerating = signal(false);

  // ---- derived (chat + catalog from ConfigStore) ----
  // The character participants of the chat in priority order (chat.characterIds).
  readonly chatCharacters = computed<Character[]>(() => {
    const c = this.chat();
    if (!c) return [];
    const all = this.configStore.characters();
    return c.characterIds
      .map((id) => all.find((x) => x.id === id))
      .filter((x): x is Character => x != null);
  });
  // The first participant — for the default label and (in ImageStore) its
  // photos as generation references.
  readonly character = computed<Character | null>(() => this.chatCharacters()[0] ?? null);
  readonly characterId = computed<string | null>(() => this.character()?.id ?? null);
  readonly participantsLabel = computed<string>(() => {
    const list = this.chatCharacters();
    return list.length > 0 ? list.map((c) => c.name).join(', ') : '—';
  });
  // The name of a character participant by id (for the label of a specific message).
  characterNameOf(id: string | undefined): string {
    if (!id) return this.character()?.name ?? 'Model';
    return this.chatCharacters().find((c) => c.id === id)?.name ?? 'Model';
  }
  // The persona of this chat (chat.userId); if the field is missing (old chat) — the first one.
  readonly chatUser = computed<User | null>(() => {
    const chat = this.chat();
    const users = this.configStore.users();
    if (!chat || users.length === 0) return null;
    return users.find((u) => u.id === chat.userId) ?? users[0];
  });
  readonly userName = computed<string>(() => this.chatUser()?.name || 'You');
  readonly characterName = computed<string>(() => this.character()?.name ?? 'Model');
  // The persona author of a specific message (msg.userId); without an author — the active one.
  userOf(id: string | undefined): User | null {
    const users = this.configStore.users();
    if (!id) return this.chatUser();
    return users.find((u) => u.id === id) ?? this.chatUser();
  }
  readonly userAvatarUrl = computed<string>(() => {
    const u = this.chatUser();
    return u?.hasAvatar ? this.api.userAvatarUrl(u.id) : '';
  });
  readonly charAvatarUrl = computed<string>(() => {
    const c = this.character();
    return c?.hasAvatar ? this.api.characterAvatarUrl(c.id) : '';
  });
  readonly currentModel = computed<Model | null>(() => {
    const c = this.chat();
    if (!c) return null;
    return this.configStore.models().find((m) => m.name === c.modelId) ?? null;
  });
  readonly modelLabel = computed<string>(() => this.currentModel()?.name ?? '—');
  readonly idShort = computed<string>(() => this.chat()?.id ?? '');
  readonly lastTime = computed<string>(() => {
    const msgs = this.chat()?.messages ?? [];
    const t = msgs.length > 0 ? msgs[msgs.length - 1].timestamp : 0;
    if (!t) return '';
    return formatTime(t);
  });
  // Who is answering right now (for the indicator under the history): the name
  // and the avatar of the author whose line is being generated; null — the
  // author is unknown. The "Generating image…" label (while ImageStore is
  // drawing) is combined by MessageList, which reads both stores.
  readonly typingName = computed<string | null>(() => {
    const id = this.typingCharacterId();
    return id ? this.characterNameOf(id) : null;
  });
  readonly typingAvatarUrl = computed<string>(() => {
    const id = this.typingCharacterId();
    const c = id ? this.chatCharacters().find((x) => x.id === id) : null;
    return c?.hasAvatar ? this.api.characterAvatarUrl(c.id) : '';
  });
  typingLabel(): string {
    const name = this.typingName();
    return name ? `${name} is typing` : 'is typing';
  }

  // ---- lifecycle ----
  /** Catalog (ConfigStore) → chat list → open (or create) the first one. */
  bootstrap(): void {
    this.configStore
      .loadAll()
      .then(() => this.api.getChats())
      .then((chats) => {
        this.chats.set(chats);
        this.ensureChat();
      })
      .catch((e) => this.ui.error.set(String(e?.message ?? e)));
  }

  private ensureChat(): void {
    const chats = this.chats();
    const cfg = this.configStore.config();
    if (!cfg) return;
    if (chats.length > 0) {
      this.api
        .getChat(chats[0].id)
        .then((c) => this.setChat(c))
        .catch(() => this.newChat());
      return;
    }
    // There are no chats yet — create the first one with the default persona
    // and character, so the app does not open with an empty dialog.
    const users = this.configStore.users();
    const chars = this.configStore.characters();
    const modelKeys = Object.keys(cfg.llmModels);
    if (modelKeys.length === 0 || users.length === 0 || chars.length === 0) return;
    this.api
      .createChat([chars[0].id], modelKeys[0], users[0].id)
      .then((chat) => {
        this.setChat(chat);
        return this.refreshChats();
      })
      .catch((e) => this.ui.error.set(String(e?.message ?? e)));
  }

  private lastChatId: string | null = null;

  private setChat(chat: Chat | null): void {
    const id = chat?.id ?? null;
    // The 📎 attachments are per-chat: reset them only when the chat actually
    // changes — NOT on the refreshes (send/edit/poll) that set the same chat.
    // (The generation setup, genRefs/genMode, is reset by ImageStore the same
    // way, watching this signal.)
    if (id !== this.lastChatId) {
      this.pendingImages.set([]);
      this.lastChatId = id;
    }
    this.chat.set(chat);
  }

  // Applies a server chat. The public entry point other stores (ImageStore)
  // use to reflect their results — keeps the dependency one-way.
  applyChat(chat: Chat): void {
    this.setChat(chat);
  }

  // ---- sending ----
  // Sends a normal message (text and/or the 📎 attachments). An empty send
  // (no text, no images) means "another message from the AI" and continues
  // the reply queue. Returns true if accepted (then InputPanel clears the
  // textarea). The gen-mode path is NOT here — InputPanel calls ImageStore.
  send(text: string): boolean {
    const c = this.chat();
    if (!c || this.sending()) return false;
    const trimmed = text.trim();
    const images = this.pendingImages();
    const seq = ++this.generationSeq;

    // Neither text nor images — the user wants another message from the AI.
    if (!trimmed && images.length === 0) {
      if (c.messages.length === 0) {
        this.ui.error.set('Write something to start the conversation');
        return false;
      }
      this.pendingImages.set([]);
      this.runReplyQueue(c, this.nextTurnIndex(c), c.characterIds.length, seq);
      return true;
    }

    this.pendingImages.set([]);
    this.ui.error.set('');
    // POST /messages only saves the message and answers instantly,
    // so no echo is needed — the server object replaces the local one right away.
    this.sending.set(true);
    this.api
      .postMessage(c.id, trimmed, images)
      .then((res) => {
        // The user cancelled while the message was being saved: the message
        // is on the server — show it, but do not start the reply queue.
        if (this.generationSeq !== seq) {
          this.setChat(res.chat);
          return;
        }
        this.setChat(res.chat);
        // The reply queue starts with the character mentioned by name,
        // otherwise — in turn order.
        return this.runReplyQueue(
          res.chat,
          this.mentionStartIndex(res.chat, trimmed),
          res.chat.characterIds.length,
          seq,
        );
      })
      .catch((e) => {
        if (this.generationSeq !== seq) return; // cancelled
        this.ui.error.set(String((e as Error).message));
        this.refreshChat(c.id);
      })
      .finally(() => {
        if (this.generationSeq === seq) this.sending.set(false);
      });
    return true;
  }

  // Saves the edit of the message loaded into the field (the "✓" button).
  // An empty edit (no text, no images) is not saved. Returns true if accepted.
  saveEdit(text: string): boolean {
    const c = this.chat();
    const editing = this.editTargetId();
    if (!c || !editing || this.sending()) return false;
    const trimmed = text.trim();
    const images = this.pendingImages();
    if (!trimmed && images.length === 0) return false;

    // The edit is applied locally right away — no pause waiting for the PATCH;
    // the server response replaces the chat, on error — banner + re-read.
    this.editTargetId.set(null);
    this.pendingImages.set([]);
    this.ui.error.set('');
    this.chat.set({
      ...c,
      messages: c.messages.map((m) =>
        m.id === editing ? { ...m, text: trimmed, images } : m,
      ),
    });
    this.api
      .patchMessage(c.id, editing, { text: trimmed, images })
      .then((res) => this.setChat(res.chat))
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        this.refreshChat(c.id);
      });
    return true;
  }

  // Asks each participant to reply in turn, starting from startIndex
  // (count participants). Lines come one by one (POST /reply) and appear
  // in the chat immediately; typingCharacterId between the calls shows who
  // is generating. A silent one ([SILENT]) is simply skipped, a model error
  // breaks the queue. `seq` is the generation session (see cancelGeneration):
  // when it is no longer the current one the queue stops quietly.
  // `replaceLast` (regeneration): the backend replaces the last assistant
  // message with the new reply.
  private async runReplyQueue(
    c: Chat,
    startIndex: number,
    count = c.characterIds.length,
    seq: number,
    replaceLast = false,
  ): Promise<void> {
    this.sending.set(true);
    this.replyChatId = c.id;
    try {
      for (let i = 0; i < count; i++) {
        if (this.generationSeq !== seq) return; // cancelled / superseded
        const ids = this.chat()?.characterIds ?? c.characterIds;
        const characterId = ids[(startIndex + i) % ids.length];
        this.typingCharacterId.set(characterId);
        const ctrl = new AbortController();
        this.replyAbort = ctrl;
        try {
          const res = await this.api.nextReply(c.id, characterId, ctrl.signal, replaceLast);
          this.setChat(res.chat);
          const lastMsg = res.chat.messages[res.chat.messages.length - 1];
          if (lastMsg?.error) break;
        } finally {
          if (this.replyAbort === ctrl) this.replyAbort = null;
        }
      }
    } catch (e) {
      if (this.generationSeq !== seq) return; // cancelled — no error banner
      this.ui.error.set(String((e as Error).message));
      this.refreshChat(c.id);
    } finally {
      // A cancelled (or superseded) session is already cleaned up by
      // cancelGeneration / the new session — only the current one resets here.
      if (this.generationSeq === seq) {
        this.typingCharacterId.set(null);
        this.sending.set(false);
        this.regenerating.set(false);
      }
    }
  }

  // Cancels the in-flight generation — the send button is the ✕ while a
  // reply is being generated. The in-flight POST /reply fetch is aborted,
  // the server is told to abort the model call (no message is saved for a
  // cancelled reply), and the generation session is invalidated, so the
  // running queue stops quietly. A fresh send starts a new session.
  cancelGeneration(): void {
    if (!this.sending()) return;
    this.generationSeq += 1;
    this.replyAbort?.abort();
    this.replyAbort = null;
    this.typingCharacterId.set(null);
    this.sending.set(false);
    this.regenerating.set(false);
    // The cancel goes to the chat the queue runs in — not necessarily the
    // one on screen (the user may have switched while the reply generates).
    const chatId = this.replyChatId ?? this.chat()?.id ?? null;
    this.replyChatId = null;
    if (!chatId) return;
    // The server aborts the model call; the answer re-syncs the chat (a
    // reply that landed in the last moment is already saved and stays).
    // Skip the re-sync when a new generation has started in the meantime.
    this.api
      .cancelReply(chatId)
      .then((res) => {
        if (this.chat()?.id === res.chat.id && !this.sending()) this.applyChat(res.chat);
      })
      .catch(() => undefined);
  }

  // The index of the participant addressed by name in the text ("Alice, …").
  private mentionStartIndex(c: Chat, text: string): number {
    const t = ` ${text.toLowerCase()} `;
    const chars = this.chatCharacters();
    for (let i = 0; i < c.characterIds.length; i++) {
      const name = chars.find((x) => x.id === c.characterIds[i])?.name.trim().toLowerCase();
      if (!name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(t)) return i;
    }
    return 0;
  }

  // Whose turn: the next one after the last replier (round-robin); if the
  // history is empty or the last message is from the user — the first one's turn.
  private nextTurnIndex(c: Chat): number {
    const last = [...c.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && !m.error && m.characterId);
    const ids = c.characterIds;
    if (!last?.characterId || ids.length === 0) return 0;
    const prev = ids.indexOf(last.characterId);
    return prev === -1 ? 0 : (prev + 1) % ids.length;
  }

  // Images read by the input panel (data URLs).
  onImagesAdded(urls: string[]): void {
    this.pendingImages.set([...this.pendingImages(), ...urls]);
    const model = this.currentModel();
    if (model && !model.supportsImages) {
      this.ui.error.set(
        `The model "${model.name}" does not support images — the photos will not be passed`,
      );
    }
  }

  removePending(index: number): void {
    const arr = this.pendingImages();
    arr.splice(index, 1);
    this.pendingImages.set([...arr]);
  }

  // Drops the 📎 attachments. Used by the gen-mode path (a draw ignores the
  // attachments, but they are cleared on send, as a normal send does).
  clearPendingImages(): void {
    this.pendingImages.set([]);
  }

  // ---- editing a message in the bottom input field ----
  // InputPanel substitutes/clears the text (an effect on editTargetId).
  startEdit(m: ChatMessage): void {
    this.editTargetId.set(m.id);
    this.pendingImages.set([...m.images]);
    this.ui.error.set('');
  }

  cancelEdit(): void {
    this.editTargetId.set(null);
    this.pendingImages.set([]);
  }

  deleteFrom(messageId: string): void {
    const c = this.chat();
    if (!c) return;
    if (this.editTargetId() === messageId) this.cancelEdit();
    const idx = c.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    // Deleting a message truncates the tail: warn when more than one message
    // will be removed (the frequent "delete the last reply" stays one-click).
    if (idx < c.messages.length - 1) {
      const n = c.messages.length - idx;
      if (!confirm(`Delete this message and ${n - 1} more after it?`)) return;
    }
    // Optimistic: the rows disappear right away (no pause waiting for the
    // full-chat JSON round-trip); the server response replaces the chat,
    // an error restores it via a re-read.
    this.chat.set({ ...c, messages: c.messages.slice(0, idx) });
    this.api
      .deleteMessageFrom(c.id, messageId)
      .then((res) => this.setChat(res.chat))
      .catch((err) => {
        this.ui.error.set(String((err as Error).message));
        this.refreshChat(c.id);
      });
  }

  // Deletes a single message, keeping the rest of the chat as is (the 🗑
  // button — the confirm for it is the two-click "armed" state in MessageRow,
  // not a dialog). Optimistic like deleteFrom.
  deleteOne(messageId: string): void {
    const c = this.chat();
    if (!c) return;
    if (this.editTargetId() === messageId) this.cancelEdit();
    if (!c.messages.some((m) => m.id === messageId)) return;
    this.chat.set({ ...c, messages: c.messages.filter((m) => m.id !== messageId) });
    this.api
      .deleteMessage(c.id, messageId)
      .then((res) => this.setChat(res.chat))
      .catch((err) => {
        this.ui.error.set(String((err as Error).message));
        this.refreshChat(c.id);
      });
  }

  // Regenerates the last assistant reply (one line from its author that
  // replaces it). Guarded by `sending` only — image generation is in the
  // background (ImageStore) and no longer blocks the dialogue.
  regenerate(): void {
    const c = this.chat();
    if (!c || this.sending()) return;
    const last = c.messages[c.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    this.ui.error.set('');
    this.editTargetId.set(null);
    // The backend replaces the last message itself (`replaceLast`): it removes
    // the old one only after the new reply is saved, so a cancel or a model
    // error keeps the original reply. The local chat is not touched — the old
    // message stays on screen with an in-place "Regenerating…" state.
    const characterId = last.characterId ?? c.characterIds[0] ?? '';
    const startIndex = Math.max(0, c.characterIds.indexOf(characterId));
    const seq = ++this.generationSeq;
    this.sending.set(true);
    this.regenerating.set(true);
    this.runReplyQueue(c, startIndex, 1, seq, true);
  }

  // ---- chat management ----
  // Add/remove a character participant (appended to the end of the list;
  // the last one cannot be removed — at least one must answer in the chat).
  toggleCharacter(id: string): void {
    const c = this.chat();
    if (!c) return;
    let ids: string[];
    if (c.characterIds.includes(id)) {
      if (c.characterIds.length === 1) return;
      ids = c.characterIds.filter((x) => x !== id);
    } else {
      ids = [...c.characterIds, id];
    }
    this.api.patchChat(c.id, { characterIds: ids }).then((ch) => this.setChat(ch));
  }

  // The reply priority = the list order; a participant is moved with the ↑/↓ buttons.
  moveCharacter(id: string, dir: -1 | 1): void {
    const c = this.chat();
    if (!c) return;
    const ids = [...c.characterIds];
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.api.patchChat(c.id, { characterIds: ids }).then((ch) => this.setChat(ch));
  }

  selectUser(id: string): void {
    const c = this.chat();
    if (!c) return;
    this.api.patchChat(c.id, { userId: id }).then((ch) => this.setChat(ch));
  }

  selectModel(modelId: string): void {
    const c = this.chat();
    if (!c) return;
    this.api.patchChat(c.id, { modelId }).then((ch) => this.setChat(ch));
  }

  refreshChats(): Promise<void> {
    return this.api.getChats().then((chats) => this.chats.set(chats));
  }

  openChat(id: string): void {
    this.api
      .getChat(id)
      .then((c) => this.setChat(c))
      .catch(() => this.ui.error.set('Chat not found'));
  }

  // Opens the "New chat" dialog: the persona and characters are picked in it.
  newChat(): void {
    const cfg = this.configStore.config();
    if (!cfg || Object.keys(cfg.llmModels).length === 0) return;
    const users = this.configStore.users();
    const chars = this.configStore.characters();
    if (users.length === 0 || chars.length === 0) return;
    const c = this.chat();
    this.newChatUserDefault.set(c?.userId ?? '');
    this.newChatCharsDefault.set(c?.characterIds ?? []);
    this.newChatOpen.set(true);
  }

  closeNewChat(): void {
    this.newChatOpen.set(false);
  }

  confirmNewChat(sel: { userId: string; characterIds: string[] }): void {
    const cfg = this.configStore.config();
    if (!cfg || sel.characterIds.length === 0 || !sel.userId) return;
    const c = this.chat();
    const modelId =
      c && Object.keys(cfg.llmModels).includes(c.modelId)
        ? c.modelId
        : (Object.keys(cfg.llmModels)[0] ?? '');
    this.newChatOpen.set(false);
    this.api
      .createChat(sel.characterIds, modelId, sel.userId)
      .then((chat) => {
        this.setChat(chat);
        return this.refreshChats();
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  deleteCurrentChat(): void {
    const c = this.chat();
    if (!c) return;
    if (!confirm('Delete the chat?')) return;
    this.api
      .deleteChat(c.id)
      .then(() => {
        this.setChat(null);
        return this.refreshChats();
      })
      .then(() => this.ensureChat())
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
      });
  }

  private refreshChat(id: string): void {
    this.api
      .getChat(id)
      .then((c) => this.setChat(c))
      .catch(() => undefined);
  }
}
