import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ApiService, Chat } from './api';
import { ChatStore } from './chat-store';
import { ConfigStore } from './config-store';
import { UiStore } from './ui-store';

// The image domain of the input bar: asking for a picture (the 🎨 dialog and the
// 🖼 disk pick), the picture of the user's turn, the cancel/regenerate of message
// images, the picture editor, and the polling that reflects the background jobs'
// results into the chat.
//
// There is no "generation mode" any more: a picture of this app is always a
// PICTURE WITH A STORY, so it is asked for in words and the model turns those
// words into a drawing prompt plus a reference set. The one place a literal
// prompt is still written by hand is the picture editor of one picture (✎), and
// it redraws through regenerateImage.
//
// It depends ONE-WAY on ChatStore (reads the current chat / sending flag and
// applies the server chat after an action) — the store graph stays acyclic
// (ImageStore -> ChatStore -> ConfigStore -> UiStore). The "what to send"
// decision (text / edit) is orchestrated by InputPanel, which is why ChatStore
// never depends on this store.
//
// Note: the 📎 attachments (pendingImages) and the send/edit flow stay in
// ChatStore — they are part of the message composition, not of generation.
@Injectable({ providedIn: 'root' })
export class ImageStore {
  private api = inject(ApiService);
  private chatStore = inject(ChatStore);
  protected configStore = inject(ConfigStore);
  protected ui = inject(UiStore);

  // true while a request for a picture is in flight; the generation itself
  // continues in the background behind the placeholder card and is shown by
  // the polling below, so this only covers the short call that saves it.
  readonly generating = signal(false);

  // ---- lightbox ----
  // The image shown enlarged (a media URL) — set when the user clicks an
  // image in the chat. null — closed.
  readonly lightbox = signal<string | null>(null);
  openLightbox(url: string): void {
    this.lightbox.set(url);
  }
  closeLightbox(): void {
    this.lightbox.set(null);
  }

  // ---- derived ----
  // The picture buttons are shown only when a generator is available.
  readonly canGen = computed(() => this.configStore.imageGenAvailable());
  // The input placeholder.
  readonly placeholder = computed<string>(() =>
    this.chatStore.editTargetId() ? 'Editing message…' : 'Message…',
  );

  constructor() {
    // React to the chat changing: close the per-chat dialogs when the chat is
    // switched, and keep the background-job polling in sync (start it
    // while any image of the current chat is "pending", stop it otherwise).
    // Reading chatStore.chat() makes the effect re-run on every chat change,
    // including ones driven by ChatStore (open/send/edit) — no cycle, because
    // only ImageStore -> ChatStore is read here.
    let lastChatId: string | null = null;
    effect(() => {
      const chat = this.chatStore.chat();
      const id = chat?.id ?? null;
      if (id !== lastChatId) {
        this.pictureRequest.set(false);
        lastChatId = id;
      }
      // The picture editor belongs to one card: it closes with the chat it was
      // opened in, or when its message is gone (a poll applying the chat keeps
      // it open — the card is still there).
      const open = this.pictureEdit();
      if (open && !chat?.messages.some((m) => m.id === open.messageId)) this.pictureEdit.set(null);
      this.maintainPolling();
    });
  }

  // ---- a picture the user asks for ----
  // The 🎨 dialog: the user describes the picture they want, in their own
  // language, and may name the characters of the conversation — the request is
  // the picture's description, and the model of the app turns it into a drawing
  // prompt and picks the reference pictures that make a named face the same from
  // one picture to the next. The server answers with the pending card at once,
  // so the request never blocks the input.
  readonly pictureRequest = signal(false);
  openPictureRequest(): void {
    this.pictureRequest.set(true);
  }
  closePictureRequest(): void {
    this.pictureRequest.set(false);
  }

