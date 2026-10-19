import { Component, OnDestroy, inject, input, signal } from '@angular/core';
import { ApiService, ChatMessage } from '../../services/api';
import { ConfigStore } from '../../services/config-store';
import { ChatStore } from '../../services/chat-store';
import { ImageStore } from '../../services/image-store';
import { UiStore } from '../../services/ui-store';
import { avatarLetter, imageHintFor, splitNarration as splitNarrationParts } from '../../services/helpers';

// One message in the history: the avatar, the sender, the text, the images
// and the hover buttons (edit / delete / regenerate).
// Chat actions (edit / delete / regenerate the reply) — ChatStore; image
// actions (cancel / regenerate one image, add a reference) — ImageStore.
@Component({
  selector: 'app-message-row',
  template: `
    <div class="msg-row" [class.user]="message().role === 'user'">
      <div class="avatar" [class.user]="message().role === 'user'" aria-hidden="true">
        @if (avatarUrl()) {
          <img [src]="avatarUrl()" alt="" />
        } @else {
          {{ letter() }}
        }
      </div>
      <div
        class="msg"
        data-testid="message"
        [class.user]="message().role === 'user'"
        [class.error]="message().error"
        [class.has-images]="message().images.length > 0"
        [class.regenerating]="isRegenerating()"
      >
        @if (isLast() && message().role === 'assistant') {
          <button
            class="msg-edit regen"
            (click)="chatStore.regenerate()"
            title="Regenerate the reply"
          >
            ↻
          </button>
        }
        <button
          class="msg-edit edit"
          (click)="chatStore.startEdit(message())"
          title="Edit the message"
        >
          ✎
        </button>
        <!-- Delete this message only: the first click arms the button (it
             glows red), a second click within ~2 s deletes; it disarms after
             the window. The confirm lives in the button, not a dialog. -->
        <button
          class="msg-edit del"
          [class.armed]="deleteArmed()"
          (click)="onSingleDeleteClick()"
          title="Delete this message (click again to confirm)"
        >
          🗑
        </button>
        <!-- Delete this message and everything after it: armed the same way. -->
        <button
          class="msg-edit del-more"
          [class.armed]="tailDeleteArmed()"
          (click)="onTailDeleteClick()"
          title="Delete this message and all subsequent ones (click again to confirm)"
        >
          🧹
        </button>
        <div class="msg-sender" data-testid="msg-sender">{{ senderName() }}</div>
        <div class="msg-text">
          @for (p of splitNarration(message().text); track $index) {
            <span [class.narration]="p.narration">{{ p.text }}</span>
          }
        </div>
        @if (message().images.length) {
          <div class="msg-images">
            @for (img of message().images; track img) {
              @switch (imgStatus(img)) {
                @case ('pending') {
                  <span class="img-placeholder img-pending" data-testid="img-pending">
                    <span class="img-spinner img-spinner-lg" aria-hidden="true"></span>
                    <span class="img-placeholder-label">Generating the image…</span>
                    <button
                      class="img-cancel"
                      data-testid="img-cancel"
                      (click)="imageStore.cancelImage(message().id, img)"
                      title="Cancel the generation"
                    >
                      ✕ Cancel
                    </button>
                  </span>
                }
                @case ('failed') {
                  <span class="img-placeholder img-broken" data-testid="img-broken">
                    <span class="img-broken-icon" aria-hidden="true">🖼️</span>
                    <span class="img-placeholder-label">Image generation failed</span>
                    @if (imageError(img)) {
                      <span class="img-error-text" [title]="imageError(img)">{{ imageError(img) }}</span>
                    }
                    <button
                      class="img-regen-btn"
                      data-testid="img-regen"
                      (click)="imageStore.regenerateImage(message().id, img)"
                      title="Regenerate the image"
                    >
                      🔄 Regenerate
                    </button>
                  </span>
                }
                @case ('cancelled') {
                  <span class="img-placeholder img-cancelled" data-testid="img-cancelled">
                    <span class="img-broken-icon" aria-hidden="true">🖼️</span>
                    <span class="img-placeholder-label">Image generation cancelled</span>
                    <button
                      class="img-regen-btn"
                      data-testid="img-regen"
                      (click)="imageStore.regenerateImage(message().id, img)"
                      title="Regenerate the image"
                    >
                      🔄 Regenerate
                    </button>
                  </span>
                }
                @default {
                  <span class="msg-img-wrap" [class.editing]="editingImg() === img">
                    <img
                      [src]="mediaUrl(img)"
                      (click)="onImageClick(img)"
                      [title]="imageHint(img)"
                    />
                    @if (message().role === 'assistant') {
                      @if (editingImg() === img) {
                        <!-- The inline prompt editor: change the prompt and
                             regenerate the image with it (the image is drawn
                             in the background against the same name). -->
                        <div class="img-edit-panel">
                          <textarea
                            rows="3"
                            data-testid="img-prompt-input"
                            placeholder="Prompt for the image"
                            (input)="onPromptInput($event)"
                            [value]="promptDraft()"
                          ></textarea>
                          <div class="img-edit-actions">
                            <button
                              class="img-edit-btn primary"
                              data-testid="img-prompt-save"
                              (click)="savePromptEdit(img)"
                            >
                              Regenerate
                            </button>
                            <button
                              class="img-edit-btn"
                              data-testid="img-prompt-cancel"
                              (click)="cancelPromptEdit()"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      } @else {
                        <button
                          class="img-regen"
                          (click)="imageStore.regenerateImage(message().id, img)"
                          title="Regenerate the image"
                        >
                          🔄
                        </button>
                        <button
                          class="img-edit-prompt"
                          data-testid="img-edit-prompt"
                          (click)="startPromptEdit(img)"
                          title="Change the prompt and regenerate"
                        >
                          ✎
                        </button>
                        <label
                          class="img-replace"
                          data-testid="img-replace"
                          title="Replace the image with your own"
                        >
                          ⬆
                          <input
                            type="file"
                            hidden
                            accept="image/*"
                            (change)="onReplace($event, img)"
                          />
                        </label>
                      }
                    }
                  </span>
                }
              }
            }
          </div>
        }
      </div>
    </div>
  `,
  styleUrl: './message-row.scss',
})
export class MessageRow implements OnDestroy {
  private api = inject(ApiService);
  readonly chatStore = inject(ChatStore);
  readonly imageStore = inject(ImageStore);
  private configStore = inject(ConfigStore);
  private ui = inject(UiStore);

