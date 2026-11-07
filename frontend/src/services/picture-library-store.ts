import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService, Picture } from './api';
import { ChatStore } from './chat-store';
import { UiStore } from './ui-store';

// The picture browser: every picture of the data folder with what the images
// table says about it, wherever it came from — a chat card, a character's photo,
// a file dropped into a folder. It is the one place a picture is edited outside
// a conversation, and the reason the table can be the only source: an edit here
// is the edit a chat card shows.
//
// The store holds the catalog and the selection; the dialog's form fields are
// local to its component (like every other dialog here).
@Injectable({ providedIn: 'root' })
export class PictureLibraryStore {
  private readonly api = inject(ApiService);
  private readonly chatStore = inject(ChatStore);
  private readonly ui = inject(UiStore);

  readonly open = signal(false);
  readonly pictures = signal<Picture[]>([]);
  readonly loading = signal(false);
  readonly selectedId = signal('');
  readonly selected = computed<Picture | null>(
    () => this.pictures().find((p) => p.id === this.selectedId()) ?? null,
  );

  openLibrary(): void {
    this.open.set(true);
    this.refresh();
  }

  close(): void {
    this.open.set(false);
  }

  // Re-reads the catalog, keeping the selection when its picture is still there
  // (a rename and a generation both change what the folder holds).
  refresh(): void {
    this.loading.set(true);
    this.api
      .listPictures()
      .then((res) => {
        this.pictures.set(res.pictures);
        if (!res.pictures.some((p) => p.id === this.selectedId())) {
          this.selectedId.set(res.pictures[0]?.id ?? '');
        }
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)))
      .finally(() => this.loading.set(false));
  }

  select(id: string): void {
    this.selectedId.set(id);
  }

  // Writes the description / prompt / references of the selected picture. The
  // row is the card, so the chat that shows this picture is re-read after the
  // save — the caption changes under the user without a reload.
  savePicture(patch: { description: string; prompt: string; refs: string[] }): void {
    const id = this.selectedId();
    if (!id) return;
    this.api
      .editPicture(id, patch)
      .then((res) => {
        this.replace(res.picture);
        this.refreshCurrentChat();
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  // Renames the selected picture: a file move on the server, with the chat cards
  // and the stored reference lists following the new path — which is why the
  // catalog is re-read rather than patched (every neighbouring id may have
  // changed shape and the renamed picture is a new id).
  renamePicture(newId: string): void {
    const id = this.selectedId();
    if (!id || !newId.trim() || newId === id) return;
    this.api
      .renamePicture(id, newId.trim())
      .then((res) => {
        this.selectedId.set(res.picture.id);
        this.refresh();
        this.refreshCurrentChat();
      })
      .catch((e) => this.ui.error.set(String((e as Error).message)));
  }

  private replace(picture: Picture): void {
    this.pictures.update((list) => {
      const index = list.findIndex((p) => p.id === picture.id);
      if (index < 0) return [...list, picture];
      const next = [...list];
      next[index] = picture;
      return next;
    });
  }

  // A card of the current chat may be the picture that was just edited: the
  // table is where it reads its caption from, so a re-read is all it takes.
  private refreshCurrentChat(): void {
    const id = this.chatStore.chat()?.id;
    if (!id) return;
    this.api
      .getChat(id)
      .then((chat) => {
        if (this.chatStore.chat()?.id === id) this.chatStore.applyChat(chat);
      })
      .catch(() => undefined);
  }
}
