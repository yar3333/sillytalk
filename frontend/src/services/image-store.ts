import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ApiService, Chat } from './api';
import { ChatStore } from './chat-store';
import { ConfigStore } from './config-store';
import { UiStore } from './ui-store';

// The image-generation domain: the generation mode and its references, the
// in-flight draw, the cancel/regenerate of message images, and the polling
// that reflects the background jobs' results into the chat.
//
// It depends ONE-WAY on ChatStore (reads the current chat / character / edit
// target / sending flag and applies the server chat after an action) — the
// store graph stays acyclic (ImageStore -> ChatStore -> ConfigStore -> UiStore).
// The "what to send" decision (text / draw / edit) is orchestrated by
// InputPanel, which is why ChatStore never depends on this store.
//
// Note: the 📎 attachments (pendingImages) and the send/edit flow stay in
// ChatStore — they are part of the message composition, not of generation.
@Injectable({ providedIn: 'root' })
export class ImageStore {
  private api = inject(ApiService);
  private chatStore = inject(ChatStore);
  protected configStore = inject(ConfigStore);
  protected ui = inject(UiStore);

  // ---- generation state ----
  readonly genMode = signal(false);
  readonly genRefs = signal<string[]>([]);
  // true while the draw request (POST /image) is in flight; the actual
  // generation continues in the background and is shown by the placeholder.
  readonly generating = signal(false);

  // ---- derived ----
  // The first participant's photos (reference candidates in the gen bar).
  readonly characterPhotos = computed<string[]>(() => this.chatStore.character()?.photos ?? []);
  // The 🎨 toggle is shown only when a generator is available.
  readonly canGen = computed(() => this.configStore.imageGenAvailable());
  // The input placeholder: editing / gen mode / a normal message.
  readonly placeholder = computed<string>(() => {
    if (this.chatStore.editTargetId()) return 'Editing message…';
    return this.genMode() ? 'Prompt for the image (it will be translated)…' : 'Message…';
  });

  constructor() {
    // React to the chat changing: reset the per-chat generation setup when the
    // chat is switched, and keep the background-job polling in sync (start it
    // while any image of the current chat is "pending", stop it otherwise).
    // Reading chatStore.chat() makes the effect re-run on every chat change,
    // including ones driven by ChatStore (open/send/edit) — no cycle, because
    // only ImageStore -> ChatStore is read here.
    let lastChatId: string | null = null;
    effect(() => {
      const chat = this.chatStore.chat();
      const id = chat?.id ?? null;
      if (id !== lastChatId) {
        this.genRefs.set([]);
        this.genMode.set(false);
        lastChatId = id;
      }
      this.maintainPolling();
    });
  }

  // ---- generation mode ----
  toggleGen(): void {
    this.genMode.set(!this.genMode());
    if (!this.genMode()) this.genRefs.set([]);
  }
  removeGenRef(r: string): void {
    this.genRefs.set(this.genRefs().filter((x) => x !== r));
  }
  // A chat image becomes a generation reference (added from a message).
  addChatRef(name: string): void {
    if (!this.genRefs().includes(name)) this.genRefs.set([...this.genRefs(), name]);
  }
  // A character photo becomes a reference: it is imported into the chat files
  // first, then added to the references.
  addCharacterPhotoRef(photo: string): void {
    const c = this.chatStore.chat();
    const ch = this.chatStore.character();
    if (!c || !ch) return;
    this.api
      .importPhoto(c.id, ch.id, photo)
      .then((res) => this.addChatRef(res.name))
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // Draws an image from the prompt (gen mode). The generation runs in the
  // background: the server returns right away with the reserved "pending"
  // name (a spinner placeholder) and the polling picks up the result. One draw
  // per toggle — the mode is left after the request is accepted.
  draw(prompt: string): boolean {
    const c = this.chatStore.chat();
    if (!c || this.chatStore.sending()) return false;
    if (!prompt) {
      this.ui.error.set('Describe what to draw');
      return false;
    }
    this.ui.error.set('');
    this.generating.set(true);
    this.api
      .postImage(c.id, prompt, this.genRefs())
      .then((res) => {
        this.genRefs.set([]);
        this.genMode.set(false);
        this.chatStore.applyChat(res.chat);
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.generating.set(false));
    return true;
  }

  // ---- background image jobs: cancel / regenerate ----
  // Regenerates one image in the background: the server marks it "pending"
  // right away (the placeholder with the spinner) and the polling picks up
  // the result when the job finishes.
  regenerateImage(messageId: string, image: string): Promise<void> {
    const c = this.chatStore.chat();
    if (!c) return Promise.resolve();
    return this.api
      .regenerateImage(c.id, messageId, image)
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
