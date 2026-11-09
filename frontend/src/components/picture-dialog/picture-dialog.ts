import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ApiService, ChatMessage } from '../../services/api';
import { ChatStore } from '../../services/chat-store';
import { ConfigStore } from '../../services/config-store';
import { ImageStore } from '../../services/image-store';
import { UiStore } from '../../services/ui-store';

// The picture editor — one dialog for everything a picture card says about
// itself. A card is one of two things:
//   "generated" — a picture drawn by the app: the prompt it is redrawn from
//                 (with two LLM helpers: plan it from the dialogue, or
//                 translate + tune the typed text for the generator);
//   "from a file" — a picture of the data folder (picked by its id from the
//                 catalog) or a file from disk; it has no prompt.
// Both kinds carry a description (what is on the picture), which the model can
// also write from the picture itself.
//
// The dialog only EDITS the card: saving never generates anything — redrawing
// is the ↻ button of the card, as before. The target card comes from
// ImageStore.pictureEdit (the row opens the dialog), so the dialog is a thin
// view over the stores.

// The same pictures in the same order — the order matters: the prompt names
// them "the first reference image, the second…".
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

@Component({
  selector: 'app-picture-dialog',
  template: `
    <div class="dialog-body" data-testid="picture-dialog">
      @if (message()) {
        <div class="preview">
          <img [src]="previewUrl()" alt="" />
        </div>
        @if (pickedName()) {
          <div class="dialog-hint">From disk: {{ pickedName() }}</div>
        }

        <div class="kinds">
          <label class="kind" [class.on]="kind() === 'generated'">
            <input
              type="radio"
              name="picture-kind"
              data-testid="picture-kind-generated"
              [checked]="kind() === 'generated'"
              (change)="setKind('generated')"
            />
            Generated
          </label>
          <label class="kind" [class.on]="kind() === 'file'">
            <input
              type="radio"
              name="picture-kind"
              data-testid="picture-kind-file"
              [checked]="kind() === 'file'"
              (change)="setKind('file')"
            />
            From a file
          </label>
        </div>

        @if (kind() === 'generated') {
          <label class="field col">
            <span>Prompt</span>
            <textarea
              rows="3"
              data-testid="picture-prompt"
              placeholder="What is drawn: the subject, the action, the setting, the style…"
              [value]="prompt()"
              (input)="setPrompt($event)"
            ></textarea>
          </label>
          <div class="row-actions">
            <button
              class="btn"
              data-testid="picture-prompt-from-chat"
              [disabled]="busy() !== null"
              (click)="promptFromChat()"
              title="Let the model write the prompt from the conversation"
            >
              {{ busy() === 'prompt' ? 'Thinking…' : 'From the chat' }}
            </button>
            <button
              class="btn"
              data-testid="picture-prompt-english"
              [disabled]="busy() !== null || !prompt().trim()"
              (click)="makeEnglish()"
              title="Translate to English and shape it for the image generator"
            >
              {{ busy() === 'tune' ? 'Rewriting…' : 'Make it English' }}
            </button>
          </div>
          <div class="dialog-hint">
            The picture is redrawn from this prompt by the ↻ button on the card, and again
            afterwards whenever the card is regenerated.
          </div>
          @if (refs().length) {
            <div class="refs">
              <span class="refs-label">Drawn from</span>
              @for (id of refs(); track id) {
                <img class="ref-thumb" [src]="thumb(id)" [alt]="id" [title]="id" />
              }
            </div>
            <div class="dialog-hint">
              The prompt names these pictures in this order (the first reference image, the second…),
              so they are saved with it — a redraw keeps the same faces.
            </div>
          }
        } @else {
          <label class="field">
            <span>Picture</span>
            <select class="grow" data-testid="picture-id" (change)="setChosen($event)">
              <option value="" [selected]="chosenId() === ''">— a picture of the data folder —</option>
              @for (id of idOptions(); track id) {
                <option [value]="id" [selected]="id === chosenId()">{{ id }}</option>
              }
            </select>
          </label>
          <div class="row-actions">
            <label class="btn file-pick" title="Pick a picture from your disk">
              Pick a file…
              <input type="file" hidden accept="image/*" data-testid="picture-file" (change)="onPickFile($event)" />
            </label>
            @if (pickedName()) {
              <button class="btn" (click)="clearPick()">Use the chosen picture</button>
            }
          </div>
          <div class="dialog-hint">
            {{ catalogLoading() ? 'Reading the pictures of the data folder…' : 'The relative path is the id the card will carry.' }}
            A file picked from disk is saved into this chat's folder — a copy of a picture you
            already have is reused, not duplicated.
          </div>
        }

        <label class="field col">
          <span>Description</span>
          <textarea
            rows="3"
            data-testid="picture-description"
            placeholder="What is on the picture (the caption under it)…"
            [value]="description()"
            (input)="setDescription($event)"
          ></textarea>
        </label>
        <div class="row-actions">
          <button
            class="btn"
            data-testid="picture-describe"
            [disabled]="busy() !== null"
            (click)="describe()"
            title="Let the model say what is on this picture"
          >
            {{ busy() === 'describe' ? 'Looking…' : 'Describe the picture' }}
          </button>
        </div>

        @if (people().length) {
          <div class="field col">
            <span>Who is on this picture</span>
            <div class="chips">
              @for (p of people(); track p.ref) {
                <button
                  type="button"
                  class="chip"
                  [class.on]="depicts().includes(p.ref)"
                  data-testid="picture-depicts"
                  (click)="toggleDepicts(p.ref)"
                >
                  {{ p.name }}
                </button>
              }
            </div>
          </div>
          <div class="dialog-hint">
            The generator is never told these names — the note is for the picture planner, so the next
            picture of this chat can put the same person in it.
          </div>
        }

        <div class="dialog-actions">
          <span class="spacer"></span>
          <button class="btn" data-testid="picture-cancel" (click)="cancel()">Cancel</button>
          <button class="btn primary" data-testid="picture-save" [disabled]="saving()" (click)="save()">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      } @else {
        <div class="dialog-hint">The message is gone.</div>
      }
    </div>
  `,
  styleUrl: './picture-dialog.scss',
})
export class PictureDialog implements OnInit {
  private api = inject(ApiService);
  private chatStore = inject(ChatStore);
  private imageStore = inject(ImageStore);
  private configStore = inject(ConfigStore);
  private ui = inject(UiStore);

