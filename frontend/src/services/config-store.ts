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
  // id === null — creates a new one (the id is generated here).
  saveCharacter(id: string | null, name: string, description: string): void {
    const chars = this.characters();
    const next = id
      ? chars.map((c) => (c.id === id ? { ...c, name, description } : c))
      : [...chars, { id: 'c' + Date.now(), name, description }];
    this.putCharacters(next);
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
  saveUser(id: string | null, name: string, description: string): void {
    const users = this.users();
    const next = id
      ? users.map((u) => (u.id === id ? { ...u, name, description } : u))
      : [...users, { id: 'u' + Date.now(), name, description }];
    this.putUsers(next);
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
        this.settingsOpen.set(false);
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }
}
