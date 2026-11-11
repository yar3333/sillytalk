import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService, Character, Chat, ChatMessage, ChatSummary, Model, Picture, User } from './api';
import { ConfigStore } from './config-store';
import { chatTitleOf } from './helpers';
import { UiStore } from './ui-store';

// The current chat and the chat list: messages, sending, the 📎 attachments,
// message editing, chat management, the "New chat" dialog.
// The picture domain (asking for a picture, the picture of the turn, the
// cancel/regenerate of message images, the background-job polling) lives in
// ImageStore; the catalog — ConfigStore, the error banner — UiStore. The store
// graph stays acyclic:
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
  // ImageStore (which owns the picture buttons and the background jobs).
  readonly pendingImages = signal<string[]>([]);
  // the id of the message loaded into the bottom field for editing (null — normal input)
  readonly editTargetId = signal<string | null>(null);
  // The original text of the message being edited (editTargetId). Stored
  // separately (not re-read from the chat) so the input field keeps the text
  // even while the chat is refreshed — a reply or an image-generation poll
  // re-applies the chat and must NOT reset the field while the user types.
  // Read by InputPanel's edit effect.
  readonly editText = signal<string>('');

  // The "New chat" dialog: open + preselected ids (from the current chat).
  readonly newChatOpen = signal(false);
  readonly newChatUserDefault = signal('');
  readonly newChatCharsDefault = signal<string[]>([]);
  // While the last assistant message is being regenerated (the in-place
  // "Regenerating…" state in its bubble; the bottom typing row is hidden).
  readonly regenerating = signal(false);

  // The "Chat settings" dialog (the sampling overrides: temperature / min-p /
  // repetition penalty).
  readonly chatSettingsOpen = signal(false);

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
  // A character by id from the WHOLE catalog — not only the current participants,
  // so the author of an old message keeps its name and avatar after the chat
  // participants change (toggling a character out of a chat affects the reply
  // queue only, never the history).
  characterOf(id: string | undefined): Character | null {
    if (!id) return null;
    return this.configStore.characters().find((c) => c.id === id) ?? null;
  }
  // The name of a message author by id; without an author — the first participant.
  characterNameOf(id: string | undefined): string {
    if (!id) return this.character()?.name ?? 'Model';
    return this.characterOf(id)?.name ?? 'Model';
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
    const a = this.chatUser()?.avatar;
    return a ? this.api.mediaUrl(a) : '';
  });
  readonly charAvatarUrl = computed<string>(() => {
    const a = this.character()?.avatar;
    return a ? this.api.mediaUrl(a) : '';
  });
  // The model the app talks with — the GLOBAL config pick, else the first model
  // (the backend's resolveModel). A chat carries no model of its own: the header
  // chip shows and switches the setting for the whole app.
  readonly currentModel = computed<Model | null>(() => {
    const cfg = this.configStore.config();
    if (!cfg) return null;
    const models = this.configStore.models();
    const picked = cfg.chatModel ? models.find((m) => m.name === cfg.chatModel) : undefined;
    return picked ?? models[0] ?? null;
  });
  readonly modelLabel = computed<string>(() => this.currentModel()?.name ?? '—');
  // The model that looks at pictures — the backend's rule
  // (TextGenerationService.resolveVisionModel) mirrored here so the header names
  // the model that will really look: the global vision pick, else the chat model
  // when that can see, else the first vision-capable model of the config.
  readonly visionModel = computed<Model | null>(() => {
    const cfg = this.configStore.config();
    if (!cfg) return null;
    const models = this.configStore.models();
    const picked = cfg.visionModel ? models.find((m) => m.name === cfg.visionModel) : undefined;
    if (picked) return picked;
    const own = this.currentModel();
    if (own?.supportsImages) return own;
    return models.find((m) => m.supportsImages) ?? null;
  });
  // The explicit vision pick ('' — the default rule above); the menu's active
  // row and its "Default" entry read this.
  readonly visionModelPick = computed<string>(() => this.configStore.config()?.visionModel ?? '');
  // The hover hint of the 👁 chip: the model that describes this chat's
  // pictures (the one the app will really use), or why there is none.
  readonly visionModelTitle = computed<string>(() => {
    const m = this.visionModel();
    if (!m) return 'No model that can see pictures — add one in Settings';
    if (!m.supportsImages) return `"${m.name}" cannot see pictures`;
    return `Pictures are described by: ${m.name}`;
  });
  readonly canDescribePictures = computed<boolean>(() => this.visionModel()?.supportsImages ?? false);
  readonly idShort = computed<string>(() => this.chat()?.id ?? '');
  // The title shown in the header: the chat's own name, or the date it was
  // created while it has no name (chatTitleOf).
  readonly chatTitle = computed<string>(() => {
    const c = this.chat();
    return c ? chatTitleOf(c) : '';
  });
  // Is it the user's turn to speak: the characters have had their say (the
  // last line is one of theirs, not an error) and nothing is being generated.
  // The "draw a picture for my turn" button appears only then.
  readonly isUserTurn = computed<boolean>(() => {
    if (this.sending()) return false;
    const msgs = this.chat()?.messages ?? [];
    const last = msgs[msgs.length - 1];
    return last !== undefined && last.role === 'assistant' && !last.error;
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
    const a = c?.avatar;
    return a ? this.api.mediaUrl(a) : '';
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
    if (Object.keys(cfg.llmModels).length === 0 || users.length === 0 || chars.length === 0) return;
    this.api
      .createChat([chars[0].id], users[0].id)
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
        // The attached pictures get a caption from the vision model. It is not
        // decoration: that sentence is what a chat model without vision reads
        // about the picture in the history, and what the 📷 planner reads in its
        // catalogue. Fire-and-forget — the message is already sent.
        this.captionAttachments(res.chat.id, res.messages);
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

  // Captions the picture cards of a just-sent message: every attached picture
  // becomes its own card with an empty caption, and the vision model writes one
  // (the picture's row of the images table). Skipped without a model that can
  // see, and never in the error banner — a picture that stays unlabelled is a
  // normal state, and the card's ✎ is there for a manual try.
  private captionAttachments(chatId: string, messages: ChatMessage[]): void {
    if (!this.canDescribePictures()) return;
    const cards = messages.filter((m) => m.kind === 'image' && !m.text.trim() && m.images.length > 0);
    for (const card of cards) {
      this.api
        .captionPicture(chatId, card.id)
        .then((res) => {
          if (this.chat()?.id === chatId) this.applyChat(res.chat);
        })
        .catch(() => undefined);
    }
  }

  // Saves the edit of the message loaded into the field (the "✓" button): the
  // line of a text message or the description (caption) of an image card. An
  // empty edit is not saved. Returns true if accepted.
  // Allowed while a reply is generating: this is a PATCH, not a new generation,
  // and the backend re-reads the chat before appending a reply, so the edit and
  // the in-flight reply both persist (like deleteOne/deleteFrom, also allowed
  // during generation).
  saveEdit(text: string): boolean {
    const c = this.chat();
    const editing = this.editTargetId();
    if (!c || !editing) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;

    // The edit is applied locally right away — no pause waiting for the PATCH;
    // the server response replaces the chat, on error — banner + re-read.
    this.editTargetId.set(null);
    this.editText.set('');
    this.pendingImages.set([]);
    this.ui.error.set('');
    this.chat.set({
      ...c,
      messages: c.messages.map((m) => (m.id === editing ? { ...m, text: trimmed } : m)),
    });
    this.api
      .patchMessage(c.id, editing, { text: trimmed })
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

  // Images read by the input panel (data URLs) or picked by id.
  onImagesAdded(urls: string[]): void {
    this.pendingImages.set([...this.pendingImages(), ...urls]);
    void this.notePicturesTheModelWillNotSee(urls);
  }

  // Warns only when the added pictures will really reach the model as
  // "[A picture without a description]" — the check the old banner skipped,
  // which made it claim that photos "will not be passed" even when they were.
  // A picture reaches the model in three ways, and any one of them is enough:
  //   the chat model sees it itself (the image goes into the prompt);
  //   the vision model will caption it (the card's sentence is what a text
  //     model reads — ChatStore.captionAttachments writes it on send);
  //   the bytes are already a picture of the data folder WITH a description
  //     (the backend de-dups an identical file by size + sha256, so the card
  //     arrives carrying the row's caption from images.db).
  // The last one needs the catalog and a hash, so the answer is async: the
  // banner is raised only if the attachments are still waiting to be sent.
  private async notePicturesTheModelWillNotSee(urls: string[]): Promise<void> {
    const model = this.currentModel();
    if (!model || model.supportsImages) return;
    if (this.canDescribePictures()) return;
    const unseen = await this.picturesWithoutDescription(urls);
    // Every one of them is already described — nothing is lost, the app is quiet.
    if (unseen.length === 0) return;
    if (!unseen.some((u) => this.pendingImages().includes(u))) return; // sent/removed meanwhile
    const seer = this.visionModel();
    this.ui.error.set(
      seer
        ? `"${seer.name}" cannot see pictures, so "${model.name}" will be told only that a picture is there — not what is on it. Pick a model with vision (👁) or write the picture's description.`
        : `No model that can see pictures is configured: "${model.name}" will be told only that a picture is there — not what is on it. Pick one with 👁 or write the picture's description.`,
    );
  }

  // The added pictures whose description the model will not get: the ones
  // matched by the catalog (a data URL by size + sha256, an id by its path)
  // that carry no description, plus everything the catalog does not know.
  private async picturesWithoutDescription(urls: string[]): Promise<string[]> {
    let pictures: Picture[] = [];
    try {
      pictures = (await this.api.listPictures()).pictures;
    } catch {
      // No catalog to ask — nothing is known to be described, so the banner
      // takes the safe side (the send itself will report the real failure).
    }
    const byId = new Map(pictures.map((p) => [p.id, p]));
    const byFacts = new Map<string, Picture>();
    for (const p of pictures) {
      if (p.fileHash && typeof p.fileSize === 'number') {
        byFacts.set(`${p.fileSize}:${p.fileHash}`, p);
      }
    }
    const unseen: string[] = [];
    for (const url of urls) {
      const facts = url.startsWith('data:') ? await ChatStore.dataUrlFacts(url) : null;
      const known = facts ? byFacts.get(`${facts.size}:${facts.hash}`) : byId.get(url);
      if (!known?.description?.trim()) unseen.push(url);
    }
    return unseen;
  }

  // The size and the sha256 of a `data:image/…;base64,…` URL — the pair the
  // images table recognises a picture by (fileSize + fileHash), so a file the
  // user already owns is recognised before it is uploaded again.
  private static async dataUrlFacts(url: string): Promise<{ size: number; hash: string } | null> {
    const match = /^data:[^,]*;base64,(.+)$/s.exec(url);
    const subtle = globalThis.crypto?.subtle;
    if (!match || !subtle) return null;
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const digest = await subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    return { size: bytes.length, hash };
  }

  removePending(index: number): void {
    const arr = this.pendingImages();
    arr.splice(index, 1);
    this.pendingImages.set([...arr]);
  }

  // ---- editing a message in the bottom input field ----
  // InputPanel substitutes/clears the text (an effect on editTargetId). The
  // field carries text only: a card's picture is not re-attached when its
  // description is being corrected.
  startEdit(m: ChatMessage): void {
    this.editTargetId.set(m.id);
    this.editText.set(m.text);
    this.pendingImages.set([]);
    this.ui.error.set('');
  }

  cancelEdit(): void {
    this.editTargetId.set(null);
    this.editText.set('');
    this.pendingImages.set([]);
  }

  // Deletes the message and everything after it (the 🧹 button). Like deleteOne,
  // the confirm is the two-click "armed" state in MessageRow, not a dialog —
  // this action always runs. Optimistic like deleteOne.
  deleteFrom(messageId: string): void {
    const c = this.chat();
    if (!c) return;
    if (this.editTargetId() === messageId) this.cancelEdit();
    const idx = c.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
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

  // The global model picks (the header chips) — they are settings of the whole
  // app, so they are written to the config, not to a chat.
  selectModel(modelId: string): void {
    this.configStore.selectChatModel(modelId);
  }

  // The model that describes pictures (the 👁 menu). An empty name is a real
  // choice: back to the default — the chat model when it can see, else the
  // first vision-capable model of the config.
  selectVisionModel(name: string): void {
    this.configStore.selectVisionModel(name);
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

  // ---- chat settings (sampling overrides) ----
  openChatSettings(): void {
    this.chatSettingsOpen.set(true);
  }

  closeChatSettings(): void {
    this.chatSettingsOpen.set(false);
  }

  // Saves the chat settings of the current chat (a PATCH): its name, the
  // sampling overrides and the system-prompt addition. An empty name makes the
  // chat nameless again (its creation date titles it), a fully empty sampling
  // object and an empty systemSuffix remove the blocks server-side (the provider
  // defaults apply / nothing is appended).
  saveChatSettings(settings: {
    name: string;
    sampling: { temperature?: number; minP?: number; repetitionPenalty?: number };
    systemSuffix: string;
    stylePrompt?: string;
  }): void {
    const c = this.chat();
    if (!c) return;
    this.api
      .patchChat(c.id, {
        name: settings.name.trim(),
        sampling: settings.sampling,
        systemSuffix: settings.systemSuffix,
        ...(settings.stylePrompt !== undefined ? { stylePrompt: settings.stylePrompt } : {}),
      })
      .then((ch) => {
        this.setChat(ch);
        this.chatSettingsOpen.set(false);
        // The name titles the chat in the header and in the chat menu, so the
        // list is re-read to show it there too.
        return this.refreshChats();
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  confirmNewChat(sel: { userId: string; characterIds: string[] }): void {
    const cfg = this.configStore.config();
    if (!cfg || sel.characterIds.length === 0 || !sel.userId) return;
    this.newChatOpen.set(false);
    this.api
      .createChat(sel.characterIds, sel.userId)
      .then((chat) => {
        this.setChat(chat);
        return this.refreshChats();
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // Duplicates the current chat (its messages, its pictures, its settings) and
  // opens the copy. The server returns the copy already stored, so no re-read.
  cloneCurrentChat(): void {
    const c = this.chat();
    if (!c) return;
    this.api
      .cloneChat(c.id)
      .then((copy) => {
        this.setChat(copy);
        return this.refreshChats();
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // Gives the CURRENT chat a new ID (the Rename of the chat settings dialog).
  // The server moves the folder and rewrites the rows and the picture ids; the
  // store keeps working with the renamed chat the server answers with, and the
  // chat list is re-read because its rows are keyed by the id. Resolves to the
  // new id — or null when the name was refused (the banner already says why,
  // the same surface as the character rename).
  renameChat(newId: string): Promise<string | null> {
    const c = this.chat();
    if (!c) return Promise.resolve(null);
    return this.api
      .renameChat(c.id, newId)
      .then((r) => {
        this.setChat(r.chat);
        return this.refreshChats().then(() => r.id);
      })
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        return null;
      });
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

  // Re-reads the CURRENT chat from the server. For the changes that rewrite a
  // chat behind this store's back — renaming a character or persona ID moves its
  // folder and rewrites the participant list, the active persona and the author
  // of every line of every chat — the open conversation has to come back from
  // the server for its names, its avatars and its picture cards to be right.
  refreshCurrentChat(): void {
    const id = this.chat()?.id;
    if (id) this.refreshChat(id);
  }
}