  // The card being edited (null — it disappeared while the dialog was open).
  readonly message = signal<ChatMessage | null>(null);

  readonly kind = signal<'generated' | 'file'>('generated');
  readonly prompt = signal('');
  readonly description = signal('');
  // The pictures the prompt names in order ("the first reference image shows
  // …"). They belong to the prompt: saving one without the rest would redraw
  // something else, so "From the chat" fills them and Save writes them back.
  readonly refs = signal<string[]>([]);
  // Who is ON this picture, as the chat knows its people ("char:alice"). The
  // picture planner reads it to draw the same person again.
  readonly depicts = signal<string[]>([]);
  // What the card said when the dialog opened — Save compares against it, so a
  // dialog nobody touched does not rewrite these two fields of the card.
  private initialRefs: string[] = [];
  private initialDepicts: string[] = [];
  // The people of this chat: its characters and every persona that ever spoke
  // here — the chips under "Who is on this picture".
  readonly people = computed<{ ref: string; name: string }[]>(() => {
    const chat = this.chatStore.chat();
    if (!chat) return [];
    const out: { ref: string; name: string }[] = chat.characterIds.map((id) => ({
      ref: 'char:' + id,
      name: this.configStore.characters().find((c) => c.id === id)?.name ?? id,
    }));
    const personas = new Set<string>([chat.userId]);
    for (const m of chat.messages) if (m.userId) personas.add(m.userId);
    for (const id of personas) {
      if (!id) continue;
      out.push({ ref: 'user:' + id, name: this.configStore.users().find((u) => u.id === id)?.name ?? id });
    }
    return out;
  });
  // The pictures of the data folder (the "from a file" pick) and the id chosen
  // there; a file picked from disk is kept as its data URL until the save.
  readonly catalog = signal<string[]>([]);
  readonly catalogLoading = signal(true);
  readonly chosenId = signal('');
  readonly pickedData = signal('');
  readonly pickedName = signal('');
  // Which LLM helper is running (the buttons say what they are doing) and the
  // save in flight.
  readonly busy = signal<'prompt' | 'tune' | 'describe' | null>(null);
  readonly saving = signal(false);

  // The options of the id pick: the catalog, with the card's own picture first
  // when it is not in it (a picture the walk did not reach, for instance).
  readonly idOptions = computed<string[]>(() => {
    const current = this.chosenId();
    const ids = this.catalog();
    return current && !ids.includes(current) ? [current, ...ids] : ids;
  });

