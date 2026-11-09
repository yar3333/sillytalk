import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService, AppConfig, Character, LlmModel, Model, User } from './api';
import { UiStore } from './ui-store';

// The entity edit dialogs (character / persona / model): which one is open
// and which item it edits (null — creating a new one).
export type EntityDialog =
  | { kind: 'model'; name: string | null }
  | { kind: 'character'; id: string | null }
  | { kind: 'user'; id: string | null };

// A free model name: "<base>", "<base> 2", "<base> 3", …
function uniqueModelName(base: string, models: Record<string, LlmModel>): string {
  let name = base;
  let n = 2;
  while (name in models) name = `${base} ${n++}`;
  return name;
}

// The application config and the catalogs: models, characters, users,
// the availability of the image generator + the "Settings" dialog + the
// entity edit dialogs (character / persona / model).
@Injectable({ providedIn: 'root' })
export class ConfigStore {
  private api = inject(ApiService);
  protected ui = inject(UiStore);

  readonly config = signal<AppConfig | null>(null);
  readonly characters = signal<Character[]>([]);
  readonly users = signal<User[]>([]);

  // Whether the active image generator is available (the first available one from the config).
  readonly imageGenAvailable = signal(false);
  // The image models a ComfyUI generator can run — the backend knows which
  // workflows the app ships, the settings dialog offers exactly these.
  readonly comfyUiModels = signal<string[]>([]);

  // The "Settings" dialog: open + the copy of the config being edited.
  readonly settingsOpen = signal(false);
  readonly editingConfig = signal<AppConfig | null>(null);

  // The entity edit dialog (character / persona / model): the item being
  // edited (a null id — creating a new one).
  readonly entityDialog = signal<EntityDialog | null>(null);

  // The llmModels key = the model name (the internal ID that chat.modelId references).
  readonly models = computed<Model[]>(() => {
    const cfg = this.config();
    if (!cfg) return [];
    return Object.entries(cfg.llmModels).map(([name, m]) => ({ name, ...m }));
  });

  /** Load: config → generator status → characters → users.
      An error — into the global banner; the promise is not rejected. */
  loadAll(): Promise<void> {
    return this.api
      .getConfig()
      .then((cfg) => {
        this.config.set(cfg);
        return this.api.imageStatus();
      })
      .then((status) => {
        this.imageGenAvailable.set(status.available);
        this.comfyUiModels.set(status.comfyUiModels ?? []);
        return this.api.getCharacters();
      })
      .then((chars) => {
        this.characters.set(chars);
        return this.api.getUsers();
      })
      .then((users) => {
        this.users.set(users);
      })
      .catch((e) => {
        this.ui.error.set(String(e?.message ?? e));
      }) as Promise<void>;
  }

  openSettings(): void {
    if (this.config()) this.editingConfig.set(JSON.parse(JSON.stringify(this.config())));
    this.settingsOpen.set(true);
  }

  closeSettings(): void {
    this.settingsOpen.set(false);
  }

  // ---- the entity edit dialogs (character / persona / model) ----
  // The item id/name is optional — without it the dialog creates a new one.
  openModelDialog(name?: string): void {
    if (!this.config()) return;
    this.entityDialog.set({ kind: 'model', name: name ?? null });
  }
  openCharacterDialog(id?: string): void {
    this.entityDialog.set({ kind: 'character', id: id ?? null });
  }
  openUserDialog(id?: string): void {
    this.entityDialog.set({ kind: 'user', id: id ?? null });
  }
  closeEntityDialog(): void {
    this.entityDialog.set(null);
  }

  // ---- models (the llmModels entries of the config) ----
  // Saves the model: oldName === null — a new one; a name change renames the
  // entry (the chats referencing the old key are re-attached on load).
  saveModel(oldName: string | null, name: string, value: LlmModel): void {
    const cfg = this.config();
    if (!cfg) return;
    const llmModels = { ...cfg.llmModels };
    if (oldName && oldName !== name) delete llmModels[oldName];
    llmModels[name] = value;
    this.putConfig({ ...cfg, llmModels });
  }

  deleteModel(name: string): void {
    const cfg = this.config();
    if (!cfg) return;
    const llmModels = { ...cfg.llmModels };
    delete llmModels[name];
    this.putConfig({ ...cfg, llmModels });
  }

  // Clones the entry into a free "<name> copy" key.
  cloneModel(name: string): void {
    const cfg = this.config();
    if (!cfg || !cfg.llmModels[name]) return;
    const newName = uniqueModelName(`${name} copy`, cfg.llmModels);
    this.putConfig({
      ...cfg,
      llmModels: { ...cfg.llmModels, [newName]: { ...cfg.llmModels[name] } },
    });
  }

