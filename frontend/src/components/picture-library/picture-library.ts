import { Component, EffectRef, OnDestroy, computed, inject, effect, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Picture } from '../../services/api';
import { ChatStore } from '../../services/chat-store';
import { PictureLibraryStore } from '../../services/picture-library-store';
import { UiStore } from '../../services/ui-store';

// The same references in the same order — the order is what the prompt counts
// ("the first reference image, the second…"), so it is part of the comparison.
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// The picture browser: the whole data folder of pictures in one list, each with
// the row of the images table that describes it, and the editor of one of them —
// its description, the prompt it was drawn from and the pictures that prompt
// names, plus its ID.
//
// The ID of a picture is its path relative to the data folder, so the ID field is
// not a label: saving it moves the file on disk and takes the chat cards and the
// stored reference lists with it. That is why the field is a separate action from
// Save, and why a name the server refuses (taken, outside the picture folders)
// comes back as a visible error instead of a silent no-op.
//
// Editing here is not a second copy of a card's data: a card of any chat reads
// its caption and prompt from the same row, so a description written for a
// character's photo is what a chat shows for that photo.
@Component({
  selector: 'app-picture-library',
  imports: [FormsModule],
  template: `
    <div class="library" data-testid="picture-library">
      <div class="lib-side">
        <div class="lib-tools">
          <input
            class="lib-filter"
            type="search"
            placeholder="Filter by id or description (words match all)"
            data-testid="picture-filter"
            [value]="filter()"
            (input)="setFilter($event)"
          />
          <select
            class="lib-sort"
            data-testid="picture-sort"
            [value]="sortBy()"
            (change)="setSortBy($event)"
          >
            <option value="newest">Newest first</option>
            <option value="id">By ID</option>
          </select>
        </div>
        <div class="lib-list">
          @for (p of filtered(); track p.id) {
            <button
              class="lib-row"
              [class.on]="p.id === store.selectedId()"
              [class.gone]="!p.exists"
              [class.blocked]="blockedRow(p)"
              data-testid="picture-row"
              [title]="rowTitle(p)"
              (click)="selectPicture(p.id)"
            >
              @if (p.exists) {
                <img class="lib-thumb" [src]="media(p.id)" alt="" loading="lazy" />
              } @else {
                <span class="lib-thumb lib-thumb-gone" title="The file is gone">✕</span>
              }
              <span class="lib-meta">
                <span class="lib-name">{{ baseName(p.id) }}</span>
                <span class="lib-desc">{{ p.description || 'no description' }}</span>
                @if (p.referencedBy) {
                  <span
                    class="lib-refs"
                    [title]="'Used as a reference by ' + p.referencedBy + ' other picture(s)'"
                    >{{ p.referencedBy }} ref{{ p.referencedBy === 1 ? '' : 's' }}</span
                  >
                }
                @if (copiesFor(p)) {
                  <span class="lib-same" [title]="copiesTitle(p)">{{ copyLabel(copiesFor(p)) }}</span>
                }
                <span class="lib-id">{{ p.id }}</span>
              </span>
            </button>
          } @empty {
            <div class="lib-empty" data-testid="picture-empty">
              @if (store.loading()) {
                Loading the pictures…
              } @else {
                No pictures here yet — a drawn or attached picture appears in this list.
              }
            </div>
          }
        </div>
        <div class="lib-count">{{ store.pictures().length }} picture(s)</div>
      </div>

      @if (store.selected(); as p) {
        <div class="lib-edit">
          @if (p.exists) {
            <img class="lib-preview" data-testid="picture-preview" [src]="media(p.id)" alt="" />
          } @else {
            <div class="lib-preview lib-preview-gone">This file is no longer in the data folder.</div>
          }

          <label class="field col">
            <span>Description</span>
            <textarea
              class="grow"
              rows="2"
              placeholder="What is on the picture — the caption a chat shows under it"
              data-testid="picture-description"
              [value]="description()"
              (input)="setDescription($event)"
            ></textarea>
          </label>
          <!-- The same "Describe the picture" the card editor has: the chat's
               vision model looks at this picture and writes the caption. It needs
               an open chat — that is where the vision model comes from. -->
          <div class="row-actions">
            <button
              class="btn"
              data-testid="picture-describe"
              [disabled]="busy() !== null || !canDescribe()"
              [title]="
                canDescribe()
                  ? 'Let the model say what is on this picture'
                  : 'Open a chat first — its vision model describes the picture'
              "
              (click)="describe()"
            >
              {{ busy() === 'describe' ? 'Looking…' : 'Describe the picture' }}
            </button>
          </div>

          <!-- The prompt and the references it names are the picture's way to be
               redrawn — and for a picture the app drew AUTOMATICALLY (the 📷 turn
               picture) both are the planner's, not the user's: the card's own ✎
               is where they are edited. A draw the user asked for (🎨) keeps its
               prompt here, because that text is theirs. -->
          @if (showsPrompt(p)) {
            <label class="field col">
              <span>Prompt</span>
              <textarea
                class="grow"
                rows="2"
                placeholder="English. Empty — the picture has nothing to be redrawn from."
                data-testid="picture-prompt"
                [value]="prompt()"
                (input)="setPrompt($event)"
              ></textarea>
            </label>

            <div class="field col">
              <span>References the prompt names</span>
              <div class="refs">
                @for (ref of refs(); track $index) {
                  <span class="ref" [title]="ref">
                    <img class="ref-thumb" [src]="media(ref)" alt="" loading="lazy" />
                    <span class="ref-name">{{ baseName(ref) }}</span>
                    <button
                      class="ref-x"
                      data-testid="picture-ref-remove"
                      title="Remove this reference"
                      (click)="removeRef($index)">✕</button>
                  </span>
                } @empty {
                  <span class="refs-none">None — this prompt draws from nothing.</span>
                }
              </div>
              <select class="ref-add" data-testid="picture-ref-add" (change)="addRef($event)">
                <option value="" [selected]="true">Add a reference picture…</option>
                @for (option of refOptions(); track option.id) {
                  <option [value]="option.id">{{ option.id }}</option>
                }
              </select>
            </div>
          }

          <div class="field col">
            <span>ID (the path of the file)</span>
            <div class="id-row">
              <input
                class="grow"
                type="text"
                spellcheck="false"
                data-testid="picture-id-input"
                [value]="idField()"
                (input)="setIdField($event)"
              />
              <button
                class="btn"
                data-testid="picture-rename"
                [disabled]="!idChanged()"
                (click)="rename()">Rename</button>
            </div>
          </div>
          <div class="dialog-hint">
            The ID is where the file lives, relative to the data folder. Renaming moves the file —
            the chat cards and the reference lists that name it follow the new path. It never
            overwrites a picture and never creates a folder, so the new name must be free and its
            folder must already exist.
            <div class="lib-usedby" data-testid="picture-used-by">
              Used as a reference by {{ usedBy() }} other picture(s).
            </div>
            @if (!p.exists) {
              <div class="lib-orphan">
                This file is gone: what is left is the record of the picture. Renaming moves the
                record — point it at a file that is already there and the record attaches to it,
                which is how a description comes back to a picture renamed outside the app.
                “Forget record” drops it for good.
              </div>
            }
          </div>

          <div class="dialog-actions">
            @if (dirty()) {
              <!-- What the blocked rows (and the refused ✕ of the header) are
                   about: the edit that is not on the server yet, and the two
                   buttons that settle it. A click that is refused flashes the
                   long wording of the thing it wanted to do. -->
              <span class="lib-dirty" [class.warn]="blocked() || store.closeBlocked()" data-testid="picture-dirty">
                {{ dirtyHint() }}
              </span>
            }
            @if (!p.exists) {
              <!-- Dropping a record is the one irreversible action of this
                   dialog: the first click arms the button (it turns red), a
                   second click within ~2 s forgets. The confirm lives in the
                   button, not a dialog — the same two-click rule the message
                   delete buttons follow. -->
              <button
                class="btn danger"
                data-testid="picture-forget"
                [class.armed]="forgetArmed()"
                title="Drop this record for good — the file is already gone (click again to confirm)"
                (click)="forget()"
              >
                {{ forgetArmed() ? 'Click again to forget' : 'Forget record' }}
              </button>
            }
            <span class="spacer"></span>
            <button class="btn" data-testid="picture-reset" (click)="reset()">Discard</button>
            <button class="btn primary" data-testid="picture-save" (click)="save()">Save</button>
          </div>
        </div>
      } @else {
        <div class="lib-none">Pick a picture on the left to see what is known about it.</div>
      }
    </div>
  `,
  styleUrl: './picture-library.scss',
})
export class PictureLibraryComponent implements OnDestroy {
  readonly store = inject(PictureLibraryStore);
  private readonly api = inject(ApiService);
  private readonly chatStore = inject(ChatStore);
  private readonly ui = inject(UiStore);