  ngOnInit(): void {
    const target = this.imageStore.pictureEdit();
    const msg = this.chatStore.chat()?.messages.find((m) => m.id === target?.messageId) ?? null;
    this.message.set(msg);
    if (!msg || !target) return;
    const generation = msg.generation;
    const generated = generation?.prompt !== undefined || (generation?.source !== undefined && generation.source !== 'upload');
    this.kind.set(generated ? 'generated' : 'file');
    this.prompt.set(generation?.prompt ?? '');
    this.refs.set(generation?.refs ?? []);
    this.depicts.set(msg.depicts ?? []);
    this.initialRefs = [...this.refs()];
    this.initialDepicts = [...this.depicts()];
    this.description.set(msg.text);
    this.chosenId.set(target.image);
    this.api
      .listPictures()
      .then((res) => this.catalog.set(res.pictures.map((p) => p.id)))
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.catalogLoading.set(false));
  }

  private imageId(): string {
    return this.imageStore.pictureEdit()?.image ?? '';
  }

  // What the preview shows: the card's picture, the id chosen from the catalog
  // or the file picked from disk — whichever the current kind would save.
  previewUrl(): string {
    if (this.kind() === 'file') {
      const picked = this.pickedData();
      if (picked) return picked;
      const chosen = this.chosenId();
      if (chosen) return this.api.mediaUrl(chosen);
    }
    return this.api.mediaUrl(this.imageId());
  }

  setKind(kind: 'generated' | 'file'): void {
    this.kind.set(kind);
  }
  setPrompt(e: Event): void {
    this.prompt.set((e.target as HTMLTextAreaElement).value);
  }
  setDescription(e: Event): void {
    this.description.set((e.target as HTMLTextAreaElement).value);
  }
  setChosen(e: Event): void {
    this.chosenId.set((e.target as HTMLSelectElement).value);
  }
  thumb(id: string): string {
    return this.api.mediaUrl(id);
  }
  toggleDepicts(ref: string): void {
    const cur = this.depicts();
    this.depicts.set(cur.includes(ref) ? cur.filter((x) => x !== ref) : [...cur, ref]);
  }

  // A file from disk: kept as a data URL (the preview and the describe button
  // work on it) and saved into the chat's folder on Save (the server reuses a
  // byte-identical picture already in the data folders instead of copying).
  onPickFile(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.pickedData.set(String(reader.result));
      this.pickedName.set(file.name);
    };
    reader.onerror = () => this.ui.error.set('Could not read the file');
    reader.readAsDataURL(file);
  }
  clearPick(): void {
    this.pickedData.set('');
    this.pickedName.set('');
  }

  // "From the chat": the model plans the prompt from the dialogue (the card
  // itself is left out of what it reads) and the pictures to draw it from —
  // the prompt names them in that order, so both fields are filled together.
  // A card with no description yet gets the one the plan suggests.
  promptFromChat(): void {
    const chat = this.chatStore.chat();
    const target = this.imageStore.pictureEdit();
    if (!chat || !target) return;
    this.busy.set('prompt');
    this.api
      .composePicturePrompt(chat.id, target.messageId)
      .then((res) => {
        this.prompt.set(res.prompt);
        this.refs.set(res.refs ?? []);
        if (!this.description().trim() && res.description) this.description.set(res.description);
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.busy.set(null));
  }

  // "Make it English": translate the typed prompt and shape it for the
  // generator.
  makeEnglish(): void {
    const chat = this.chatStore.chat();
    const text = this.prompt().trim();
    if (!chat || !text) return;
    this.busy.set('tune');
    this.api
      .tunePicturePrompt(chat.id, text)
      .then((res) => this.prompt.set(res.prompt))
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.busy.set(null));
  }

  // "Describe the picture": the chat's model looks at the picture the current
  // kind would save and writes what is on it.
  describe(): void {
    const chat = this.chatStore.chat();
    if (!chat) return;
    const data = this.kind() === 'file' ? this.pickedData() : '';
    const image = data ? '' : this.kind() === 'file' ? this.chosenId() : this.imageId();
    if (!data && !image) {
      this.ui.error.set('Choose a picture first');
      return;
    }
    this.busy.set('describe');
    this.api
      .describePicture(chat.id, data ? { data } : { image })
      .then((res) => this.description.set(res.description))
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.busy.set(null));
  }

  save(): void {
    const target = this.imageStore.pictureEdit();
    if (!target) return;
    this.saving.set(true);
    void this.imageStore
      .savePictureEdit(target.messageId, target.image, {
        kind: this.kind(),
        description: this.description(),
        prompt: this.prompt(),
        imageId: this.chosenId(),
        data: this.pickedData() || undefined,
        // The two cast fields travel only when the dialog actually changed them
        // — a patch that repeats what the card says would rewrite the row
        // for nothing (and an empty list of them IS an edit: it clears).
        refs: sameList(this.refs(), this.initialRefs) ? undefined : this.refs(),
        depicts: sameList(this.depicts(), this.initialDepicts) ? undefined : this.depicts(),
      })
      .then((ok) => {
        this.saving.set(false);
        if (ok) this.imageStore.closePictureEdit();
      });
  }

  cancel(): void {
    this.imageStore.closePictureEdit();
  }
}
