import { Component, OnInit, inject, signal } from '@angular/core';
import { ApiService } from '../../services/api';
import { ChatStore } from '../../services/chat-store';
import { ConfigStore } from '../../services/config-store';
import { isEntityId, suggestEntityId, ENTITY_ID_RULE } from '../../services/helpers';
import { UiStore } from '../../services/ui-store';

// The character edit dialog: ID, name, description, the avatar. The item is
// taken from ConfigStore.entityDialog (a null id — creating a new one);
// save/delete/clone — the store actions (the dialog itself holds only the
// field values). Delete and Clone exist in the edit mode only.
//
// The ID is not a label but the name of the character's folder, so it is the one
// field with a rule of its own: typed by the user when the character is created,
// and changed afterwards only by the explicit Rename — a folder move the server
// does (the chats, the photos and the picture rows follow it), never a side
// effect of Save.
@Component({
  selector: 'app-character-dialog',
  template: `
    <div class="dialog-body" data-testid="character-dialog">
      @if (!isNew()) {
        <div class="avatar-pick">
          <div class="avatar-thumb">
            @if (avatar()) {
              <img [src]="avatarSrc()" alt="" />
            } @else {
              {{ letter() }}
            }
          </div>
          <label class="btn" title="Pick a picture from disk (one already in your folders is reused, not copied)">
            from disk
            <input type="file" hidden accept="image/*" (change)="onAvatarFile($event)" />
          </label>
          <select
            class="btn"
            data-testid="char-avatar-pick"
            title="Use one of the existing pictures as the avatar"
            (change)="onAvatarPick($event)"
          >
            <option value="">From the pictures…</option>
            @for (p of pictures(); track p.id) {
              <option [value]="p.id">{{ p.id }}</option>
            }
          </select>
          @if (avatar()) {
            <button class="btn danger" title="Remove avatar" (click)="removeAvatar()">✕</button>
          }
        </div>
      }
      <label class="field">
        <span>Name</span>
        <input
          class="grow"
          data-testid="char-name-input"
          placeholder="Character name"
          [value]="name()"
          (input)="setName($event)"
        />
      </label>
      <label class="field">
        <span>ID</span>
        <input
          class="grow"
          type="text"
          spellcheck="false"
          placeholder="alice"
          data-testid="char-id-input"
          [value]="idDraft()"
          (input)="setId($event)"
        />
        @if (!isNew()) {
          <button class="btn" data-testid="char-rename" [disabled]="!idChanged()" (click)="renameId()">
            Rename
          </button>
        }
      </label>
      <div class="dialog-hint">
        @if (isNew()) {
          The ID is the name of the folder the character lives in — letters, digits and ". - _".
          Suggested from the name, write your own if you want it differently.
        } @else {
          Rename moves characters/&lt;id&gt;/ to the new name: the chats that name this character,
          its photos and avatar and the pictures that show it follow the new ID. Name and
          description are untouched by it — and Save alone does not rename anything.
        }
      </div>
      <textarea
        rows="4"
        placeholder="Description / system prompt — the appearance of the character included, in English: the picture planner reads it out of this text"
        [value]="description()"
        (input)="setDescription($event)"
      ></textarea>
      <div class="dialog-hint">
        The image generator has never heard this character's name — it draws what this text and the
        reference pictures (photos and the avatar) say.
      </div>
      <div class="dialog-actions">
        @if (!isNew()) {
          <button class="btn danger" data-testid="char-delete" (click)="remove()">Delete</button>
        }
        <span class="spacer"></span>
        @if (!isNew()) {
          <button class="btn" data-testid="char-clone" (click)="clone()">Clone</button>
        }
        <button class="btn" (click)="cancel()">Cancel</button>
        <button class="btn primary" data-testid="char-save" (click)="save()">Save</button>
      </div>
    </div>
  `,
  styleUrl: './character-dialog.scss',
})
export class CharacterDialog implements OnInit {
  readonly configStore = inject(ConfigStore);
  private api = inject(ApiService);
  private ui = inject(UiStore);
  private chatStore = inject(ChatStore);

  readonly name = signal('');
  readonly description = signal('');
  readonly isNew = signal(true);
  // The avatar is an image id (a path relative to the data folder) kept in the
  // row; null — the character has no avatar.
  readonly avatar = signal<string | null>(null);
  // The existing pictures the avatar can be pointed at (GET /pictures), the
  // "From the pictures…" pick.
  readonly pictures = signal<{ id: string }[]>([]);
  // The ID field: the folder name of a new character, the current one in the
  // edit mode (where Rename applies it).
  readonly idDraft = signal('');
  // The suggested ID follows the name until the user writes one of their own.
  private idTouched = false;
  private id = '';