  readonly filter = signal('');
  // The order of the list: the server sends it newest file first (an orphan row
  // last); "By ID" sorts the whole list by the path, which is what the id column
  // and the filter speak — finding "that one boat picture of the harbour chat"
  // by reading is an alphabetical job.
  readonly sortBy = signal<'newest' | 'id'>('newest');
  readonly description = signal('');
  readonly prompt = signal('');
  readonly refs = signal<string[]>([]);
  readonly idField = signal('');
  // Which LLM helper is running — the describe button says what it is doing and
  // refuses a second click meanwhile.
  readonly busy = signal<'describe' | null>(null);
  // What the fields were filled from — or, after a save, what the server now
  // holds — so "Discard" can put them back without asking the server again. A
  // signal: the form's "is this an edit nobody saved?" question is a comparison
  // against it.
  private readonly loaded = signal<Picture | null>(null);

  // Has the user touched the form since it was filled? An id is a path and the
  // fields are the picture's own row, so switching to another picture throws
  // them away — which is what this answers before the switch happens.
  readonly dirty = computed<boolean>(() => {
    const row = this.loaded();
    if (!row) return false;
    return (
      this.description() !== (row.description ?? '') ||
      this.prompt() !== (row.prompt ?? '') ||
      !sameList(this.refs(), row.refs ?? []) ||
      this.idField().trim() !== row.id
    );
  });

