import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ChatSummary } from '../../services/api';
import { ConfigStore } from '../../services/config-store';
import { ChatStore } from '../../services/chat-store';
import { PictureLibraryStore } from '../../services/picture-library-store';
import { chatHintOf, chatTitleOf, messageCountLabel } from '../../services/helpers';

// The header: character / persona (dropdown menus), the chat title and model,
// the "⋮" menu.
// Opening/closing the menus — local state of the header: a click away
// (document) closes everything; clicks on menu items bubble up to document,
// so the menu closes by itself after a selection.
@Component({
  selector: 'app-top-bar',
  template: `
    <header class="topbar">
      <div
        class="ident"
        [title]="chatStore.idShort() ? 'Chat ID: ' + chatStore.idShort() : undefined"
      >
        <span class="who">
          <span class="name-wrap">
            <span
              class="char-name"
              data-testid="char-name"
              (click)="$event.stopPropagation(); toggleCharacterMenu()"
            >
              {{ chatStore.participantsLabel() }}
            </span>
            @if (characterMenuOpen()) {
              <div class="dropdown">
                <div class="dropdown-title">Characters in the chat</div>
                @for (c of menuCharacters(); track c.id) {
                  <div class="opt-row" data-testid="char-option">
                    <button
                      class="opt opt-toggle"
                      [class.active]="inChat(c.id)"
                      (click)="$event.stopPropagation(); chatStore.toggleCharacter(c.id)"
                    >
                      <span class="opt-mark">{{ inChat(c.id) ? '●' : '○' }}</span>
                      {{ c.name }}
                    </button>
                    @if (chatStore.chat()?.characterIds.includes(c.id)) {
                      <button
                        class="opt-move"
                        title="Higher in the reply queue"
                        [disabled]="isFirstParticipant(c.id)"
                        (click)="moveParticipant($event, c.id, -1)"
                      >
                        ↑
                      </button>
                      <button
                        class="opt-move"
                        title="Lower in the reply queue"
                        [disabled]="isLastParticipant(c.id)"
                        (click)="moveParticipant($event, c.id, 1)"
                      >
                        ↓
                      </button>
                    }
                    <button
                      class="opt-edit"
                      data-testid="char-edit"
                      title="Edit the character"
                      (click)="configStore.openCharacterDialog(c.id)"
                    >
                      ✎
                    </button>
                  </div>
                }
                <div class="sep"></div>
                <button
                  class="opt"
                  data-testid="new-character"
                  (click)="configStore.openCharacterDialog()"
                >
                  + New character
                </button>
              </div>
            }
          </span>
          <span class="who-sep">/</span>
          <span class="name-wrap">
            <span
              class="user-name"
              data-testid="user-name"
              (click)="$event.stopPropagation(); toggleUserMenu()"
            >
              {{ chatStore.chatUser()?.name ?? '—' }}
            </span>
            @if (userMenuOpen()) {
              <div class="dropdown">
                <div class="dropdown-title">Active persona</div>
                @for (u of configStore.users(); track u.id) {
                  <div class="opt-row" data-testid="user-option-row">
                    <button
                      class="opt opt-toggle"
                      data-testid="user-option"
                      [class.active]="chatStore.chat()?.userId === u.id"
                      (click)="chatStore.selectUser(u.id)"
                    >
                      {{ u.name }}
                    </button>
                    <button
                      class="opt-edit"
                      data-testid="user-edit"
                      title="Edit the persona"
                      (click)="configStore.openUserDialog(u.id)"
                    >
                      ✎
                    </button>
                  </div>
                }
                <div class="sep"></div>
                <button
                  class="opt"
                  data-testid="new-persona"
                  (click)="configStore.openUserDialog()"
                >
                  + New persona
                </button>
                <div class="dropdown-hint">
                  Switching the persona does not rewrite old messages — every message keeps its
                  author.
                </div>
              </div>
            }
          </span>
        </span>
      </div>

      <!-- The chat menu: the chat's title (its name, or the creation date while
           it has no name) opens it (the chat-management items moved out of the
           ⋮ menu). It is wider than the usual dropdown.
           The chat-actions ⋮ (settings / clone / delete) lives INSIDE the same
           cell — no gap between the title and the dots. -->
      <span
        class="chat-date"
        data-testid="chat-date"
        title="Chat menu"
        (click)="$event.stopPropagation(); toggleChatMenu()"
      >
        <span class="chat-date-label">{{ chatStore.chatTitle() || 'Chat' }}</span>
        <span class="chat-dots-wrap">
          <button
            class="dots"
            data-testid="chat-dots"
            title="Chat actions"
            (click)="$event.stopPropagation(); toggleChatDots()"
          >
            ⋮
          </button>
          @if (chatDotsOpen()) {
            <div class="dropdown">
              <!-- stopPropagation: the dropdown lives INSIDE the .chat-date
                   cell — without it the click bubbles to the date's handler
                   and opens the chat menu (e.g. after "cancel" in the delete
                   confirm the menu popped open). -->
              <button
                class="opt"
                data-testid="chat-settings"
                (click)="$event.stopPropagation(); chatDotsOpen.set(false); chatStore.openChatSettings()"
              >
                Chat settings…
              </button>
              <button
                class="opt"
                data-testid="clone-chat"
                (click)="$event.stopPropagation(); chatDotsOpen.set(false); chatStore.cloneCurrentChat()"
              >
                Clone chat
              </button>
              <button
                class="opt danger"
                data-testid="delete-chat"
                (click)="$event.stopPropagation(); chatDotsOpen.set(false); chatStore.deleteCurrentChat()"
              >
                Delete chat
              </button>
            </div>
          }
        </span>
        @if (chatMenuOpen()) {
          <div class="dropdown chat-dropdown">
            <button class="opt" data-testid="new-chat" (click)="chatStore.newChat()">New chat</button>
            <div class="dropdown-title">Chats</div>
            <div class="chat-list">
              @for (cs of chatStore.chats(); track cs.id) {
                <!-- The row shows the chat's title (its name, or the creation
                     date while it has none); who is in the chat and when it
                     last spoke is the hover hint. -->
                <button
                  class="opt"
                  [class.active]="chatStore.chat()?.id === cs.id"
                  [title]="chatHint(cs)"
                  (click)="chatStore.openChat(cs.id)"
                >
                  <span class="chat-item-name">
                    <span class="chat-item-title">{{ chatTitle(cs) }}</span>
                  </span>
                  <span class="chat-item-meta">{{ messageCount(cs.messageCount) }}</span>
                </button>
              }
            </div>
          </div>
        }
      </span>

      <div class="top-right">
        <span class="model-wrap">
          <span
            class="model-chip"
            data-testid="model-chip"
            title="Model"
            (click)="$event.stopPropagation(); toggleModelMenu()"
          >
            {{ chatStore.modelLabel() }}
          </span>
          @if (modelMenuOpen()) {
            <div class="dropdown model-dropdown">
              <div class="dropdown-title">Model</div>
              @for (m of configStore.models(); track m.name) {
                <div class="opt-row" data-testid="model-option-row">
                  <button
                    class="opt opt-toggle"
                    data-testid="model-option"
                    [class.active]="chatStore.currentModel()?.name === m.name"
                    (click)="chatStore.selectModel(m.name)"
                  >
                    {{ m.name }}
                    @if (m.supportsImages) {
                      (👁)
                    }
                  </button>
                  <button
                    class="opt-edit"
                    data-testid="model-edit"
                    title="Edit the model"
                    (click)="configStore.openModelDialog(m.name)"
                  >
                    ✎
                  </button>
                </div>
              }
              <div class="sep"></div>
              <button class="opt" data-testid="new-model" (click)="configStore.openModelDialog()">
                + New model
              </button>
            </div>
          }
        </span>

        <!-- The vision model of the chat: the one that LOOKS at pictures (card
             captions, "Describe the picture"). Only the 👁 is shown; the name of
             the model the app will really use is the hover hint, because this is
             a second model next to the chat's own. -->
        <span class="vision-wrap">
          <button
            class="vision-chip"
            data-testid="vision-chip"
            [class.missing]="!chatStore.canDescribePictures()"
            [title]="chatStore.visionModelTitle()"
            (click)="$event.stopPropagation(); toggleVisionMenu()"
          >
            👁
          </button>
          @if (visionMenuOpen()) {
            <div class="dropdown vision-dropdown">
              <div class="dropdown-title">Model for pictures</div>
              <button
                class="opt"
                data-testid="vision-option-default"
                [class.active]="!chatStore.visionModelPick()"
                (click)="chatStore.selectVisionModel('')"
              >
                Default — the chat model, else the first that can see
              </button>
              <div class="sep"></div>
              @for (m of configStore.models(); track m.name) {
                <div class="opt-row" data-testid="vision-option-row">
                  <button
                    class="opt opt-toggle"
                    data-testid="vision-option"
                    [class.active]="chatStore.visionModelPick() === m.name"
                    (click)="chatStore.selectVisionModel(m.name)"
                  >
                    {{ m.name }}
                    @if (m.supportsImages) {
                      (👁)
                    }
                  </button>
                  <button
                    class="opt-edit"
                    data-testid="vision-edit"
                    title="Edit the model"
                    (click)="configStore.openModelDialog(m.name)"
                  >
                    ✎
                  </button>
                </div>
              }
              <div class="dropdown-hint">
                Writes what is on a picture: the caption of every 📎 you attach and the
                "Describe the picture" button. A model without 👁 cannot look.
              </div>
            </div>
          }
        </span>
        <button
          class="dots"
          data-testid="menu"
          (click)="$event.stopPropagation(); toggleMenu()"
          title="Menu"
        >
          ⋮
        </button>

        <!-- Main menu: the settings and the picture browser (the chat-management
             items live in the "Chat: <date>" menu) -->
        @if (menuOpen()) {
          <div class="dropdown">
          <button class="opt" data-testid="settings" (click)="configStore.openSettings()">
            Settings
          </button>
          <button class="opt" data-testid="picture-library" (click)="openPictureLibrary()">
            Pictures
          </button>
        </div>
      }
      </div>
    </header>
  `,
  styleUrl: './top-bar.scss',
})
export class TopBar implements OnInit, OnDestroy {
  readonly chatStore = inject(ChatStore);
  readonly configStore = inject(ConfigStore);

