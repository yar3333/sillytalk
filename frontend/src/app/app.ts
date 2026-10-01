import { Component, OnInit, inject, viewChild } from '@angular/core';
import { TopBar } from '../components/top-bar/top-bar';
import { MessageList } from '../components/message-list/message-list';
import { InputPanel } from '../components/input-panel/input-panel';
import { NewChatDialog } from '../components/new-chat-dialog/new-chat-dialog';
import { Settings } from '../components/settings/settings';
import { CharacterDialog } from '../components/character-dialog/character-dialog';
import { UserDialog } from '../components/user-dialog/user-dialog';
import { ModelDialog } from '../components/model-dialog/model-dialog';
import { ImageLightbox } from '../components/image-lightbox/image-lightbox';
import { ConfigStore } from '../services/config-store';
import { ChatStore } from '../services/chat-store';
import { ImageStore } from '../services/image-store';

@Component({
  selector: 'app-root',
  imports: [
    TopBar,
    MessageList,
    InputPanel,
    NewChatDialog,
    Settings,
    CharacterDialog,
    UserDialog,
    ModelDialog,
    ImageLightbox,
  ],
  template: `
    <div class="app" (click)="onSideClick($event)">
      <div class="column">
        <app-top-bar />
        <app-message-list />
        <app-input-panel />
      </div>

      <!-- Settings -->
      @if (configStore.settingsOpen()) {
        <div class="modal-backdrop" (click)="configStore.closeSettings()">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="modal-head">
              <span>Settings</span>
              <button class="icon-btn" (click)="configStore.closeSettings()">✕</button>
            </div>
            <app-settings></app-settings>
          </div>
        </div>
      }

      @if (chatStore.newChatOpen()) {
        <div class="modal-backdrop" (click)="chatStore.closeNewChat()">
          <div class="modal modal-sm" (click)="$event.stopPropagation()">
            <div class="modal-head">
              <span>New chat</span>
              <button class="icon-btn" (click)="chatStore.closeNewChat()" title="Close">✕</button>
            </div>
            <app-new-chat-dialog />
          </div>
        </div>
      }

      <!-- The entity edit dialogs (character / persona / model), opened from
           the top-bar menus; the state — ConfigStore.entityDialog. The
           single-item @for tracks the item id/name: when the item changes
           (e.g. "Clone" switches the dialog to the copy) the tracked view is
           destroyed and recreated, so the dialog re-initializes from the
           store. -->
      @let entityDlg = configStore.entityDialog();
      @switch (entityDlg?.kind) {
        @case ('character') {
          @if (entityDlg !== null && entityDlg.kind === 'character') {
            @for (dlg of [entityDlg]; track dlg.id) {
              <div class="modal-backdrop" (click)="configStore.closeEntityDialog()">
                <div class="modal modal-md" (click)="$event.stopPropagation()">
                  <div class="modal-head">
                    <span>Character</span>
                    <button class="icon-btn" (click)="configStore.closeEntityDialog()" title="Close">✕</button>
                  </div>
                  <app-character-dialog />
                </div>
              </div>
            }
          }
        }
        @case ('user') {
          @if (entityDlg !== null && entityDlg.kind === 'user') {
            @for (dlg of [entityDlg]; track dlg.id) {
              <div class="modal-backdrop" (click)="configStore.closeEntityDialog()">
                <div class="modal modal-md" (click)="$event.stopPropagation()">
                  <div class="modal-head">
                    <span>Persona</span>
                    <button class="icon-btn" (click)="configStore.closeEntityDialog()" title="Close">✕</button>
                  </div>
                  <app-user-dialog />
                </div>
              </div>
            }
          }
        }
        @case ('model') {
          @if (entityDlg !== null && entityDlg.kind === 'model') {
            @for (dlg of [entityDlg]; track dlg.name) {
              <div class="modal-backdrop" (click)="configStore.closeEntityDialog()">
                <div class="modal modal-md" (click)="$event.stopPropagation()">
                  <div class="modal-head">
                    <span>Model</span>
                    <button class="icon-btn" (click)="configStore.closeEntityDialog()" title="Close">✕</button>
                  </div>
                  <app-model-dialog />
                </div>
              </div>
            }
          }
        }
      }

      <!-- The image lightbox: opened when the user clicks an image in the chat. -->
      <app-image-lightbox />
    </div>
  `,
  styleUrl: './app.scss',
})
export class App implements OnInit {
  readonly chatStore = inject(ChatStore);
  readonly configStore = inject(ConfigStore);
  // Exposed for the unit tests (the template uses the child components, which
  // inject ImageStore themselves).
  readonly imageStore = inject(ImageStore);
  private readonly messageList = viewChild(MessageList);

  ngOnInit(): void {
    this.chatStore.bootstrap();
  }

  // A click on the side fields around the central column (target === .app)
  // scrolls the history down; clicks inside the column and in the modals — no.
  onSideClick(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.messageList()?.scrollToBottom();
  }
}
