import { Component, ElementRef, ViewChild, effect, inject } from '@angular/core';
import { ApiService } from '../../services/api';
import { ChatStore } from '../../services/chat-store';
import { ImageStore } from '../../services/image-store';
import { UiStore } from '../../services/ui-store';

// The input panel: the error banner, the editing bar, the generation mode,
// the attached images and the "📎 / 🎨 / textarea / send" row.
// The chat state — ChatStore, the image-GENERATION state — ImageStore, the
// error banner — UiStore. This component orchestrates the "what to send"
// decision: edit -> ChatStore.saveEdit, gen mode -> ImageStore.draw,
// otherwise -> ChatStore.send (which is why the stores don't depend on each
// other). The input field text stays here: an effect substitutes it on
// editTargetId (editing from the history) and clears it on a successful send.
@Component({
  selector: 'app-input-panel',
  template: `
    <div class="input-panel">
      @if (ui.error()) {
        <div class="error-banner" data-testid="error-banner" role="alert">
          <span class="error-text">{{ ui.error() }}</span>
          <button class="icon-btn" (click)="ui.dismissError()" title="Hide">✕</button>
        </div>
      }
      @if (chatStore.editTargetId()) {
        <div class="edit-bar" data-testid="edit-bar">
          <span>Editing the message</span>
          <button
            class="icon-btn"
            (click)="chatStore.cancelEdit()"
            title="Cancel editing"
          >
            ✕
          </button>
        </div>
      }
      @if (imageStore.genMode()) {
        <div class="gen-bar">
          <span class="gen-label">References:</span>
          @for (r of imageStore.genRefs(); track r) {
            <span class="chip" [title]="r" (click)="imageStore.removeGenRef(r)">✕ {{ refLabel(r) }}</span>
          }
          @if (imageStore.genRefs().length === 0) {
            <span class="gen-hint"
              >click an image in the chat or a character photo — add a reference</span
            >
          }
          <span class="gen-photos">
            @for (ph of imageStore.characterPhotos(); track ph) {
              <img [src]="photoUrl(ph)" (click)="imageStore.addCharacterPhotoRef(ph)" />
            }
          </span>
        </div>
      }
      @if (chatStore.pendingImages().length) {
        <div class="pending">
          @for (p of chatStore.pendingImages(); track $index) {
            <span class="pending-thumb">
              <img [src]="pendingSrc(p)" alt="" />
              <button
                class="thumb-x"
                (click)="chatStore.removePending($index)"
                title="Remove the image"
              >
                ✕
              </button>
            </span>
          }
        </div>
      }
      <div class="input-row">
        <label class="icon-btn" data-testid="attach" title="Attach an image">
          📎
          <input type="file" hidden multiple accept="image/*" (change)="onFiles($event)" />
        </label>
        @if (imageStore.canGen()) {
          <button
            class="icon-btn"
            data-testid="gen-toggle"
            [class.active]="imageStore.genMode()"
            [title]="imageStore.genMode() ? 'Leave the generation mode' : 'Generate an image'"
            (click)="imageStore.toggleGen()"
          >
            🎨
          </button>
        }
        @if (imageStore.canGen() && chatStore.isUserTurn()) {
          <!-- The user's turn: the model looks over the dialogue, decides what
               picture fits it, and the generator draws it — all in the
               background, so typing and sending are not blocked. -->
          <button
            class="icon-btn"
            data-testid="auto-image"
            [disabled]="imageStore.requestingTurnImage()"
            title="Draw a picture for this turn (from the conversation)"
            (click)="imageStore.requestTurnImage()"
          >
            {{ imageStore.requestingTurnImage() ? '…' : '📷' }}
          </button>
        }
        <textarea
          #ta
          data-testid="input"
          rows="1"
          [placeholder]="imageStore.placeholder()"
          (input)="onInput($event)"
          (keydown.enter)="onEnter($event, ta)"
        ></textarea>
        <button
          class="send"
          data-testid="send"
          [class.cancel]="chatStore.sending() && !chatStore.editTargetId()"
          (click)="onSend(ta)"
        >
          {{ chatStore.editTargetId() ? '✓' : chatStore.sending() ? '✕' : imageStore.genMode() ? 'Draw' : '➤' }}
        </button>
      </div>
    </div>
  `,
  styleUrl: './input-panel.scss',
})
export class InputPanel {
  @ViewChild('ta') private taEl?: ElementRef<HTMLTextAreaElement>;
  private api = inject(ApiService);
  readonly chatStore = inject(ChatStore);
  readonly imageStore = inject(ImageStore);
  readonly ui = inject(UiStore);

