import { Component, OnInit, inject, signal } from '@angular/core';
import { ApiService } from '../../services/api';
import { ChatStore } from '../../services/chat-store';
import { ConfigStore } from '../../services/config-store';
import { isEntityId, suggestEntityId, ENTITY_ID_RULE } from '../../services/helpers';
import { UiStore } from '../../services/ui-store';

// The persona (user) edit dialog: ID, name, description, the avatar. The item is
// taken from ConfigStore.entityDialog (a null id — creating a new one);
// save/delete/clone — the store actions (the dialog itself holds only the
// field values). Delete and Clone exist in the edit mode only.
//
// The ID is the name of the persona's folder, so it follows the same rule as a
// character's: written by the user when the persona is created, changed later
// only by the explicit Rename — the folder move the server does, taking the
// chats and the picture rows with it. A rename of a persona is worth a moment's
// thought: the chats store this id as the persona their messages go under.
@Component({
  selector: 'app-user-dialog',
  template: `
    <div class="dialog-body" data-testid="user-dialog">
      @if (!isNew()) {
        <div class="avatar-pick">
          <div class="avatar-thumb">
            @if (hasAvatar()) {
              <img [src]="avatarSrc()" alt="" />
            } @else {
              {{ letter() }}
            }
          </div>
          <label class="btn" title="Upload avatar (users/<id>/avatar.jpg)">
            photo
            <input type="file" hidden accept="image/*" (change)="onAvatarFile($event)" />
          </label>
          @if (hasAvatar()) {
            <button class="btn danger" title="Remove avatar" (click)="removeAvatar()">✕</button>
          }
        </div>
      }
      <label class="field">
        <span>Name</span>
        <input
          class="grow"
          data-testid="user-name-input"
          placeholder="Persona name"
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
          placeholder="carol"
          data-testid="user-id-input"
          [value]="idDraft()"
          (input)="setId($event)"
        />
        @if (!isNew()) {
          <button class="btn" data-testid="user-rename" [disabled]="!idChanged()" (click)="renameId()">
            Rename
          </button>
        }
      </label>
      <div class="dialog-hint">
        @if (isNew()) {
          The ID is the name of the folder the persona lives in — letters, digits and ". - _".
          Suggested from the name, write your own if you want it differently.
        } @else {
          Rename moves users/&lt;id&gt;/ to the new name: the chats that send their messages under
          this persona, the lines it already said and the pictures that show it follow the new ID.
          Name and description are untouched by it — and Save alone does not rename anything.
        }
      </div>
      <textarea
        rows="4"
        placeholder="Persona description (who you are to the character) — your appearance included, in English: the picture planner reads it out of this text"
        [value]="description()"
        (input)="setDescription($event)"
      ></textarea>
      <div class="dialog-hint">
        The image generator has never heard this persona's name — it draws what this text and the
        reference pictures (the avatar) say.
      </div>
      <div class="dialog-actions">
        @if (!isNew()) {
          <button class="btn danger" data-testid="user-delete" (click)="remove()">Delete</button>
        }
        <span class="spacer"></span>
        @if (!isNew()) {
          <button class="btn" data-testid="user-clone" (click)="clone()">Clone</button>
        }
        <button class="btn" (click)="cancel()">Cancel</button>
        <button class="btn primary" data-testid="user-save" (click)="save()">Save</button>
      </div>
    </div>
  `,
  styleUrl: './user-dialog.scss',
})
export class UserDialog implements OnInit {
  readonly configStore = inject(ConfigStore);
  private api = inject(ApiService);
  private ui = inject(UiStore);
  private chatStore = inject(ChatStore);

  readonly name = signal('');
  readonly description = signal('');
  readonly isNew = signal(true);
  readonly hasAvatar = signal(false);
  // The ID field: the folder name of a new persona, the current one in the edit
  // mode (where Rename applies it).
  readonly idDraft = signal('');
  // The suggested ID follows the name until the user writes one of their own.
  private idTouched = false;
  // A cache buster for the avatar preview after upload/removal.
  readonly mediaVersion = signal(0);
  private id = '';

  ngOnInit(): void {
    const dlg = this.configStore.entityDialog();
    if (dlg?.kind === 'user' && dlg.id) {
      this.id = dlg.id;
      this.isNew.set(false);
      this.idDraft.set(dlg.id);
      const u = this.configStore.users().find((x) => x.id === dlg.id);
      if (u) {
        this.name.set(u.name);
        this.description.set(u.description);
        this.hasAvatar.set(!!u.hasAvatar);
      }
    }
  }

  letter(): string {
    const ch = this.name().trim().charAt(0).toUpperCase();
    return ch || '•';
  }
  avatarSrc(): string {
    return this.api.userAvatarUrl(this.id) + '?v=' + this.mediaVersion();
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
    this.configStore.saveUser(
      this.isNew() ? null : this.id,
      nm,
      this.description().trim(),
      this.isNew() ? id : undefined,
    );
    this.configStore.closeEntityDialog();
  }

  // Renaming an ID is a folder move, not a field edit: the server moves the
  // folder and takes the chats, the avatar and the picture rows with it. The
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
    this.configStore.renameUser(this.id, next).then((newId) => {
      if (!newId) return; // the banner already says why the name was refused
      // this persona is the author of the open chat's user lines and the one
      // new messages go under; the chat list names it too
      this.chatStore.refreshCurrentChat();
      void this.chatStore.refreshChats();
      this.configStore.openUserDialog(newId);
    });
  }

  cancel(): void {
    this.configStore.closeEntityDialog();
  }

  remove(): void {
    const nm = this.name().trim() || this.id;
    if (!confirm(`Delete the persona "${nm}"? The old messages keep their author name.`)) return;
    this.configStore.deleteUser(this.id);
    this.configStore.closeEntityDialog();
  }

  clone(): void {
    // The dialog switches to the copy (the new id recreates the dialog —
    // see the @keyed block in app.ts) instead of closing.
    this.configStore.cloneUser(this.id).then((newId) => {
      if (newId) this.configStore.openUserDialog(newId);
    });
  }

  async onAvatarFile(e: Event): Promise<void> {
    const inputEl = e.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    try {
      const data = await this.readFile(file);
      await this.api.uploadAvatar('user', this.id, data);
      this.hasAvatar.set(true);
      this.mediaVersion.update((v) => v + 1);
    } catch (err) {
      this.ui.error.set(String((err as Error).message));
    }
  }
  async removeAvatar(): Promise<void> {
    try {
      await this.api.deleteAvatar('user', this.id);
      this.hasAvatar.set(false);
      this.mediaVersion.update((v) => v + 1);
    } catch (err) {
      this.ui.error.set(String((err as Error).message));
    }
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