  readonly message = input.required<ChatMessage>();
  readonly isLast = input.required<boolean>();

  // The inline prompt editor: which image is being re-prompted and the draft
  // text. Local to the row — one image is edited at a time.
  readonly editingImg = signal<string | null>(null);
  readonly promptDraft = signal('');

  // Opens the inline prompt editor for one image, pre-filled with its stored
  // prompt (the hint text is not editable — the stored prompt is).
  startPromptEdit(img: string): void {
    this.editingImg.set(img);
    this.promptDraft.set(this.message().imagePrompts?.[img] ?? '');
  }
  onPromptInput(e: Event): void {
    this.promptDraft.set((e.target as HTMLTextAreaElement).value);
  }
  cancelPromptEdit(): void {
    this.editingImg.set(null);
  }
  // Saves the typed prompt: regenerates the image against the same name with
  // it ("edit prompt then regenerate") and closes the editor. An empty prompt
  // is refused — the image needs a description to draw.
  savePromptEdit(img: string): void {
    const prompt = this.promptDraft().trim();
    if (!prompt) {
      this.ui.error.set('Describe what to draw');
      return;
    }
    this.editingImg.set(null);
    void this.imageStore.regenerateImage(this.message().id, img, prompt);
  }

  // Replaces the image with a file the user picks: read as a data URL and
  // handed to the server (swap in the message), no generation round-trip.
  onReplace(e: Event, img: string): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void this.readFile(file).then((data) =>
      this.imageStore.replaceImage(this.message().id, img, data),
    );
  }
  private readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // The "armed" state of the delete buttons: the 🗑 (this message) and the 🧹
  // (this message + the tail) both confirm with a second click instead of a
  // dialog — the first click turns the button red, a second click within ~2 s
  // deletes, otherwise it disarms. Local to the row — each message has its own
  // component instance (tracked by id), so the state never leaks between
  // messages.
  private deleteArmed = signal(false);
  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
  private tailDeleteArmed = signal(false);
  private tailDeleteTimer: ReturnType<typeof setTimeout> | null = null;

  onSingleDeleteClick(): void {
    if (!this.deleteArmed()) {
      // First click: arm the button (red) and start the ~2 s confirmation window.
      this.deleteArmed.set(true);
      if (this.deleteTimer) clearTimeout(this.deleteTimer);
      this.deleteTimer = setTimeout(() => {
        this.deleteArmed.set(false);
        this.deleteTimer = null;
      }, 2000);
      return;
    }
    // Second click within the window: delete the message.
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }
    this.deleteArmed.set(false);
    this.chatStore.deleteOne(this.message().id);
  }

  onTailDeleteClick(): void {
    if (!this.tailDeleteArmed()) {
      this.tailDeleteArmed.set(true);
      if (this.tailDeleteTimer) clearTimeout(this.tailDeleteTimer);
      this.tailDeleteTimer = setTimeout(() => {
        this.tailDeleteArmed.set(false);
        this.tailDeleteTimer = null;
      }, 2000);
      return;
    }
    if (this.tailDeleteTimer) {
      clearTimeout(this.tailDeleteTimer);
      this.tailDeleteTimer = null;
    }
    this.tailDeleteArmed.set(false);
    this.chatStore.deleteFrom(this.message().id);
  }

  ngOnDestroy(): void {
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }
    if (this.tailDeleteTimer) {
      clearTimeout(this.tailDeleteTimer);
      this.tailDeleteTimer = null;
    }
  }

  mediaUrl(img: string): string {
    return this.api.mediaUrl(this.chatStore.chat()?.id ?? '', img);
  }
  imageHint(img: string): string {
    return imageHintFor(this.configStore.config(), this.message(), img);
  }
  // The generation status of one image: absent from imageStatus — the ready
  // image, "pending" — the spinner placeholder, "failed" — the broken one,
  // "cancelled" — the one the user cancelled (its own placeholder, not an error).
  imgStatus(img: string): 'pending' | 'failed' | 'cancelled' | null {
    return this.message().imageStatus?.[img] ?? null;
  }
  // Clicking a ready image: add it as a generation reference AND open it in
  // the lightbox (enlarged), so the action is visible and the user can see
  // the image larger.
  onImageClick(img: string): void {
    this.imageStore.addChatRef(img);
    this.imageStore.openLightbox(this.mediaUrl(img));
  }
  imageError(img: string): string {
    return this.message().imageErrors?.[img] ?? '';
  }
  // The message author is stored on the message itself: user — the persona
  // (msg.userId), assistant — the character (msg.characterId). Messages of old
  // authors keep their names and avatars even after the participants change.
  senderName(): string {
    if (this.message().role === 'user') {
      return this.chatStore.userOf(this.message().userId)?.name || 'You';
    }
    return this.chatStore.characterNameOf(this.message().characterId);
  }
  avatarUrl(): string {
    if (this.message().role === 'user') {
      const u = this.chatStore.userOf(this.message().userId);
      return u?.hasAvatar ? this.api.userAvatarUrl(u.id) : '';
    }
    const id = this.message().characterId ?? this.chatStore.character()?.id;
    const c = this.chatStore.chatCharacters().find((x) => x.id === id);
    return c?.hasAvatar ? this.api.characterAvatarUrl(c.id) : '';
  }
  letter(): string {
    return avatarLetter(this.senderName());
  }
  // The in-place "Regenerating…" state: only for the last assistant message
  // while a regeneration is running (the old reply stays visible, dimmed,
  // with a brightness wave sweeping across the bubble's border from left to
  // right instead of a separate "typing…" row below).
  isRegenerating(): boolean {
    return (
      this.isLast() &&
      this.message().role === 'assistant' &&
      this.chatStore.regenerating()
    );
  }

  // The lines and the author descriptions /* ... */ separately — for highlighting.
  splitNarration(text: string) {
    return splitNarrationParts(text);
  }
}
