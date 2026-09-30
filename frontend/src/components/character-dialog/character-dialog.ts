import { Component, OnInit, inject, signal } from '@angular/core';
import { ApiService } from '../../services/api';
import { ConfigStore } from '../../services/config-store';
import { UiStore } from '../../services/ui-store';

// The character edit dialog: name, description, the avatar. The item is
// taken from ConfigStore.entityDialog (a null id — creating a new one);
// save/delete/clone — the store actions (the dialog itself holds only the
// field values). Delete and Clone exist in the edit mode only.
@Component({
  selector: 'app-character-dialog',
  template: `
    <div class="dialog-body" data-testid="character-dialog">
      @if (!isNew()) {
        <div class="avatar-pick">
          <div class="avatar-thumb">
            @if (hasAvatar()) {
              <img [src]="avatarSrc()" alt="" />
            } @else {
              {{ letter() }}
            }
          </div>
          <label class="btn" title="Upload avatar (characters/<id>/avatar.jpg)">
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
          data-testid="char-name-input"
          placeholder="Character name"
          [value]="name()"
          (input)="setName($event)"
        />
      </label>
      <textarea
        rows="4"
        placeholder="Description / system prompt"
        [value]="description()"
        (input)="setDescription($event)"
      ></textarea>
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

  readonly name = signal('');
  readonly description = signal('');
  readonly isNew = signal(true);
  readonly hasAvatar = signal(false);
  // A cache buster for the avatar preview after upload/removal.
  readonly mediaVersion = signal(0);
  private id = '';

  ngOnInit(): void {
    const dlg = this.configStore.entityDialog();
    if (dlg?.kind === 'character' && dlg.id) {
      this.id = dlg.id;
      this.isNew.set(false);
      const c = this.configStore.characters().find((x) => x.id === dlg.id);
      if (c) {
        this.name.set(c.name);
        this.description.set(c.description);
        this.hasAvatar.set(!!c.hasAvatar);
      }
    }
  }

  letter(): string {
    const ch = this.name().trim().charAt(0).toUpperCase();
    return ch || '•';
  }
  avatarSrc(): string {
    return this.api.characterAvatarUrl(this.id) + '?v=' + this.mediaVersion();
  }
  setName(e: Event): void {
    this.name.set((e.target as HTMLInputElement).value);
  }
  setDescription(e: Event): void {
    this.description.set((e.target as HTMLTextAreaElement).value);
  }

  save(): void {
    const nm = this.name().trim();
    if (!nm) {
      this.ui.error.set('The name cannot be empty');
      return;
    }
    this.configStore.saveCharacter(this.isNew() ? null : this.id, nm, this.description().trim());
    this.configStore.closeEntityDialog();
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
      await this.api.uploadAvatar('character', this.id, data);
      this.hasAvatar.set(true);
      this.mediaVersion.update((v) => v + 1);
    } catch (err) {
      this.ui.error.set(String((err as Error).message));
    }
  }
  async removeAvatar(): Promise<void> {
    try {
      await this.api.deleteAvatar('character', this.id);
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