  // A click on a row that was refused (the form holds an edit): the list is
  // not a way out of an unsaved edit, and the hint over the actions says so
  // instead of the click landing on nothing.
  readonly blocked = signal(false);
  private blockedTimer: ReturnType<typeof setTimeout> | null = null;

  // The form follows the SELECTION, not the row's object: a Save writes the row
  // back and the store replaces its object, and refilling the fields then would
  // wipe what the user is typing at this very moment (their own saved text is
  // already in them). Only picking another picture — or the rename that moves
  // the selection to the new id — fills the form again, and only while the form
  // holds nothing unsaved: an edit that is not on the server yet is not the
  // selection's to drop.
  private followSelection: EffectRef = effect(() => {
    const id = this.store.selectedId();
    // tracked: the catalog is read again after a rename, and the renamed row
    // arrives one request later than the new selection
    const row = this.store.selected();
    untracked(() => {
      if (id !== '' && row === null) return;
      if (this.dirty()) return;
      if (this.loaded() === row) return;
      this.fill(row);
    });
  });

  // The ✕ that closes the browser belongs to the shell and the form belongs to
  // this component, so the store is told whether there is an edit to lose:
  // closing goes through the same guard as opening another picture.
  private readonly reportDirty: EffectRef = effect(() => {
    this.store.dirty.set(this.dirty());
  });

  private fill(picture: Picture | null): void {
    this.loaded.set(picture);
    this.disarmForget();
    this.blocked.set(false);
    this.description.set(picture?.description ?? '');
    this.prompt.set(picture?.prompt ?? '');
    this.refs.set(picture?.refs ?? []);
    this.idField.set(picture?.id ?? '');
  }

