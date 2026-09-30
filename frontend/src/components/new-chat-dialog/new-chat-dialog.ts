import { Component, OnInit, inject, signal } from '@angular/core';
import { ConfigStore } from '../../services/config-store';
import { ChatStore } from '../../services/chat-store';

// The "New chat" dialog: the active persona + the character participants
// (multi-select, the selection order = the reply priority). The selection —
// local component state (the dialog is recreated on every open), the result
// goes to ChatStore.
@Component({
  selector: 'app-new-chat-dialog',
  template: `
    <div class="modal-body" data-testid="new-chat-dialog">
      <div class="dropdown-title">Your persona</div>
      @for (u of configStore.users(); track u.id) {
        <button
          class="opt"
          data-testid="new-user-option"
          [class.active]="userId() === u.id"
          (click)="userId.set(u.id)"
        >
          {{ userId() === u.id ? '●' : '○' }} {{ u.name }}
        </button>
      }
      <div class="dropdown-title">Characters (selection order = priority)</div>
      @for (c of configStore.characters(); track c.id) {
        <button
          class="opt"
          data-testid="new-char-option"
          [class.active]="characterIds().includes(c.id)"
          (click)="toggleCharacter(c.id)"
        >
          {{ characterIds().includes(c.id) ? '●' : '○' }} {{ c.name }}
        </button>
      }
      <div class="newchat-actions">
        <button
          class="send"
          data-testid="new-chat-confirm"
          (click)="chatStore.confirmNewChat({ userId: userId(), characterIds: characterIds() })"
        >
          Create
        </button>
      </div>
    </div>
  `,
  styleUrl: './new-chat-dialog.scss',
})
export class NewChatDialog implements OnInit {
  readonly chatStore = inject(ChatStore);
  readonly configStore = inject(ConfigStore);

  readonly userId = signal('');
  readonly characterIds = signal<string[]>([]);

  ngOnInit(): void {
    // The preselected ids — from the current chat; if there are none — the first in the list.
    const users = this.configStore.users();
    const chars = this.configStore.characters();
    const du = this.chatStore.newChatUserDefault();
    const dc = this.chatStore.newChatCharsDefault();
    this.userId.set(users.some((u) => u.id === du) ? du : (users[0]?.id ?? ''));
    const initial = dc.filter((id) => chars.some((c) => c.id === id));
    this.characterIds.set(initial.length > 0 ? initial : chars[0] ? [chars[0].id] : []);
  }

  // A click toggles the participation; the last selected one cannot be
  // deselected — the chat cannot be left without characters.
  toggleCharacter(id: string): void {
    const cur = this.characterIds();
    if (cur.includes(id)) {
      if (cur.length === 1) return;
      this.characterIds.set(cur.filter((x) => x !== id));
    } else {
      this.characterIds.set([...cur, id]);
    }
  }
}
