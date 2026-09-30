import { Component, ElementRef, ViewChild, effect, inject } from '@angular/core';
import { ChatStore } from '../../services/chat-store';
import { ImageStore } from '../../services/image-store';
import { avatarLetter } from '../../services/helpers';
import { MessageRow } from '../message-row/message-row';

// The history: the empty state, the message feed and the "typing…" indicator.
// The state — in ChatStore. The scroll to the bottom — an effect: we react
// to a real feed growth (a chat or message-count change) and to the indicator
// turning on. Editing a message changes the chat without a message-count
// change — saving it does not scroll the feed.
@Component({
  selector: 'app-message-list',
  imports: [MessageRow],
  template: `
    <div class="history" #history data-testid="history">
      @if (!chatStore.chat()?.messages.length) {
        <div class="empty">
          <div class="empty-name">{{ chatStore.character()?.name }}</div>
          @if (chatStore.character()?.description) {
            <div class="empty-desc">{{ chatStore.character()?.description }}</div>
          }
          <div class="empty-hint">Write a message to start the conversation</div>
        </div>
      }
      @for (m of chatStore.chat()?.messages; track m.id; let last = $last) {
        <app-message-row [message]="m" [isLast]="last" />
      }
      @if (chatStore.sending() || imageStore.generating()) {
        <!-- The row is deliberately without the .msg class: the e2e selector for
             the model's reply is .msg:not(.user):not(.error), and "typing…"
             must not fall under it. -->
        <div class="msg-row typing-row" data-testid="typing">
          <div class="avatar" aria-hidden="true">
            @if (chatStore.typingAvatarUrl(); as url) {
              <img [src]="url" alt="" />
            } @else {
              {{ typingLetter() }}
            }
          </div>
          <div class="typing-bubble">
            <span class="typing-label">{{ typingLabel() }}</span>
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
        </div>
      }
    </div>
  `,
  styleUrl: './message-list.scss',
})
export class MessageList {
  @ViewChild('history') private historyEl?: ElementRef<HTMLDivElement>;
  readonly chatStore = inject(ChatStore);
  readonly imageStore = inject(ImageStore);
  private lastScrollKey = '';

  constructor() {
    // Auto-scroll to the bottom: only when the feed really grew (a chat or
    // message-count change) or the "typing…" indicator appeared.
    // The signals are read before any condition so the subscription is not lost.
    effect(() => {
      const chat = this.chatStore.chat();
      const sending = this.chatStore.sending();
      const generating = this.imageStore.generating();
      const key = chat ? chat.id + ':' + chat.messages.length : '';
      if (key !== this.lastScrollKey || sending || generating) {
        this.lastScrollKey = key;
        this.scrollToBottom();
      }
    });
  }

  scrollToBottom(): void {
    setTimeout(() => {
      const el = this.historyEl?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }

  // The indicator label: while an image is being drawn — ImageStore's
  // "Generating image…", otherwise the replying character (ChatStore).
  typingLabel(): string {
    return this.imageStore.generating()
      ? 'Generating image…'
      : this.chatStore.typingLabel();
  }

  // The placeholder letter of the replying avatar; no author — a neutral sign.
  typingLetter(): string {
    const name = this.chatStore.typingName();
    return name ? avatarLetter(name) : '✻';
  }
}
