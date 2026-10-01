import { Component, inject, input } from '@angular/core';
import { ApiService, ChatMessage } from '../../services/api';
import { ConfigStore } from '../../services/config-store';
import { ChatStore } from '../../services/chat-store';
import { ImageStore } from '../../services/image-store';
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
        <button
          class="msg-edit del"
          (click)="chatStore.deleteFrom(message().id)"
          title="Delete the message and all subsequent ones"
        >
          🗑
        </button>
        <div class="msg-sender" data-testid="msg-sender">{{ senderName() }}</div>
        <div class="msg-text">
          @for (p of splitNarration(message().text); track $index) {
            <span [class.narration]="p.narration">{{ p.text }}</span>
          }
        </div>
        @if (isRegenerating()) {
          <!-- In-place "Regenerating…" state: the old reply stays visible (dimmed)
               while the new one is being generated, instead of a separate
               "typing…" row below it. -->
          <div class="regen-inline" data-testid="regen-inline">
            <span class="regen-spinner" aria-hidden="true"></span>
            <span>Regenerating…</span>
          </div>
        }
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
                  <span class="msg-img-wrap">
                    <img
                      [src]="mediaUrl(img)"
                      (click)="onImageClick(img)"
                      [title]="imageHint(img)"
                    />
                    @if (message().role === 'assistant') {
                      <button
                        class="img-regen"
                        (click)="imageStore.regenerateImage(message().id, img)"
                        title="Regenerate the image"
                      >
                        🔄
                      </button>
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
export class MessageRow {
  private api = inject(ApiService);
  readonly chatStore = inject(ChatStore);
  readonly imageStore = inject(ImageStore);
  private configStore = inject(ConfigStore);

  readonly message = input.required<ChatMessage>();
  readonly isLast = input.required<boolean>();

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
  // with a spinner instead of a separate "typing…" row below).
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
