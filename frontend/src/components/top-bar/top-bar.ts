import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ChatSummary } from '../../services/api';
import { ConfigStore } from '../../services/config-store';
import { ChatStore } from '../../services/chat-store';
import {
  chatLabelOf,
  chatTimeOf,
  chatUserLabelOf,
  messageCountLabel,
} from '../../services/helpers';

// The header: character / persona (dropdown menus), date and model, the "⋮" menu.
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
                  <div class="opt-row" data-testid="char-option" [class.active]="inChat(c.id)">
                    <button
                      class="opt opt-toggle"
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

      <!-- The chat menu: the "Chat: <date>" label opens it (the chat-management
           items moved out of the ⋮ menu). It is wider than the usual dropdown. -->
      <span
        class="chat-date"
        data-testid="chat-date"
        title="Chat menu"
        (click)="$event.stopPropagation(); toggleChatMenu()"
      >
        {{ chatStore.lastTime() ? 'Chat: ' + chatStore.lastTime() : 'Chat' }}
        @if (chatMenuOpen()) {
          <div class="dropdown chat-dropdown">
            <button class="opt" data-testid="new-chat" (click)="chatStore.newChat()">New chat</button>
            <button
              class="opt danger"
              data-testid="delete-chat"
              (click)="chatStore.deleteCurrentChat()"
            >
              Delete chat
            </button>
            <div class="dropdown-title">Chats</div>
            <div class="chat-list">
              @for (cs of chatStore.chats(); track cs.id) {
                <button
                  class="opt"
                  [class.active]="chatStore.chat()?.id === cs.id"
                  (click)="chatStore.openChat(cs.id)"
                >
                  <span class="chat-item-name">
                    <span class="chat-item-char">{{ chatLabel(cs) }}</span>
                    <span class="who-sep">/</span>
                    <span class="chat-item-user">{{ chatUserLabel(cs) }}</span>
                  </span>
                  <span class="chat-item-meta"
                    >{{ chatTime(cs) ? chatTime(cs) + ' · ' : '' }}{{
                      messageCount(cs.messageCount)
                    }}</span
                  >
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
                    [class.active]="chatStore.chat()?.modelId === m.name"
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
        <button
          class="dots"
          data-testid="menu"
          (click)="$event.stopPropagation(); toggleMenu()"
          title="Menu"
        >
          ⋮
        </button>

        <!-- Main menu: only Settings now (the chat-management items moved to
             the "Chat: <date>" menu) -->
        @if (menuOpen()) {
          <div class="dropdown">
          <button class="opt" data-testid="settings" (click)="configStore.openSettings()">
            Settings
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
  readonly chatMenuOpen = signal(false);
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
    this.chatMenuOpen.set(false);
  }

  // Opening one menu closes the others so they do not overlap.
  toggleMenu(): void {
    const open = !this.menuOpen();
    this.menuOpen.set(open);
    if (open) {
      this.characterMenuOpen.set(false);
      this.userMenuOpen.set(false);
      this.modelMenuOpen.set(false);
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
      this.chatMenuOpen.set(false);
    }
  }
  // The chat menu (New chat / Delete / the chat list) opens on the "Chat:
  // <date>" label in the header.
  toggleChatMenu(): void {
    const open = !this.chatMenuOpen();
    this.chatMenuOpen.set(open);
    if (open) {
      this.menuOpen.set(false);
      this.characterMenuOpen.set(false);
      this.userMenuOpen.set(false);
      this.modelMenuOpen.set(false);
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

  // The chat labels in the list — pure functions from helpers.ts.
  chatLabel(cs: ChatSummary): string {
    return chatLabelOf(this.configStore.characters(), cs);
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
  chatUserLabel(cs: ChatSummary): string {
    return chatUserLabelOf(this.configStore.users(), cs);
  }
  chatTime(cs: ChatSummary): string {
    return chatTimeOf(cs);
  }
  messageCount(n: number): string {
    return messageCountLabel(n);
  }
}
