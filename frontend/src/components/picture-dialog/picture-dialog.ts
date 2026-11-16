import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ApiService, ChatMessage, Picture } from '../../services/api';
import { ChatStore } from '../../services/chat-store';
import { ImageStore } from '../../services/image-store';
import { UiStore } from '../../services/ui-store';

// The picture editor — one dialog for everything ONE picture says about itself.
// A line may show several pictures, so the dialog is opened for a picture id
// (ImageStore.pictureEdit) and edits that picture's row, not the line. A picture
// is one of two things:
//   "generated" — a picture drawn by the app: the prompt it is redrawn from
//                 (with two LLM helpers: turn the description into a prompt plus
//                 the reference set, or translate + tune the typed text);
//   "from a file" — a picture of the data folder (picked by its id from the
//                 catalog) or a file from disk; it has no prompt.
// Both kinds carry a description (what is on the picture), written by the user or
// by one of two model calls: from the conversation, or from the picture itself.
// The two fields are the two stages a picture is planned in and they read in that
// order — the description first, because it is the idea the user corrects, and the
// prompt below it, because that is what the generator is handed.
//
// Under the prompt sits the reference set that prompt names, and it is edited
// here like the two fields are: the model picks it, but a pick is not always the
// set the user wants — a face that came out wrong is taken out, another picture
// (one of the data folder, or a file of the disk the app files first) goes in.
// An edit of the set is an edit of what the prompt says, so it saves with it.
//
// The dialog only EDITS the picture: saving never generates anything — redrawing
// is the ↻ button of the picture, as before. The target comes from
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

        <!-- The description comes first: it is what the picture says about itself
             (the caption under it, the sentence a model without vision is told
             about it) and the input of the prompt below — the generator never
             reads this text, it reads what this text is turned into. -->
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
            data-testid="picture-description-from-chat"
            [disabled]="busy() !== null"
            (click)="descriptionFromChat()"
            title="Let the model say what the next picture of this conversation should show"
          >
            {{ busy() === 'describeChat' ? 'Thinking…' : 'From the chat' }}
          </button>
          <button
            class="btn"
            data-testid="picture-describe"
            [disabled]="busy() !== null"
            (click)="describe()"
            title="Let the model look at this picture and say what is on it"
          >
            {{ busy() === 'describeImage' ? 'Looking…' : 'Describe the picture' }}
          </button>
        </div>
        <div class="dialog-hint">
          "From the chat" writes the idea of the picture from the conversation; "Describe the
          picture" looks at the picture itself. Both only fill this field — Save is still the write.
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
              data-testid="picture-prompt-from-description"
              [disabled]="busy() !== null || !description().trim()"
              (click)="promptFromDescription()"
              title="Turn the description into the generator's prompt and the pictures it draws the faces and places from"
            >
              {{ busy() === 'prompt' ? 'Thinking…' : 'Prompt and references' }}
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
          <!-- The reference set is the prompt's own: the prompt counts these
               pictures ("the first reference image shows …"), so editing them is
               an edit of what the prompt means and it saves together with it.
               Removing one drops it from THIS picture's set only — the file and
               every other picture that names it are untouched. A picture of the
               data folder is picked from the same catalog the "from a file" kind
               shows; a file from disk is filed into this conversation's folder
               first (the app reuses a picture it already holds byte for byte)
               and only then joins the set, because a prompt can only name a
               picture that really has an id. -->
          <div class="field col">
            <span>Drawn from</span>
            <div class="refs">
              @for (id of refs(); track $index) {
                <span class="ref" [title]="id">
                  <img class="ref-thumb" [src]="thumb(id)" [alt]="id" loading="lazy" />
                  <span class="ref-name">{{ baseName(id) }}</span>
                  <button
                    class="ref-x"
                    data-testid="picture-ref-remove"
                    title="Take this picture out of the reference set (the file itself stays)"
                    (click)="removeRef($index)"
                  >
                    ✕
                  </button>
                </span>
              } @empty {
                <span class="refs-none">Nothing — this prompt draws from no picture.</span>
              }
            </div>
            <div class="ref-tools">
              <select class="ref-add" data-testid="picture-ref-add" (change)="addRef($event)">
                <option value="" [selected]="true">Add a picture of the data folder…</option>
                @for (option of refOptions(); track option.id) {
                  <option [value]="option.id">{{ option.id }}</option>
                }
              </select>
              <label class="btn file-pick" title="A picture from your disk, added to this conversation">
                {{ refBusy() ? 'Adding…' : 'From disk…' }}
                <input
                  type="file"
                  hidden
                  accept="image/*"
                  data-testid="picture-ref-file"
                  (change)="addRefFromFile($event)"
                />
              </label>
            </div>
          </div>
          <div class="dialog-hint">
            The prompt names these pictures in this order (the first reference image, the second…),
            so they are saved with it — a redraw keeps the same faces. Taking one out changes only
            this picture; a picture added from disk is saved into this chat's folder and reused
            when you already have exactly that one.
          </div>
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
  private ui = inject(UiStore);

  // The card being edited (null — it disappeared while the dialog was open).
  readonly message = signal<ChatMessage | null>(null);

  readonly kind = signal<'generated' | 'file'>('generated');
  readonly prompt = signal('');
  readonly description = signal('');
  // The pictures the prompt names in order ("the first reference image shows
  // …"). They belong to the prompt: saving one without the rest would redraw
  // something else, so "Prompt and references" fills them, the user edits them
  // here, and Save writes them back with the prompt.
  readonly refs = signal<string[]>([]);
  // What the card said when the dialog opened — Save compares against it, so a
  // dialog nobody touched does not rewrite this field of the card.
  private initialRefs: string[] = [];
  // The pictures of the data folder (the "from a file" pick and the reference
  // pick) and the id chosen there; a file picked from disk is kept as its data
  // URL until the save.
  readonly catalog = signal<Picture[]>([]);
  readonly catalogLoading = signal(true);
  readonly chosenId = signal('');
  readonly pickedData = signal('');
  readonly pickedName = signal('');
  // A reference file from disk is uploaded before it joins the set (it needs an
  // id of the data folder to be named by a prompt), so the button says so.
  readonly refBusy = signal(false);
  // Which LLM helper is running (the buttons say what they are doing) and the
  // save in flight.
  readonly busy = signal<'describeChat' | 'describeImage' | 'prompt' | 'tune' | null>(null);
  readonly saving = signal(false);

  // The options of the id pick: the catalog, with the card's own picture first
  // when it is not in it (a picture the walk did not reach, for instance).
  readonly idOptions = computed<string[]>(() => {
    const current = this.chosenId();
    const ids = this.catalog().map((p) => p.id);
    return current && !ids.includes(current) ? [current, ...ids] : ids;
  });

  // What may still be added to the reference set: the pictures whose file is
  // really there (a job cannot read an orphan row), never the card's own
  // picture, never one the set already names.
  readonly refOptions = computed<Picture[]>(() => {
    const taken = new Set(this.refs());
    const own = this.imageId();
    return this.catalog().filter((p) => p.exists && p.id !== own && !taken.has(p.id));
  });

  ngOnInit(): void {
    const target = this.imageStore.pictureEdit();
    const msg = this.chatStore.chat()?.messages.find((m) => m.id === target?.messageId) ?? null;
    this.message.set(msg);
    if (!msg || !target) return;
    // The dialog edits ONE picture of a line, and what it can say about it is
    // that picture's row of the images table — the line may show several, so
    // `pictures` keyed by id is the only place their facts are kept apart.
    const facts = msg.pictures?.[target.image];
    const generation = facts?.generation;
    const generated = generation?.prompt !== undefined || (generation?.source !== undefined && generation.source !== 'upload');
    this.kind.set(generated ? 'generated' : 'file');
    this.prompt.set(generation?.prompt ?? '');
    this.refs.set(generation?.refs ?? []);
    this.initialRefs = [...this.refs()];
    this.description.set(facts?.description ?? '');
    this.chosenId.set(target.image);
    this.readCatalog();
  }

  // The catalog of the data folder, for both picks (the picture a "from a file"
  // card points at, the pictures the reference set may name). Re-read after a
  // picture was filed from disk, so a reference the user just added is in the
  // list like any other picture of the folder.
  private readCatalog(): void {
    this.api
      .listPictures()
      .then((res) => this.catalog.set(res.pictures))
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

  baseName(id: string): string {
    return id.slice(id.lastIndexOf('/') + 1);
  }

  // The reference set, edited by hand. Taking a picture out of it says only that
  // THIS prompt no longer draws from it — the file stays, and so does every
  // other picture that names it.
  removeRef(index: number): void {
    this.refs.update((list) => list.filter((_, i) => i !== index));
  }

  addRef(e: Event): void {
    const select = e.target as HTMLSelectElement;
    const id = select.value;
    select.value = '';
    if (!id || this.refs().includes(id)) return;
    this.refs.update((list) => [...list, id]);
  }

  // A reference from disk. A prompt can only name a picture that has an id, so
  // the bytes are filed into this conversation's folder first (the server hands
  // back the id of an identical picture the app already owns rather than writing
  // a copy) and the id the answer carries joins the set. The picture is not
  // shown in any line — it is an ingredient, which is why it lives with the
  // conversation rather than with a person.
  addRefFromFile(e: Event): void {
    const chat = this.chatStore.chat();
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!chat || !file || this.refBusy()) return;
    this.refBusy.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      this.api
        .importPicture(chat.id, String(reader.result), file.name)
        .then((res) => {
          if (!this.refs().includes(res.id)) this.refs.update((list) => [...list, res.id]);
          this.readCatalog();
        })
        .catch((err) => this.ui.error.set(String((err as Error).message)))
        .finally(() => this.refBusy.set(false));
    };
    reader.onerror = () => {
      this.refBusy.set(false);
      this.ui.error.set('Could not read the file');
    };
    reader.readAsDataURL(file);
  }

  // "From the chat" (the description field): the model reads the conversation and
  // says what the next picture should show — the idea, in the language the
  // picture descriptions are written in, not a drawing prompt. The card being
  // edited is left out of what the model reads; what it writes lands here and
  // waits for the user, who may rewrite it before asking for the prompt.
  descriptionFromChat(): void {
    const chat = this.chatStore.chat();
    const target = this.imageStore.pictureEdit();
    if (!chat || !target) return;
    this.busy.set('describeChat');
    this.api
      .describePictureFromChat(chat.id, target.messageId)
      .then((res) => this.description.set(res.description))
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.busy.set(null));
  }

  // "Prompt and references": the description becomes the generator's prompt AND
  // the pictures it is drawn from — the two are one thing, because the prompt
  // says what each of those images is for, so saving one without the other would
  // redraw something else. The description may name the people of the story; the
  // answer never does, it binds them to their own pictures instead.
  promptFromDescription(): void {
    const chat = this.chatStore.chat();
    const target = this.imageStore.pictureEdit();
    const text = this.description().trim();
    if (!chat || !target || !text) return;
    this.busy.set('prompt');
    this.api
      .composePromptFromDescription(chat.id, text, target.messageId)
      .then((res) => {
        this.prompt.set(res.prompt);
        this.refs.set(res.refs ?? []);
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
    this.busy.set('describeImage');
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
        // The references travel only when the dialog actually changed them — a
        // patch that repeats what the picture says would rewrite the row for
        // nothing (and an empty list IS an edit: it clears them).
        refs: sameList(this.refs(), this.initialRefs) ? undefined : this.refs(),
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
