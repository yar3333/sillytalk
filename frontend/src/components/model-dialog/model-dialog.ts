import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ConfigStore } from '../../services/config-store';
import { UiStore } from '../../services/ui-store';
import { parseReasoningLevels } from '../../services/helpers';

// The model edit dialog: one llmModels entry (the name — the entry key, the
// display name and the internal id the chats reference). The item is taken
// from ConfigStore.entityDialog (a null name — creating a new one);
// save/delete/clone — the store actions. Delete and Clone exist in the edit
// mode only. A deleted/renamed model: the chats referencing it are
// re-attached to the first one on load (the backend does that).
@Component({
  selector: 'app-model-dialog',
  template: `
    <div class="dialog-body" data-testid="model-dialog">
      <label class="field">
        <span>Name</span>
        <input
          class="grow"
          data-testid="model-name-input"
          placeholder="Name (llmModels key)"
          [value]="name()"
          (input)="setName($event)"
        />
      </label>
      <label class="field">
        <span>id</span>
        <input
          class="grow"
          data-testid="model-id-input"
          placeholder="id (sent to the provider)"
          [value]="id()"
          (input)="setId($event)"
        />
      </label>
      <label class="field">
        <span>Base URL</span>
        <input
          class="grow"
          placeholder="Base URL (…/v1)"
          [value]="baseUrl()"
          (input)="setBaseUrl($event)"
        />
      </label>
      <div class="row2">
        <input
          class="grow"
          placeholder="API key"
          [value]="apiKey()"
          (input)="setApiKey($event)"
        />
        <input
          class="grow"
          placeholder="env key (variable name)"
          [value]="envKey()"
          (input)="setEnvKey($event)"
        />
      </div>
      <label class="field">
        <span>Context size</span>
        <input
          class="grow"
          type="number"
          [value]="contextSize()"
          (input)="setContextSize($event)"
        />
      </label>
      <label class="field">
        <span>Reasoning levels</span>
        <input
          class="grow"
          data-testid="model-reasoning-levels-input"
          placeholder="low, medium, high, xhigh, max"
          [value]="reasoningLevelsText()"
          (input)="setReasoningLevelsText($event)"
        />
      </label>
      <label class="field">
        <span>Reasoning</span>
        <!-- [selected] on the option: [value] on the <select> would be set
             before the @for options exist and silently fail. -->
        <select class="grow" data-testid="model-reasoning-select" (change)="setReasoning($event)">
          @for (opt of reasoningOptions(); track opt.value) {
            <option [value]="opt.value" [selected]="opt.value === reasoningValue()">{{ opt.label }}</option>
          }
        </select>
      </label>
      <label class="chk">
        <input type="checkbox" [checked]="supportsImages()" (change)="setSupportsImages($event)" />
        sees images
      </label>
      <div class="dialog-actions">
        @if (!isNew()) {
          <button class="btn danger" data-testid="model-delete" (click)="remove()">Delete</button>
        }
        <span class="spacer"></span>
        @if (!isNew()) {
          <button class="btn" data-testid="model-clone" (click)="clone()">Clone</button>
        }
        <button class="btn" (click)="cancel()">Cancel</button>
        <button class="btn primary" data-testid="model-save" (click)="save()">Save</button>
      </div>
    </div>
  `,
  styleUrl: './model-dialog.scss',
})
export class ModelDialog implements OnInit {
  readonly configStore = inject(ConfigStore);
  private ui = inject(UiStore);

  readonly name = signal('');
  readonly id = signal('');
  readonly baseUrl = signal('');
  readonly apiKey = signal('');
  readonly envKey = signal('');
  readonly contextSize = signal(8192);
  readonly supportsImages = signal(false);
  // The reasoning levels as typed (comma separated); empty — the default set.
  readonly reasoningLevelsText = signal('');
  // The selected reasoning level; false — off.
  readonly reasoning = signal<string | false>(false);
  readonly isNew = signal(true);
  private oldName = '';