  ngOnInit(): void {
    const dlg = this.configStore.entityDialog();
    if (dlg?.kind === 'character' && dlg.id) {
      this.id = dlg.id;
      this.isNew.set(false);
      this.idDraft.set(dlg.id);
      const c = this.configStore.characters().find((x) => x.id === dlg.id);
      if (c) {
        this.name.set(c.name);
        this.description.set(c.description);
        this.avatar.set(c.avatar ?? null);
      }
      this.api
        .listPictures()
        .then((res) => this.pictures.set(res.pictures.map((p) => ({ id: p.id }))))
        .catch(() => undefined);
    }
  }

  letter(): string {
    const ch = this.name().trim().charAt(0).toUpperCase();
    return ch || '•';
  }
  avatarSrc(): string {
    const a = this.avatar();
    return a ? this.api.mediaUrl(a) : '';
  }
  setName(e: Event): void {
    const value = (e.target as HTMLInputElement).value;
    this.name.set(value);
    if (this.isNew() && !this.idTouched) this.idDraft.set(suggestEntityId(value));
  }
  setId(e: Event): void {
    this.idTouched = true;
    this.idDraft.set((e.target as HTMLInputElement).value);
  }
  setDescription(e: Event): void {
    this.description.set((e.target as HTMLTextAreaElement).value);
  }

  // Whether the ID field asks for a move (the edit mode: Rename is dead until
  // the field says another folder name).
  idChanged(): boolean {
    return !this.isNew() && !!this.idDraft().trim() && this.idDraft().trim() !== this.id;
  }

  save(): void {
    const nm = this.name().trim();
    if (!nm) {
      this.ui.error.set('The name cannot be empty');
      return;
    }
    const id = this.idDraft().trim();
    if (this.isNew() && id && !isEntityId(id)) {
      this.ui.error.set(ENTITY_ID_RULE);
      return;
    }
    this.configStore.saveCharacter(
      this.isNew() ? null : this.id,
      nm,
      this.description().trim(),
      this.isNew() ? id : undefined,
    );
    this.configStore.closeEntityDialog();
  }

  // Renaming an ID is a folder move, not a field edit: the server moves the
  // folder and takes the chats, the photos and the picture rows with it. The
  // dialog then re-opens on the new ID — the modal's keyed block recreates this
  // component (the same path Clone takes), so the avatar upload and Save go on
  // working with the name the folder really has.
  renameId(): void {
    const next = this.idDraft().trim();
    if (!isEntityId(next)) {
      this.ui.error.set(ENTITY_ID_RULE);
      return;
    }
    if (next === this.id) return;
    this.configStore.renameCharacter(this.id, next).then((newId) => {
      if (!newId) return; // the banner already says why the name was refused
      // the open chat names this character in its participant list and in the
      // author of its lines, and the chat list shows the same names
      this.chatStore.refreshCurrentChat();
      void this.chatStore.refreshChats();
      this.configStore.openCharacterDialog(newId);
    });
  }

  cancel(): void {
    this.configStore.closeEntityDialog();
  }

  remove(): void {
    const nm = this.name().trim() || this.id;
    if (!confirm(`Delete the character "${nm}"? Its photos and the avatar will be removed.`)) return;
    this.configStore.deleteCharacter(this.id);
    this.configStore.closeEntityDialog();
  }

  clone(): void {
    // The dialog switches to the copy (the new id recreates the dialog —
    // see the @keyed block in app.ts) instead of closing.
    this.configStore.cloneCharacter(this.id).then((newId) => {
      if (newId) this.configStore.openCharacterDialog(newId);
    });
  }

  async onAvatarFile(e: Event): Promise<void> {
    const inputEl = e.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    try {
      const data = await this.readFile(file);
      const id = await this.configStore.setAvatar('character', this.id, { data });
      if (id) this.avatar.set(id);
    } catch (err) {
      this.ui.error.set(String((err as Error).message));
    }
  }
  // Points the avatar at an existing picture (the "From the pictures…" pick) —
  // no copy is made, the row just names that id.
  async onAvatarPick(e: Event): Promise<void> {
    const selectEl = e.target as HTMLSelectElement;
    const image = selectEl.value;
    selectEl.value = '';
    if (!image) return;
    const id = await this.configStore.setAvatar('character', this.id, { image });
    if (id) this.avatar.set(id);
  }
  async removeAvatar(): Promise<void> {
    await this.configStore.clearAvatar('character', this.id);
    this.avatar.set(null);
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
