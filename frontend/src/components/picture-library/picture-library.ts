import { Component, EffectRef, inject, effect, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Picture } from '../../services/api';
import { PictureLibraryStore } from '../../services/picture-library-store';

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
              data-testid="picture-row"
              [title]="p.id"
              (click)="store.select(p.id)"
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
              rows="3"
              placeholder="What is on the picture — the caption a chat shows under it"
              data-testid="picture-description"
              [value]="description()"
              (input)="setDescription($event)"
            ></textarea>
          </label>

          <label class="field col">
            <span>Prompt</span>
            <textarea
              class="grow"
              rows="4"
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
            the chat cards and the reference lists that name it follow the new path. The folders
            pictures live in (a chat's files/, a character's photos/, a persona's folder) stay the
            same; only the name changes.
            <div class="lib-usedby" data-testid="picture-used-by">
              Used as a reference by {{ usedBy() }} other picture(s).
            </div>
          </div>

          <div class="dialog-actions">
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
export class PictureLibraryComponent {
  readonly store = inject(PictureLibraryStore);
  private readonly api = inject(ApiService);

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
  // What the fields were filled from, so "Discard" can put them back without
  // asking the server again.
  private loaded: Picture | null = null;

  // The form follows the SELECTION, not the row's object: a Save writes the row
  // back and the store replaces its object, and refilling the fields then would
  // wipe what the user is typing at this very moment (their own saved text is
  // already in them). Only picking another picture — or the rename that moves
  // the selection to the new id — fills the form again.
  private followSelection: EffectRef = effect(() => {
    this.store.selectedId();
    this.fill(untracked(() => this.store.selected()));
  });

  private fill(picture: Picture | null): void {
    this.loaded = picture;
    this.description.set(picture?.description ?? '');
    this.prompt.set(picture?.prompt ?? '');
    this.refs.set(picture?.refs ?? []);
    this.idField.set(picture?.id ?? '');
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
    this.fill(this.loaded);
  }

  save(): void {
    this.store.savePicture({
      description: this.description(),
      prompt: this.prompt(),
      refs: this.refs(),
    });
  }

  rename(): void {
    this.store.renamePicture(this.idField().trim());
  }
}