  // The <select> options: "Off" + the levels from the text input.
  readonly reasoningOptions = computed(() => [
    { value: 'off', label: 'Off' },
    ...parseReasoningLevels(this.reasoningLevelsText()).map((l) => ({ value: l, label: l })),
  ]);

  // The <select>/<option> value of the current level ('off' when disabled).
  readonly reasoningValue = computed(() => (this.reasoning() === false ? 'off' : this.reasoning()));

  ngOnInit(): void {
    const dlg = this.configStore.entityDialog();
    if (dlg?.kind === 'model' && dlg.name) {
      this.oldName = dlg.name;
      this.isNew.set(false);
      const m = this.configStore.models().find((x) => x.name === dlg.name);
      if (m) {
        this.name.set(m.name);
        this.id.set(m.id);
        this.baseUrl.set(m.baseUrl);
        this.apiKey.set(m.apiKey ?? '');
        this.envKey.set(m.envKey ?? '');
        this.contextSize.set(m.contextSize);
        this.supportsImages.set(m.supportsImages);
        this.reasoningLevelsText.set((m.reasoningLevels ?? []).join(', '));
        this.reasoning.set(m.reasoning ?? false);
      }
    }
  }

  setName(e: Event): void {
    this.name.set((e.target as HTMLInputElement).value);
  }
  setId(e: Event): void {
    this.id.set((e.target as HTMLInputElement).value);
  }
  setBaseUrl(e: Event): void {
    this.baseUrl.set((e.target as HTMLInputElement).value);
  }
  setApiKey(e: Event): void {
    this.apiKey.set((e.target as HTMLInputElement).value);
  }
  setEnvKey(e: Event): void {
    this.envKey.set((e.target as HTMLInputElement).value);
  }
  setContextSize(e: Event): void {
    const n = Number((e.target as HTMLInputElement).value);
    this.contextSize.set(Number.isFinite(n) && n > 0 ? n : 8192);
  }
  setSupportsImages(e: Event): void {
    this.supportsImages.set((e.target as HTMLInputElement).checked);
  }
  setReasoningLevelsText(e: Event): void {
    this.reasoningLevelsText.set((e.target as HTMLInputElement).value);
    // A level that disappeared from the list cannot stay selected.
    const level = this.reasoning();
    if (level !== false && !parseReasoningLevels(this.reasoningLevelsText()).includes(level)) {
      this.reasoning.set(false);
    }
  }
  setReasoning(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    this.reasoning.set(value === 'off' ? false : value);
  }

  save(): void {
    const nm = this.name().trim();
    if (!nm) {
      this.ui.error.set('The name cannot be empty');
      return;
    }
    const taken = this.configStore.models().some((m) => m.name === nm && nm !== this.oldName);
    if (taken) {
      this.ui.error.set('A model with this name already exists');
      return;
    }
    const levels = parseReasoningLevels(this.reasoningLevelsText());
    const level = this.reasoning();
    this.configStore.saveModel(this.isNew() ? null : this.oldName, nm, {
      id: this.id().trim(),
      baseUrl: this.baseUrl().trim(),
      apiKey: this.apiKey().trim() || undefined,
      envKey: this.envKey().trim() || undefined,
      contextSize: this.contextSize(),
      supportsImages: this.supportsImages(),
      reasoning: level !== false && levels.includes(level) ? level : false,
      // An empty list is omitted — the backend applies the default set.
      reasoningLevels: this.reasoningLevelsText().trim() ? levels : undefined,
    });
    this.configStore.closeEntityDialog();
  }

  cancel(): void {
    this.configStore.closeEntityDialog();
  }

  remove(): void {
    const nm = this.name().trim() || this.oldName;
    if (!confirm(`Delete the model "${nm}"? The chats using it fall back to the first one.`)) {
      return;
    }
    this.configStore.deleteModel(this.oldName);
    this.configStore.closeEntityDialog();
  }

  clone(): void {
    this.configStore.cloneModel(this.oldName);
    this.configStore.closeEntityDialog();
  }
}