  // Picking a picture is what the fields are filled from, so an edit that was
  // neither saved nor discarded is in the way: the click is refused, the row
  // says why and the hint over the actions says what settles it. Save or
  // Discard, and the list moves again.
  selectPicture(id: string): void {
    if (id === this.store.selectedId()) return;
    if (this.dirty()) {
      this.flashBlocked();
      return;
    }
    this.store.select(id);
  }

  // The other rows read as closed while the form holds an edit — a dimmed row
  // with a "not-allowed" cursor is a row that says "settle this one first"
  // before the click, not after it.
  blockedRow(p: Picture): boolean {
    return this.dirty() && p.id !== this.store.selectedId();
  }

  rowTitle(p: Picture): string {
    if (!this.blockedRow(p)) return p.id;
    return p.id + '\nUnsaved changes — Save or Discard them first';
  }

  // What the line over the actions says: the plain state, or — after a click
  // that was refused — what that click needed first (another picture, or the
  // browser's own ✕).
  dirtyHint(): string {
    if (this.store.closeBlocked()) return 'Save or Discard this edit before closing the pictures';
    if (this.blocked()) return 'Save or Discard this edit before opening another picture';
    return 'Unsaved changes';
  }

  private flashBlocked(): void {
    this.blocked.set(true);
    if (this.blockedTimer) clearTimeout(this.blockedTimer);
    this.blockedTimer = setTimeout(() => {
      this.blocked.set(false);
      this.blockedTimer = null;
    }, 2500);
  }

  // Every space-separated word must be found — in the id or in the description —
  // for the picture to stay: "alice sunset" keeps the pictures of alice that
  // say sunset, not the ones matching either word. The id is matched too, so a
  // word of the path ("chats", a chat id, a file-name part) filters the list.
  filtered(): Picture[] {
    const words = this.filter().trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    let all = this.store.pictures();
    if (words.length > 0) {
      all = all.filter((p) => {
        const id = p.id.toLowerCase();
        const description = (p.description ?? '').toLowerCase();
        return words.every((word) => id.includes(word) || description.includes(word));
      });
    }
    if (this.sortBy() === 'id') {
      return [...all].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    }
    return all;
  }

  // How many pictures name the selected one in their reference set — the server
  // counts them on every read, the browser only says the number.
  usedBy(): number {
    return this.store.selected()?.referencedBy ?? 0;
  }

  // How many OTHER files hold exactly these bytes. Two identical files are two
  // pictures (a cloned chat owns its copy, and a name is a path), so the list
  // says the copies exist instead of hiding them.
  copiesFor(p: Picture): number {
    return p.sameAs?.length ?? 0;
  }

  copiesTitle(p: Picture): string {
    return 'The same file also lives at: ' + (p.sameAs ?? []).join(', ');
  }

  copyLabel(count: number): string {
    return count === 1 ? '1 copy' : count + ' copies';
  }

  // The catalog minus the picture being edited (a picture is never its own
  // reference) and minus the rows whose file is gone (a job cannot read them).
  refOptions(): Picture[] {
    const current = this.store.selectedId();
    const taken = new Set(this.refs());
    return this.store
      .pictures()
      .filter((p) => p.exists && p.id !== current && !taken.has(p.id));
  }

  media(id: string): string {
    return this.api.mediaUrl(id);
  }

  baseName(id: string): string {
    return id.slice(id.lastIndexOf('/') + 1);
  }

  setFilter(e: Event): void {
    this.filter.set((e.target as HTMLInputElement).value);
  }
  setSortBy(e: Event): void {
    this.sortBy.set((e.target as HTMLSelectElement).value === 'id' ? 'id' : 'newest');
  }
  setDescription(e: Event): void {
    this.description.set((e.target as HTMLTextAreaElement).value);
  }
  setPrompt(e: Event): void {
    this.prompt.set((e.target as HTMLTextAreaElement).value);
  }
  setIdField(e: Event): void {
    this.idField.set((e.target as HTMLInputElement).value);
  }

  addRef(e: Event): void {
    const select = e.target as HTMLSelectElement;
    const id = select.value;
    if (!id) return;
    this.refs.update((list) => [...list, id]);
    select.value = '';
  }

