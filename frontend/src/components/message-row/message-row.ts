import { Component, OnDestroy, inject, input, signal } from '@angular/core';
import { ApiService, ChatMessage } from '../../services/api';
import { ConfigStore } from '../../services/config-store';
import { ChatStore } from '../../services/chat-store';
import { ImageStore } from '../../services/image-store';
import { avatarLetter, imageHintFor, splitNarration as splitNarrationParts } from '../../services/helpers';

// One line of the history. A text line carries its author's words and, when the
// author shows pictures, those pictures right under the words — a picture a
// character shares or a user attaches IS part of their line, not a message of
// its own. The other shape is the NEUTRAL picture card: nothing but one picture
// and no author, which only the two controls that hand a picture to the chat
// produce (the 🖼 disk pick and the 📷 picture of the turn).
// Every picture brings with it what its row of the images table says: the
// caption (what is on it), the prompt it was drawn from, how many references it
// used, plus the quick redraw (↻) and the ✎ of the picture editor.
// Chat actions (edit / delete / regenerate the reply) — ChatStore; image
// actions (cancel / regenerate / open the editor) — ImageStore.
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
        [class.has-images]="hasPictures()"
        [class.card]="isCard()"
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
          data-testid="msg-edit"
          (click)="onEdit()"
          [title]="isCard() ? 'Edit the picture' : 'Edit the message'"
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

        <!-- A neutral card has no words of its own (its caption is written under
             the picture), and a line that was nothing but picture markers has no
             text either — in both cases there is nothing to print here. -->
        @if (message().text.trim()) {
          <div class="msg-text">
            @for (p of splitNarration(message().text); track $index) {
              <span [class.narration]="p.narration">{{ p.text }}</span>
            }
          </div>
        }

        @if (hasPictures()) {
          <div class="card-body">
            @for (img of message().images; track img) {
              <div class="picture" [attr.data-testid]="isCard() ? 'image-card' : 'line-picture'">
                @switch (imgStatus(img)) {
                  @case ('pending') {
                    <span class="img-placeholder img-pending" data-testid="img-pending">
                      <span class="img-spinner img-spinner-lg" aria-hidden="true"></span>
                      <span class="img-placeholder-label">{{ pendingLabel(img) }}</span>
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
                        <span class="img-error-text" data-testid="img-error-text" [title]="imageError(img)">{{ imageError(img) }}</span>
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
                        [alt]="captionOf(img) || 'Picture'"
                      />
                      <!-- The quick redraw, and — for a picture that lives inside
                           somebody's line — their own ✎: a line may show several
                           pictures, so the editor needs to know which one.
                           Everything else about the picture (its prompt, its
                           description, the file it points at) lives there. -->
                      @if (canRedraw(img)) {
                        <button
                          class="img-regen"
                          data-testid="img-regenerate"
                          (click)="imageStore.regenerateImage(message().id, img)"
                          title="Regenerate the image"
                        >
                          🔄
                        </button>
                      }
                      @if (!isCard()) {
                        <button
                          class="img-edit-picture"
                          data-testid="picture-edit"
                          (click)="onEditPicture(img)"
                          title="Edit the picture"
                        >
                          ✎
                        </button>
                      }
                    </span>
                  }
                }
                @if (captionOf(img)) {
                  <div class="card-caption" data-testid="card-caption">{{ captionOf(img) }}</div>
                }
                @if (promptOf(img)) {
                  <div class="card-prompt" data-testid="card-prompt" [title]="promptOf(img)">
                    {{ promptOf(img) }}
                  </div>
                }
                @if (refsOf(img)) {
                  <div class="card-refs" data-testid="card-refs">{{ refsOf(img) }}</div>
                }
              </div>
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

  readonly message = input.required<ChatMessage>();
  readonly isLast = input.required<boolean>();

  // The neutral picture card: a message that is nothing but one picture and
  // belongs to the conversation, not to a person. Any other line may still carry
  // pictures — under its words.
  isCard(): boolean {
    return this.message().kind === 'image';
  }
  hasPictures(): boolean {
    return (this.message().images?.length ?? 0) > 0;
  }
  // What one picture of this line is said to show — its row of the images
  // table, the same sentence a model without vision is given in its place. (For
  // a neutral card the server also writes it into the message's `text`, which is
  // why the card has no text block of its own above the picture.)
  captionOf(img: string): string {
    return this.message().pictures?.[img]?.description?.trim() ?? '';
  }
  // What the picture was drawn from — shown under it so the user can see and
  // reuse it. Empty for a file somebody brought, which has no prompt.
  promptOf(img: string): string {
    return this.message().pictures?.[img]?.generation?.prompt?.trim() ?? '';
  }
  // How many reference pictures it was drawn from (their file names would only
  // be noise here — the hover hint of the image lists them).
  refsOf(img: string): string {
    const n = this.message().pictures?.[img]?.generation?.refs?.length ?? 0;
    return n > 0 ? `references: ${n}` : '';
  }
  // A picture can be redrawn only when there is a prompt to draw from — an
  // uploaded photo has none until the user writes one.
  canRedraw(img: string): boolean {
    return this.promptOf(img).length > 0;
  }
  pendingLabel(img: string): string {
    // A picture that is being asked for is first PLANNED (the model turns the
    // words into a drawing prompt and a reference set), so the label says both
    // halves. A redraw of a stored prompt needs no planning and says only what
    // it is doing.
    return this.promptOf(img) ? 'Generating the image…' : 'Planning and drawing the picture…';
  }

  // The ✎ of the row: a text message goes into the bottom field's edit mode; the
  // neutral card opens the picture editor (its prompt, its description and the
  // file it points at all live there). A line with words AND pictures edits its
  // words here — each of its pictures has its own ✎.
  onEdit(): void {
    if (this.isCard() && this.message().images[0]) {
      this.imageStore.openPictureEdit(this.message().id, this.message().images[0]);
      return;
    }
    this.chatStore.startEdit(this.message());
  }
  // The ✎ of one picture inside a line — the same editor, opened for that id.
  onEditPicture(img: string): void {
    this.imageStore.openPictureEdit(this.message().id, img);
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
    return this.api.mediaUrl(img);
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
  // Clicking a ready image opens it in the lightbox (enlarged). A click adds no
  // reference any more: the reference set of a picture is what the model builds
  // when the picture is asked for, not something the user stacks by clicking.
  onImageClick(img: string): void {
    this.imageStore.openLightbox(this.mediaUrl(img));
  }
  imageError(img: string): string {
    return this.message().imageErrors?.[img] ?? '';
  }
  // A text message's author is stored on the message itself: user — the persona
  // (msg.userId), assistant — the character (msg.characterId). Messages of old
  // authors keep their names and avatars even after the participants change.
  //
  // A picture card has NO author, and that is the point: it is not something a
  // person said. The words a person wrote about a picture are their own message
  // right before it; the card says what is on the picture and, in its row, who
  // stands in it — so naming a speaker over it would only invite the model to
  // answer the picture as if it were a line of dialogue.
  senderName(): string {
    if (this.isCard()) return 'A picture';
    if (this.message().role === 'user') {
      return this.chatStore.userOf(this.message().userId)?.name || 'You';
    }
    return this.chatStore.characterNameOf(this.message().characterId);
  }
  avatarUrl(): string {
    // The neutral sign of a picture card, not somebody's face.
    if (this.isCard()) return '';
    if (this.message().role === 'user') {
      const a = this.chatStore.userOf(this.message().userId)?.avatar;
      return a ? this.api.mediaUrl(a) : '';
    }
    const id = this.message().characterId ?? this.chatStore.character()?.id;
    const a = this.chatStore.characterOf(id)?.avatar;
    return a ? this.api.mediaUrl(a) : '';
  }
  letter(): string {
    if (this.isCard()) return '🖼';
    return avatarLetter(this.senderName());
  }
  // The in-place "Regenerating…" state: only for the last assistant message
  // while a regeneration is running (the old reply stays visible, dimmed,
  // with a brightness wave sweeping across the bubble's border from left to
  // right instead of a separate "typing…" row below).
  isRegenerating(): boolean {
    return this.isLast() && this.message().role === 'assistant' && this.chatStore.regenerating();
  }

  // The lines and the author descriptions /* ... */ separately — for highlighting.
  splitNarration(text: string) {
    return splitNarrationParts(text);
  }
}