  readonly menuOpen = signal(false);
  readonly characterMenuOpen = signal(false);
  readonly userMenuOpen = signal(false);
  readonly modelMenuOpen = signal(false);
  readonly visionMenuOpen = signal(false);
  readonly chatMenuOpen = signal(false);
  readonly chatDotsOpen = signal(false);
  private readonly pictureLibrary = inject(PictureLibraryStore);
  private onDocClick = () => this.closeMenus();

  ngOnInit(): void {
    document.addEventListener('click', this.onDocClick);
  }

  ngOnDestroy(): void {
    document.removeEventListener('click', this.onDocClick);
  }

  closeMenus(): void {
    this.menuOpen.set(false);
    this.characterMenuOpen.set(false);
    this.userMenuOpen.set(false);
    this.modelMenuOpen.set(false);
    this.visionMenuOpen.set(false);
    this.chatMenuOpen.set(false);
    this.chatDotsOpen.set(false);
  }

  // The picture browser is a dialog, not a menu: opening it closes the menu it
  // was clicked from (the document click that would otherwise close the dialog
  // never happens — the click is stopped here).
  openPictureLibrary(): void {
    this.closeMenus();
    this.pictureLibrary.openLibrary();
  }

  // Opening one menu closes the others so they do not overlap.
  toggleMenu(): void {
    const open = !this.menuOpen();
    this.menuOpen.set(open);
    if (open) {
      this.characterMenuOpen.set(false);
      this.userMenuOpen.set(false);
      this.modelMenuOpen.set(false);
      this.visionMenuOpen.set(false);
      this.chatMenuOpen.set(false);
    }
  }
  toggleCharacterMenu(): void {
    const open = !this.characterMenuOpen();
    this.characterMenuOpen.set(open);
    if (open) {
      this.menuOpen.set(false);
      this.userMenuOpen.set(false);
      this.modelMenuOpen.set(false);
      this.visionMenuOpen.set(false);
      this.chatMenuOpen.set(false);
    }
  }
  toggleUserMenu(): void {
    const open = !this.userMenuOpen();
    this.userMenuOpen.set(open);
    if (open) {
      this.menuOpen.set(false);
      this.characterMenuOpen.set(false);
      this.modelMenuOpen.set(false);
      this.visionMenuOpen.set(false);
      this.chatMenuOpen.set(false);
    }
  }
  toggleModelMenu(): void {
    const open = !this.modelMenuOpen();
    this.modelMenuOpen.set(open);
    if (open) {
      this.menuOpen.set(false);
      this.characterMenuOpen.set(false);
      this.userMenuOpen.set(false);
      this.visionMenuOpen.set(false);
      this.chatMenuOpen.set(false);
    }
  }
  // The vision model menu (the 👁 next to the model chip).
  toggleVisionMenu(): void {
    const open = !this.visionMenuOpen();
    this.visionMenuOpen.set(open);
    if (open) {
      this.menuOpen.set(false);
      this.characterMenuOpen.set(false);
      this.userMenuOpen.set(false);
      this.modelMenuOpen.set(false);
      this.chatMenuOpen.set(false);
      this.chatDotsOpen.set(false);
    }
  }
  // The chat menu (New chat / the chat list) opens on the chat title in the
  // header.
  toggleChatMenu(): void {
    const open = !this.chatMenuOpen();
    this.chatMenuOpen.set(open);
    if (open) {
      this.menuOpen.set(false);
      this.characterMenuOpen.set(false);
      this.userMenuOpen.set(false);
      this.modelMenuOpen.set(false);
      this.visionMenuOpen.set(false);
      this.chatDotsOpen.set(false);
    }
  }
  // The chat-actions menu (⋮ next to the title): chat settings / clone / delete.
  toggleChatDots(): void {
    const open = !this.chatDotsOpen();
    this.chatDotsOpen.set(open);
    if (open) {
      this.menuOpen.set(false);
      this.characterMenuOpen.set(false);
      this.userMenuOpen.set(false);
      this.modelMenuOpen.set(false);
      this.visionMenuOpen.set(false);
      this.chatMenuOpen.set(false);
    }
  }