  removeRef(index: number): void {
    this.refs.update((list) => list.filter((_, i) => i !== index));
  }

  idChanged(): boolean {
    const current = this.store.selectedId();
    return !!current && this.idField().trim() !== '' && this.idField().trim() !== current;
  }

  // Puts the fields back to what the row said.
  reset(): void {
    this.fill(this.loaded());
  }

  // The describe helper needs a chat: the vision model is the chat's (its pick,
  // else its own model, else the first one that can see). The library is opened
  // from inside the app, so there is normally a chat — a fresh install with no
  // chat at all is the one case the button stays disabled for.
  canDescribe(): boolean {
    return !!this.chatStore.chat();
  }

  // "Describe the picture": the chat's vision model looks at the selected
  // picture and writes the description — the same call the card editor makes,
  // just for a picture that belongs to no message (a character's photo, a file
  // dropped into a folder). The answer is the form's text; Save writes it.
  describe(): void {
    const chat = this.chatStore.chat();
    const id = this.store.selectedId();
    if (!chat || !id) return;
    this.busy.set('describe');
    this.api
      .describePicture(chat.id, { image: id })
      .then((res) => {
        // the user may have picked another picture while the model was looking
        if (this.store.selectedId() === id) this.description.set(res.description);
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.busy.set(null));
  }

  // The prompt (and the references it names) are the picture's way to be
  // redrawn. A picture the app drew AUTOMATICALLY got both from the planner, so
  // the browser shows only what is the user's to write there — the caption; the
  // card's own ✎ edits the plan. A draw the user asked for keeps its prompt,
  // because that text is theirs.
  showsPrompt(p: Picture): boolean {
    return p.source !== 'auto';
  }

  save(): void {
    const id = this.store.selectedId();
    const patch = { description: this.description(), prompt: this.prompt(), refs: this.refs() };
    void this.store.savePicture(patch).then((row) => {
      // The fields stay exactly as typed (a save answered late must not wipe
      // what was typed meanwhile), but what the server now holds becomes the
      // baseline: the form reads as clean and Discard returns to the saved
      // words.
      if (row && this.store.selectedId() === row.id) this.loaded.set(row);
    });
  }

  // Renaming moves the file, not the words: the baseline follows the new id,
  // the fields keep what is typed (an unsaved caption stays unsaved over the
  // rename) and Discard afterwards returns to the text of the moved picture.
  rename(): void {
    void this.store.renamePicture(this.idField().trim()).then((row) => {
      if (row) this.loaded.set(row);
    });
  }

  // The two-click confirm of the one irreversible action here: the first click
  // arms the button (it goes red and says so), a second click within ~2 s
  // forgets the record, otherwise it disarms. Local to this dialog, and reset
  // whenever the selection changes — a confirm for a picture the user is no
  // longer looking at is a trap.
  readonly forgetArmed = signal(false);
  private forgetTimer: ReturnType<typeof setTimeout> | null = null;

  forget(): void {
    if (!this.forgetArmed()) {
      this.forgetArmed.set(true);
      if (this.forgetTimer) clearTimeout(this.forgetTimer);
      this.forgetTimer = setTimeout(() => {
        this.forgetArmed.set(false);
        this.forgetTimer = null;
      }, 2000);
      return;
    }
    this.disarmForget();
    this.store.forgetPicture();
  }

  private disarmForget(): void {
    if (this.forgetTimer) {
      clearTimeout(this.forgetTimer);
      this.forgetTimer = null;
    }
    this.forgetArmed.set(false);
  }

  ngOnDestroy(): void {
    if (this.forgetTimer) {
      clearTimeout(this.forgetTimer);
      this.forgetTimer = null;
    }
    if (this.blockedTimer) {
      clearTimeout(this.blockedTimer);
      this.blockedTimer = null;
    }
    // The form goes with the dialog: a stale "there is an edit" would refuse the
    // next ✕ of a dialog that opens empty.
    this.store.dirty.set(false);
  }
}
