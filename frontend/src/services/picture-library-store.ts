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

  // Closing the browser drops the editor's form, and the form is local to the
  // component (like every dialog's) — so the component reports whether it holds
  // an edit that is not on the server yet: a caption typed but not saved is not
  // the ✕'s to throw away either. `closeBlocked` is that refusal, which the
  // dialog shows itself — the ✕ lives in the shell's header, far from the
  // fields, so a click that landed on nothing would read as a broken button.
  readonly dirty = signal(false);
  readonly closeBlocked = signal(false);
  private closeBlockedTimer: ReturnType<typeof setTimeout> | null = null;

  openLibrary(): void {
    this.dirty.set(false);
    this.clearCloseBlocked();
    this.open.set(true);
    this.refresh();
  }

  close(): void {
    if (this.dirty()) {
      this.closeBlocked.set(true);
      if (this.closeBlockedTimer) clearTimeout(this.closeBlockedTimer);
      this.closeBlockedTimer = setTimeout(() => {
        this.closeBlocked.set(false);
        this.closeBlockedTimer = null;
      }, 2500);
      return;
    }
    this.clearCloseBlocked();
    this.open.set(false);
  }

  private clearCloseBlocked(): void {
    if (this.closeBlockedTimer) {
      clearTimeout(this.closeBlockedTimer);
      this.closeBlockedTimer = null;
    }
    this.closeBlocked.set(false);
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
  // save — the caption changes under the user without a reload. The answer is
  // the row as the server now holds it (null when the save failed and the
  // banner says why), which is what the editor takes as its clean state.
  savePicture(patch: {
    description: string;
    prompt: string;
    refs: string[];
  }): Promise<Picture | null> {
    const id = this.selectedId();
    if (!id) return Promise.resolve(null);
    return this.api
      .editPicture(id, patch)
      .then((res) => {
        this.replace(res.picture);
        this.refreshCurrentChat();
        return res.picture;
      })
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        return null;
      });
  }

  // Renames the selected picture: a file move on the server, with the chat cards
  // and the stored reference lists following the new path — which is why the
  // catalog is re-read rather than patched (every neighbouring id may have
  // changed shape and the renamed picture is a new id). A record whose file is
  // gone renames too: it moves the record, or attaches it to a file that already
  // lives at the new id. The answer is the moved picture (null when nothing was
  // asked or the server refused it — the refusal is the banner).
  renamePicture(newId: string): Promise<Picture | null> {
    const id = this.selectedId();
    if (!id || !newId.trim() || newId === id) return Promise.resolve(null);
    return this.api
      .renamePicture(id, newId.trim())
      .then((res) => {
        this.selectedId.set(res.picture.id);
        this.refresh();
        this.refreshCurrentChat();
        return res.picture;
      })
      .catch((e) => {
        this.ui.error.set(String((e as Error).message));
        return null;
      });
  }

  // Drops the record of a picture whose file is gone — an orphan row is what is
  // left of a picture the user removed outside the app, and the browser is the
  // only place it can be cleared. The server refuses a picture whose file still
  // exists (the app does not delete pictures), so the refusal is the banner.
  forgetPicture(): void {
    const id = this.selectedId();
    if (!id) return;
    const known = this.pictures();
    this.api
      .forgetPicture(id)
      .then(() => {
        // The selection moves on to the next picture the list still has.
        const rest = known.filter((p) => p.id !== id);
        this.selectedId.set(rest[0]?.id ?? '');
        this.refresh();
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
