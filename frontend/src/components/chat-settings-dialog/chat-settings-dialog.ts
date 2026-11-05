import { Component, OnInit, inject, signal } from '@angular/core';
import { ChatStore } from '../../services/chat-store';
import { formatTime } from '../../services/helpers';
import { UiStore } from '../../services/ui-store';

// The "Chat settings" dialog: the chat's own name (the header title), the
// per-chat sampling overrides sent to the provider with every reply
// (temperature / min-p / repetition penalty) and the system-prompt addition.
// An empty name = the chat is titled by its creation date; an empty sampling
// field = the parameter is not overridden (the provider default applies) and
// all three empty = the whole block is cleared server-side.
@Component({
  selector: 'app-chat-settings-dialog',
  template: `
    <div class="dialog-body" data-testid="chat-settings-dialog">
      <label class="field">
        <span>Name</span>
        <input
          class="grow"
          type="text"
          maxlength="80"
          [placeholder]="defaultTitle()"
          data-testid="chat-name-input"
          [value]="name()"
          (input)="setName($event)"
        />
      </label>
      <div class="dialog-hint">
        The title shown at the top. Left empty, the chat is titled by the date it was created.
      </div>
      <label class="field">
        <span>Temperature</span>
        <input
          class="grow"
          type="number"
          step="0.05"
          min="0"
          max="2"
          placeholder="provider default"
          data-testid="chat-temp-input"
          [value]="temperature()"
          (input)="setTemperature($event)"
        />
      </label>
      <label class="field">
        <span>Min-P</span>
        <input
          class="grow"
          type="number"
          step="0.01"
          min="0"
          max="1"
          placeholder="provider default"
          data-testid="chat-minp-input"
          [value]="minP()"
          (input)="setMinP($event)"
        />
      </label>
      <label class="field">
        <span>Repetition penalty</span>
        <input
          class="grow"
          type="number"
          step="0.05"
          min="0"
          max="2"
          placeholder="provider default"
          data-testid="chat-reppen-input"
          [value]="repetitionPenalty()"
          (input)="setRepetitionPenalty($event)"
        />
      </label>
      <label class="field col">
        <span>System prompt addition</span>
        <textarea
          class="grow"
          rows="4"
          placeholder="Extra instructions appended to the system prompt of this chat (style, quirks, rules…)"
          data-testid="chat-sysprompt-input"
          [value]="systemSuffix()"
          (input)="setSystemSuffix($event)"
        ></textarea>
      </label>
      <div class="dialog-hint">
        Leave a field empty to use the provider's default. The values are sent with every model call
        of this chat (temperature, min_p, repetition_penalty).
      </div>
      <label class="field col">
        <span>Picture style</span>
        <textarea
          class="grow"
          rows="2"
          placeholder="One look for every picture of this chat: photorealistic, 35mm, warm light…"
          data-testid="chat-style-input"
          [value]="stylePrompt()"
          (input)="setStylePrompt($event)"
        ></textarea>
      </label>
      <div class="dialog-hint">
        English, appended to every generation prompt of this chat, so its pictures look like one set
        instead of one per model idea.
      </div>
      <div class="dialog-actions">
        <span class="spacer"></span>
        <button class="btn" (click)="cancel()">Cancel</button>
        <button class="btn primary" data-testid="chat-settings-save" (click)="save()">Save</button>
      </div>
    </div>
  `,
  styleUrl: './chat-settings-dialog.scss',
})
export class ChatSettingsDialog implements OnInit {
  private readonly chatStore = inject(ChatStore);
  private ui = inject(UiStore);

  readonly name = signal('');
  readonly temperature = signal('');
  readonly minP = signal('');
  readonly repetitionPenalty = signal('');
  readonly systemSuffix = signal('');
  readonly stylePrompt = signal('');
  // The title an empty Name field stands for — the chat's creation date, shown
  // as the field's placeholder so the user sees what the header will say.
  readonly defaultTitle = signal('');

  ngOnInit(): void {
    const c = this.chatStore.chat();
    const s = c?.sampling;
    this.name.set(c?.name ?? '');
    this.defaultTitle.set(c ? formatTime(c.createdAt) : 'the creation date');
    this.temperature.set(s?.temperature !== undefined ? String(s.temperature) : '');
    this.minP.set(s?.minP !== undefined ? String(s.minP) : '');
    this.repetitionPenalty.set(s?.repetitionPenalty !== undefined ? String(s.repetitionPenalty) : '');
    this.systemSuffix.set(c?.systemSuffix ?? '');
    this.stylePrompt.set(c?.stylePrompt ?? '');
  }

  setName(e: Event): void {
    this.name.set((e.target as HTMLInputElement).value);
  }
  setTemperature(e: Event): void {
    this.temperature.set((e.target as HTMLInputElement).value);
  }
  setMinP(e: Event): void {
    this.minP.set((e.target as HTMLInputElement).value);
  }
  setRepetitionPenalty(e: Event): void {
    this.repetitionPenalty.set((e.target as HTMLInputElement).value);
  }
  setSystemSuffix(e: Event): void {
    this.systemSuffix.set((e.target as HTMLTextAreaElement).value);
  }
  setStylePrompt(e: Event): void {
    this.stylePrompt.set((e.target as HTMLTextAreaElement).value);
  }

  // Parses one field: empty -> undefined, garbage -> null (an error).
  private parse(v: string): number | undefined | null {
    const t = v.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  save(): void {
    const temp = this.parse(this.temperature());
    const minP = this.parse(this.minP());
    const rep = this.parse(this.repetitionPenalty());
    if (temp === null || minP === null || rep === null) {
      this.ui.error.set('The sampling parameters must be numbers');
      return;
    }
    this.chatStore.saveChatSettings({
      name: this.name(),
      sampling: { temperature: temp, minP: minP, repetitionPenalty: rep },
      systemSuffix: this.systemSuffix(),
      stylePrompt: this.stylePrompt(),
    });
  }

  cancel(): void {
    this.chatStore.closeChatSettings();
  }
}