  private putConfig(cfg: AppConfig): void {
    this.api
      .putConfig(cfg)
      .then((saved) => this.config.set(saved))
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // ---- characters (the characters/ folders — full list sync) ----
  // id === null — creates a new one; its ID is the newId the user typed (an ID
  // is the name of the character's folder), with a generated one as the fallback
  // for a field left empty. A rename is NOT here: it is renameCharacter below,
  // because an ID is a folder and its move drags the chats and the picture rows
  // along — a job for the server, not for the list sync (which would delete the
  // old folder with its photos and write an empty one under the new name).
  saveCharacter(id: string | null, name: string, description: string, newId?: string): void {
    const chars = this.characters();
    const next = id
      ? chars.map((c) => (c.id === id ? { ...c, name, description } : c))
      : [...chars, { id: (newId ?? '').trim() || 'c' + Date.now(), name, description }];
    this.putCharacters(next);
  }

  // Renames a character: the folder move on the server, with the chats that
  // name this character, its photos and avatar as picture ids and the cast of
  // the picture rows following the new ID. Resolves with the new id (null on
  // error) — the dialog switches to the copy of itself that edits the renamed
  // character, the way Clone does.
  renameCharacter(id: string, newId: string): Promise<string | null> {
    return this.api
      .renameCharacter(id, newId.trim())
      .then((res) => {
        this.characters.set(res.characters);
        return res.id;
      })
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        return null;
      });
  }

  deleteCharacter(id: string): void {
    this.putCharacters(this.characters().filter((c) => c.id !== id));
  }

  // Clones the character folder (the photos and the avatar go along).
  // Resolves with the copy's id (null on error) — the dialog opens it.
  cloneCharacter(id: string): Promise<string | null> {
    return this.api
      .cloneCharacter(id)
      .then((res) => {
        this.characters.set(res.characters);
        return res.id;
      })
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        return null;
      });
  }

  private putCharacters(chars: Character[]): void {
    this.api
      .putCharacters(chars)
      .then((list) => this.characters.set(list))
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // ---- users (the users/ folders — full list sync) ----
  // The same rules as a character: id === null creates one, its ID is the newId
  // the user typed (the name of the persona's folder), and renaming goes to
  // renameUser, not to the sync.
  saveUser(id: string | null, name: string, description: string, newId?: string): void {
    const users = this.users();
    const next = id
      ? users.map((u) => (u.id === id ? { ...u, name, description } : u))
      : [...users, { id: (newId ?? '').trim() || 'u' + Date.now(), name, description }];
    this.putUsers(next);
  }

  // Renames a persona: the folder move on the server, with the chats that send
  // their messages under this persona, the author of the lines it already said,
  // its avatar as a picture id and the cast of the picture rows following the
  // new ID. Resolves with the new id (null on error).
  renameUser(id: string, newId: string): Promise<string | null> {
    return this.api
      .renameUser(id, newId.trim())
      .then((res) => {
        this.users.set(res.users);
        return res.id;
      })
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        return null;
      });
  }

  deleteUser(id: string): void {
    this.putUsers(this.users().filter((u) => u.id !== id));
  }

  // Clones the user folder (the avatar goes along). Resolves with the copy's
  // id (null on error) — the dialog opens it.
  cloneUser(id: string): Promise<string | null> {
    return this.api
      .cloneUser(id)
      .then((res) => {
        this.users.set(res.users);
        return res.id;
      })
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        return null;
      });
  }

  private putUsers(users: User[]): void {
    this.api
      .putUsers(users)
      .then((list) => this.users.set(list))
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // ---- the avatar (an image id kept in the entity's row) ----
  // Picks the avatar from a disk file (`data` — a data URL) or an existing
  // picture id (`image`). The server de-duplicates a disk pick (a byte-identical
  // picture already in the data folders is reused, not copied) and answers with
  // the avatar's image id; that id is mirrored into the local row so the header
  // and the message avatars show the picture without a catalog reload.
  setAvatar(
    kind: 'user' | 'character',
    id: string,
    source: { data?: string; image?: string },
  ): Promise<string | null> {
    return this.api
      .setAvatar(kind, id, source)
      .then((res) => {
        this.applyAvatar(kind, id, res.id);
        return res.id;
      })
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        return null;
      });
  }

  // Drops the avatar designation (the picture file itself stays on disk).
  clearAvatar(kind: 'user' | 'character', id: string): Promise<void> {
    return this.api
      .clearAvatar(kind, id)
      .then(() => this.applyAvatar(kind, id, null))
      .catch((e) => void this.ui.error.set(String((e as Error).message)));
  }

  private applyAvatar(kind: 'user' | 'character', id: string, avatar: string | null): void {
    if (kind === 'user') {
      this.users.update((list) => list.map((u) => (u.id === id ? { ...u, avatar } : u)));
    } else {
      this.characters.update((list) => list.map((c) => (c.id === id ? { ...c, avatar } : c)));
    }
  }

  // The settings dialog saves the listen address and the image generators
  // only — the models/characters/personas have their own dialogs now.
  saveSettings(config: AppConfig): void {
    this.api
      .putConfig(config)
      .then((saved) => {
        this.config.set(saved);
        return this.api.imageStatus();
      })
      .then((status) => {
        this.imageGenAvailable.set(status.available);
        this.comfyUiModels.set(status.comfyUiModels ?? []);
        this.settingsOpen.set(false);
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }
}