  constructor() {
    // Editing from the history: chatStore sets editTargetId — we substitute
    // the message text into the field and focus it; the reset (null) — clear the field.
    // The text comes from editText (a dedicated signal), NOT from a live chat
    // lookup: a reply or an image-generation poll re-applies the chat, and that
    // must not re-run this effect and reset the field while the user types.
    effect(() => {
      // Read the signal BEFORE the ViewChild check: otherwise on the first effect
      // run (ViewChild not ready yet) we would return without reading any signal —
      // and the effect would subscribe to nothing and never run again.
      const id = this.chatStore.editTargetId();
      const text = this.chatStore.editText();
      const ta = this.taEl?.nativeElement;
      if (!ta) return;
      if (!id) {
        if (ta.value !== '') {
          ta.value = '';
          this.autosize(ta);
        }
        return;
      }
      if (ta.value !== text) {
        ta.value = text;
        this.autosize(ta);
        ta.focus();
      }
    });
  }

  // A character picture is an image id of the data folder, shown through the
  // one media route.
  photoUrl(id: string): string {
    return this.api.mediaUrl(id);
  }

  // A reference chip shows the file name, not the whole data-relative path —
  // the full id stays in the hover hint.
  refLabel(id: string): string {
    return id.slice(id.lastIndexOf('/') + 1);
  }

  // The preview source: a data URL (just attached) — as-is, an image id of an
  // existing picture — through the media API (otherwise the URL is broken and
  // the thumbnail is black).
  pendingSrc(p: string): string {
    if (p.startsWith('data:')) return p;
    return this.api.mediaUrl(p);
  }

  onInput(e: Event): void {
    this.autosize(e.target as HTMLTextAreaElement);
  }

  private autosize(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  onEnter(e: Event, ta: HTMLTextAreaElement): void {
    if ((e as KeyboardEvent).shiftKey) return;
    e.preventDefault();
    this.onSend(ta);
  }

  // The "what to send" decision: the editing mode (✓) saves the edit, the
  // generation mode (Draw) draws an image, otherwise it is a normal message.
  // Keeping it here (not in a store) is what lets the store graph stay acyclic.
  onSend(ta: HTMLTextAreaElement): void {
    // Editing a message always wins: the button is the save (✓) and saves the
    // edit, even while a reply is generating in the background (the backend
    // re-reads the chat before appending a reply, so both the edit and the
    // in-flight reply persist). Only outside the editing mode the button is
    // the generation cancel (✕).
    const text = ta.value;
    let ok: boolean;
    if (this.chatStore.editTargetId()) {
      ok = this.chatStore.saveEdit(text);
      if (ok) {
        ta.value = '';
        this.autosize(ta);
      }
      return;
    }
    // While a reply is generating the button is the cancel (✕) — clicking
    // it (or pressing Enter) aborts the generation instead of sending.
    if (this.chatStore.sending()) {
      // A typed message + Enter would silently cancel the generation; confirm
      // first so the user doesn't lose the in-flight reply by accident.
      if (text.trim() && !confirm('Cancel the generation in progress?')) return;
      this.chatStore.cancelGeneration();
      return;
    }
    if (this.imageStore.genMode()) {
      ok = this.imageStore.draw(text.trim());
      // A draw ignores the 📎 attachments — clear them on a successful send.
      if (ok) this.chatStore.clearPendingImages();
    } else {
      ok = this.chatStore.send(text);
    }
    if (ok) {
      ta.value = '';
      this.autosize(ta);
    }
  }

  async onFiles(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    const urls: string[] = [];
    for (const file of Array.from(files)) {
      urls.push(await this.readFile(file));
    }
    input.value = '';
    this.chatStore.onImagesAdded(urls);
  }

  private readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
}