  // Shifts a participant in the queue. The click does not bubble to document
  // (the menu stays open), and the button is blurred: after the reorder the
  // rows shift under the stationary cursor, and the stuck highlight looked
  // like a highlight of the wrong arrow.
  moveParticipant(ev: Event, id: string, dir: -1 | 1): void {
    ev.stopPropagation();
    this.chatStore.moveCharacter(id, dir);
    (ev.currentTarget as HTMLElement).blur();
  }

  // The menu rows, in the chat's reply-priority order: the participants come
  // first (in that order), the characters not in the chat follow. So the
  // ↑/↓ arrows reorder the menu itself, not just the header.
  menuCharacters() {
    const ids = this.chatStore.chat()?.characterIds ?? [];
    const chars = this.configStore.characters();
    const byId = new Map<string, (typeof chars)[number]>();
    for (const c of chars) byId.set(c.id, c);
    const out: (typeof chars)[number][] = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (c) out.push(c);
    }
    for (const c of chars) {
      if (!ids.includes(c.id)) out.push(c);
    }
    return out;
  }

  // The chat rows in the list — pure functions from helpers.ts: the row shows
  // the title (the name, or the creation date), the hint says who is in it and
  // when it last spoke.
  chatTitle(cs: ChatSummary): string {
    return chatTitleOf(cs);
  }
  chatHint(cs: ChatSummary): string {
    return chatHintOf(this.configStore.characters(), this.configStore.users(), cs);
  }
  inChat(id: string): boolean {
    return this.chatStore.chat()?.characterIds.includes(id) ?? false;
  }
  isFirstParticipant(id: string): boolean {
    return this.chatStore.chat()?.characterIds[0] === id;
  }
  isLastParticipant(id: string): boolean {
    const ids = this.chatStore.chat()?.characterIds ?? [];
    return ids.length > 0 && ids[ids.length - 1] === id;
  }
  messageCount(n: number): string {
    return messageCountLabel(n);
  }
}