  // Submits the description. Returns true when the card was accepted (the dialog
  // then closes and the polling turns the placeholder into the picture).
  requestPicture(request: string): boolean {
    const c = this.chatStore.chat();
    if (!c || this.generating()) return false;
    const asked = request.trim();
    if (!asked) {
      this.ui.error.set('Describe the picture you want');
      return false;
    }
    this.ui.error.set('');
    this.generating.set(true);
    this.api
      .requestPicture(c.id, asked)
      .then((res) => {
        this.pictureRequest.set(false);
        this.chatStore.applyChat(res.chat);
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.generating.set(false));
    return true;
  }

  // The 🖼 button: a file from disk as a picture of this conversation. Nothing is
  // generated, so the card arrives ready — and the server keeps it in the chat's
  // folder unless the very same bytes are already a picture somewhere.
  addPictureFile(dataUrl: string): void {
    const c = this.chatStore.chat();
    if (!c) return;
    this.ui.error.set('');
    this.api
      .addPictureFile(c.id, dataUrl)
      .then((res) => this.chatStore.applyChat(res.chat))
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // ---- the picture of the user's turn ----
  // The 📷 button of the user's turn: the model plans a picture from the whole
  // dialogue and the generator draws it. The server answers as soon as the
  // placeholder card is in the chat, the rest happens in the background — the
  // user can keep typing and send their message meanwhile, and the polling
  // below turns the placeholder into the picture.
  readonly requestingTurnImage = signal(false);

  requestTurnImage(): void {
    const c = this.chatStore.chat();
    if (!c || this.requestingTurnImage()) return;
    this.ui.error.set('');
    this.requestingTurnImage.set(true);
    this.api
      .autoImage(c.id)
      .then((res) => this.chatStore.applyChat(res.chat))
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.requestingTurnImage.set(false));
  }

  // ---- background image jobs: cancel / regenerate / replace ----
  // Regenerates one image in the background: the server marks it "pending"
  // right away (the placeholder with the spinner) and the polling picks up
  // the result when the job finishes. An optional `prompt` (the "edit prompt
  // then regenerate" flow) overrides the stored one.
  regenerateImage(messageId: string, image: string, prompt?: string): Promise<void> {
    const c = this.chatStore.chat();
    if (!c) return Promise.resolve();
    return this.api
      .regenerateImage(c.id, messageId, image, prompt)
      .then((res) => this.chatStore.applyChat(res.chat))
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }
  // Cancels the in-flight generation: the image becomes the "broken" one with
  // the "Regenerate" button (the server answer carries the update).
  cancelImage(messageId: string, image: string): void {
    const c = this.chatStore.chat();
    if (!c) return;
    this.api
      .cancelImage(c.id, messageId, image)
      .then((res) => this.chatStore.applyChat(res.chat))
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // Saves the picture-editor dialog for ONE picture of a line. A picture the
  // user calls "from a file" is re-pointed at the picture they picked — an id of
  // the data folder or a file just read from disk — and stops claiming a
  // generation; a "generated" picture keeps its place and gets the prompt it is
  // redrawn with. The `image` id says WHICH picture of the line is meant, since
  // a line may show several.
  // Resolves true when the saved picture was applied (the dialog closes).
  async savePictureEdit(
    messageId: string,
    image: string,
    edit: {
      kind: 'generated' | 'file';
      description: string;
      prompt?: string;
      imageId?: string;
      data?: string;
      refs?: string[];
      depicts?: string[];
    },
  ): Promise<boolean> {
    const c = this.chatStore.chat();
    if (!c) return false;
    try {
      // A file picked from disk becomes a picture of the app's own folders first
      // (the server reuses an identical one rather than copying) and takes the
      // old picture's place in the line — which is the position it keeps: the
      // swap replaces one id with another, so the picture at this index of the
      // line is the one the fields below describe.
      let target = image;
      if (edit.kind === 'file' && edit.data) {
        const index = c.messages.find((m) => m.id === messageId)?.images.indexOf(image) ?? -1;
        const saved = await this.api.replaceImage(c.id, messageId, image, edit.data);
        this.chatStore.applyChat(saved.chat);
        const after = saved.chat.messages.find((m) => m.id === messageId)?.images ?? [];
        target = index >= 0 && after[index] ? after[index] : image;
      }
      const res = await this.api.patchPicture(c.id, messageId, target, {
        description: edit.description,
        kind: edit.kind,
        ...(edit.kind === 'generated' ? { prompt: edit.prompt ?? '' } : {}),
        // The references travel with the prompt that names them ("the first
        // reference image shows …"), so a picture redrawn later draws the same
        // face rather than a new one.
        ...(edit.kind === 'generated' && edit.refs ? { refs: edit.refs } : {}),
        ...(edit.depicts ? { depicts: edit.depicts } : {}),
        ...(edit.kind === 'file' && edit.imageId && edit.imageId !== target
          ? { repointTo: edit.imageId }
          : {}),
      });
      this.chatStore.applyChat(res.chat);
      return true;
    } catch (e) {
      this.ui.error.set(String((e as Error).message));
      return false;
    }
  }

  // ---- the picture-editor dialog ----
  // Which picture of which line is being edited (null — closed). The dialog
  // lives in the app shell, so its target is a signal here; a row only opens it.
  readonly pictureEdit = signal<{ messageId: string; image: string } | null>(null);
  openPictureEdit(messageId: string, image: string): void {
    this.pictureEdit.set({ messageId, image });
  }
  closePictureEdit(): void {
    this.pictureEdit.set(null);
  }

  // ---- the background-job polling ----
  // While any image of the current chat is "pending", the chat is re-read on
  // an interval until the placeholders turn into the ready (or the broken)
  // images; otherwise the timer is off.
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;

  private pendingImageCount(c: Chat | null): number {
    let n = 0;
    for (const m of c?.messages ?? []) {
      const st = m.imageStatus;
      if (!st) continue;
      for (const name of Object.keys(st)) {
        if (st[name] === 'pending' && m.images.includes(name)) n += 1;
      }
    }
    return n;
  }

  private maintainPolling(): void {
    const c = this.chatStore.chat();
    const want = c !== null && this.pendingImageCount(c) > 0;
    if (want && this.pollTimer === null) {
      this.pollTimer = setInterval(() => this.pollImages(), 1500);
    } else if (!want && this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private pollImages(): void {
    const id = this.chatStore.chat()?.id;
    if (id === undefined || this.pollInFlight) return;
    this.pollInFlight = true;
    this.api
      .getChat(id)
      .then((c) => {
        // The chat may have been switched/deleted in the meantime.
        if (this.chatStore.chat()?.id === id) this.chatStore.applyChat(c);
      })
      .catch(() => undefined)
      .finally(() => {
        this.pollInFlight = false;
      });
  }
}
