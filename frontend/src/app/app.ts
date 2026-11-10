import { Component, OnInit, inject, viewChild } from '@angular/core';
import { TopBar } from '../components/top-bar/top-bar';
import { MessageList } from '../components/message-list/message-list';
import { InputPanel } from '../components/input-panel/input-panel';
import { NewChatDialog } from '../components/new-chat-dialog/new-chat-dialog';
import { ChatSettingsDialog } from '../components/chat-settings-dialog/chat-settings-dialog';
import { Settings } from '../components/settings/settings';
import { CharacterDialog } from '../components/character-dialog/character-dialog';
import { UserDialog } from '../components/user-dialog/user-dialog';
import { ModelDialog } from '../components/model-dialog/model-dialog';
import { PictureDialog } from '../components/picture-dialog/picture-dialog';
import { PictureLibraryComponent } from '../components/picture-library/picture-library';
import { ImageLightbox } from '../components/image-lightbox/image-lightbox';
import { ConfigStore } from '../services/config-store';
import { ChatStore } from '../services/chat-store';
import { ImageStore } from '../services/image-store';
import { PictureLibraryStore } from '../services/picture-library-store';

@Component({
  selector: 'app-root',
  imports: [
    TopBar,
    MessageList,
    InputPanel,
    NewChatDialog,
    ChatSettingsDialog,
    Settings,
    CharacterDialog,
    UserDialog,
    ModelDialog,
    PictureDialog,
    PictureLibraryComponent,
    ImageLightbox,
  ],
  template: `
    <div class="app" (click)="onSideClick($event)">
      <div class="column">
        <app-top-bar />
        <app-message-list />
        <app-input-panel />
      </div>

      <!-- Every dialog below closes ONLY through its own ✕ and its own
           Cancel/Save buttons: a click on the backdrop does nothing. A dialog
           carries input the user typed (a caption, a prompt, a whole new
           character), and a click that lands a few pixels away from the window
           must not throw it out. -->

      <!-- Settings -->
      @if (configStore.settingsOpen()) {
        <div class="modal-backdrop">
          <div class="modal">
            <div class="modal-head">
              <span>Settings</span>
              <button class="icon-btn" (click)="configStore.closeSettings()">✕</button>
            </div>
            <app-settings></app-settings>
          </div>
        </div>
      }

      @if (chatStore.newChatOpen()) {
        <div class="modal-backdrop">
          <div class="modal modal-sm">
            <div class="modal-head">
              <span>New chat</span>
              <button class="icon-btn" (click)="chatStore.closeNewChat()" title="Close">✕</button>
            </div>
            <app-new-chat-dialog />
          </div>
        </div>
      }

      <!-- The "Chat settings" dialog: the per-chat sampling overrides
           (temperature / min-p / repetition penalty). -->
      @if (chatStore.chatSettingsOpen()) {
        <div class="modal-backdrop">
          <div class="modal modal-chat-settings">
            <div class="modal-head">
              <span>Chat settings</span>
              <button class="icon-btn" (click)="chatStore.closeChatSettings()" title="Close">✕</button>
            </div>
            <app-chat-settings-dialog />
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
              <div class="modal-backdrop">
                <div class="modal modal-md">
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
              <div class="modal-backdrop">
                <div class="modal modal-md">
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
              <div class="modal-backdrop">
                <div class="modal modal-md">
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

      <!-- The picture editor: opened by the ✎ of an image card — its prompt,
           its description, or the file it points at. -->
      @if (imageStore.pictureEdit()) {
        <div class="modal-backdrop">
          <div class="modal modal-md">
            <div class="modal-head">
              <span>Picture</span>
              <button class="icon-btn" (click)="imageStore.closePictureEdit()" title="Close">✕</button>
            </div>
            <app-picture-dialog />
          </div>
        </div>
      }

      <!-- The picture browser: every picture of the data folder with what the
           images table says about it, and the editor of one (its description,
           its prompt, its ID). Opened from the "⋮" menu. -->
      @if (pictureLibrary.open()) {
        <div class="modal-backdrop">
          <div class="modal modal-library">
            <div class="modal-head">
              <span>Pictures</span>
              <button class="icon-btn" data-testid="picture-library-close" title="Close" (click)="pictureLibrary.close()">✕</button>
            </div>
            <app-picture-library />
          </div>
        </div>
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
  // The picture browser dialog is opened from the top-bar menu and closed here,
  // so the shell holds the store the backdrop clicks.
  readonly pictureLibrary = inject(PictureLibraryStore);
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
