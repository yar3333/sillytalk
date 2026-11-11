import { Component, inject, signal } from '@angular/core';
import { ChatStore } from '../../services/chat-store';
import { ImageStore } from '../../services/image-store';

// The 🎨 dialog: the user describes the picture they want and presses OK. The
// description is asked for in THEIR language — the sentence they write here is
// what the picture's card will say it shows (the row's description), so it is
// not a prompt and is not translated. The app turns it into an English drawing
// prompt and picks the reference pictures afterwards, by itself, in the
// background; the literal prompt is only ever written by hand in the picture
// editor of the card (✎).
//
// Naming the people of the conversation is encouraged rather than cleaned away:
// a generator has never heard the names, so the planner is the piece that can
// match "Alice" to the picture of her face and put that picture in front of the
// generator. Hence the participant names in the hint.
//
// OK does not wait for the picture: the server answers with the pending card,
// the dialog closes and the card turns into the drawing while the user goes on
// writing.
@Component({
  selector: 'app-picture-request-dialog',
  template: `
    <div class="dialog-body" data-testid="picture-ask-dialog">
      <label class="field col">
        <span>What the picture should show</span>
        <textarea
          #ta
          class="grow"
          rows="5"
          data-testid="picture-ask-text"
          placeholder="In your own language: who is in it, what they do, where, what the mood is…"
          [value]="text()"
          (input)="setText($event)"
          (keydown.control.enter)="ask()"
          (keydown.meta.enter)="ask()"
        ></textarea>
      </label>
      <div class="dialog-hint">
        Name the ones who should be on it ({{ participantNames() }}) — the app draws a person from
        their own pictures, so a name here is what keeps a face the same from one picture to the
        next. Write the sentence as the caption you would give the picture: it is kept as it is,
        while the drawing prompt and the reference pictures are built from it in English, in the
        background.
      </div>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button class="btn" data-testid="picture-ask-cancel" (click)="cancel()">Cancel</button>
        <button
          class="btn primary"
          data-testid="picture-ask-ok"
          [disabled]="imageStore.generating()"
          (click)="ask()"
        >
          {{ imageStore.generating() ? '…' : 'Ask for the picture' }}
        </button>
      </div>
    </div>
  `,
  styleUrl: './picture-request-dialog.scss',
})
export class PictureRequestDialog {
  private readonly chatStore = inject(ChatStore);
  readonly imageStore = inject(ImageStore);

  // Local to the dialog: the component is created per opening (the shell mounts
  // it while the dialog is open), so an abandoned description is simply gone.
  readonly text = signal('');

  setText(e: Event): void {
    this.text.set((e.target as HTMLTextAreaElement).value);
  }

  // The names the hint offers as the people the user may name — the chat's
  // participants and its persona, which are exactly the ones the planner has
  // looks and reference pictures for.
  participantNames(): string {
    const user = this.chatStore.chatUser();
    const names = [
      ...this.chatStore.chatCharacters().map((c) => c.name),
      ...(user?.name ? [user.name] : []),
    ];
    return names.length > 0 ? names.join(', ') : 'the ones in the dialogue';
  }

  ask(): void {
    // The field is the dialog's own, so the store validates only emptiness; the
    // dialog closes itself when the card was accepted (the store clears the
    // signal), and stays open with the banner's reason when it was not.
    if (this.imageStore.requestPicture(this.text())) this.text.set('');
  }

  cancel(): void {
    this.imageStore.closePictureRequest();
  }
}
