import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ConfigStore } from '../../services/config-store';
import { UiStore } from '../../services/ui-store';
import { parseReasoningLevels } from '../../services/helpers';
import { ModelSampling } from '../../services/api';

// The model edit dialog: one llmModels entry (the name — the entry key, the
// display name and the internal id the chats reference) and the sampling block
// of that model, which lives here for the same reason the connection settings
// do: how a model should be read is a property of the model, not of one
// conversation. The item is taken from ConfigStore.entityDialog (a null name —
// creating a new one); save/delete/clone — the store actions. Delete and Clone
// exist in the edit mode only. A deleted/renamed model: the chats referencing it
// are re-attached to the first one on load (the backend does that).
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
      <div class="section">Sampling</div>
      <div class="hint">
        How this model is to pick its next token. It belongs to the model and not to a chat: a
        checkpoint is served with parameters its own weights were tuned for, and the number that
        reads well on one is slop on another. The block goes with every call this model makes — the
        replies, the picture captions, the picture plans. <b>Leave a field empty and nothing is sent
        for it</b>, so the server keeps its own default; that is the right answer until a specific
        problem asks for a number. Change one knob at a time.
      </div>
      <label class="field">
        <span>Temperature</span>
        <input
          class="grow"
          type="number"
          step="0.05"
          min="0"
          max="2"
          placeholder="empty = provider default"
          data-testid="model-temperature-input"
          [value]="temperature()"
          (input)="setTemperature($event)"
        />
      </label>
      <div class="hint">
        How flat the model is allowed to be when it chooses the next word. 1 leaves its own confidence
        alone. Below it (0.2–0.7) the likeliest word wins almost every time — consistent, on topic and
        dull. Above it (1.2–2) rare words get their chance — more surprising wording, and it drifts
        into nonsense sooner. Roleplay usually sits at 0.8–1.1. Prose too boring: raise it a little.
        Prose that wanders: lower it, or trim the tail with top-p / min-p instead.
      </div>
      <label class="field">
        <span>Top-p</span>
        <input
          class="grow"
          type="number"
          step="0.01"
          min="0"
          max="1"
          placeholder="empty = provider default"
          data-testid="model-topp-input"
          [value]="topP()"
          (input)="setTopP($event)"
        />
      </label>
      <div class="hint">
        Nucleus sampling: keeps the most likely words until their probabilities add up to this value
        and throws the rest away. 0.9 keeps the words carrying 90% of the probability; 0.5 cuts hard
        and is conservative; 1 leaves the whole list standing and lets temperature decide everything.
        It trims the tail without reordering anything, so it tames a wild model more gently than
        lowering the temperature does.
      </div>
      <label class="field">
        <span>Top-k</span>
        <input
          class="grow"
          type="number"
          step="1"
          min="0"
          max="1000"
          placeholder="empty = provider default"
          data-testid="model-topk-input"
          [value]="topK()"
          (input)="setTopK($event)"
        />
      </label>
      <div class="hint">
        Like top-p, but by count: at each step only this many best candidate words survive, whatever
        their probabilities. 40 is the common middle; 1 always takes the single likeliest word —
        grammatical, repetitive and dry; 200 barely limits the model. Providers that read it:
        llama.cpp, vLLM, Aphrodite, OpenRouter. One that does not simply ignores the field.
      </div>
      <label class="field">
        <span>Min-p</span>
        <input
          class="grow"
          type="number"
          step="0.01"
          min="0"
          max="1"
          placeholder="empty = provider default"
          data-testid="model-minp-input"
          [value]="minP()"
          (input)="setMinP($event)"
        />
      </label>
      <div class="hint">
        Drops any word whose probability is below this fraction of the best word's. 0.05 removes
        everything twenty times less likely than the leader, so even a hot temperature cannot reach
        into the junk at the end of the distribution; 0 turns it off. Unlike top-p it scales with the
        top candidate, which is why it is the usual knob for roleplay models — 0.02–0.1 keeps a warm
        model coherent without flattening it.
      </div>
      <label class="field">
        <span>Repetition penalty</span>
        <input
          class="grow"
          type="number"
          step="0.05"
          min="0"
          max="2"
          placeholder="empty = provider default"
          data-testid="model-reppen-input"
          [value]="repetitionPenalty()"
          (input)="setRepetitionPenalty($event)"
        />
      </label>
      <div class="hint">
        Raises the cost of a word the model has already used, so it stops echoing itself and its
        characters. 1 is no penalty; 1.1 is a light nudge; above 1.3 the model starts avoiding words
        it actually needs and the text turns awkward and evasive — too high a penalty is the usual
        reason a model begins to say the same thing in a new way every line. llama.cpp, vLLM,
        Aphrodite and OpenRouter read this field; a provider that only knows frequency_penalty /
        presence_penalty ignores it.
      </div>
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
  // The sampling block, one field per knob, all of them text: an empty field is
  // not a number, it is the decision to send nothing and let the server keep its
  // own default.
  readonly temperature = signal('');
  readonly topP = signal('');
  readonly topK = signal('');
  readonly minP = signal('');
  readonly repetitionPenalty = signal('');
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
        const s = m.sampling;
        this.temperature.set(ModelDialog.numField(s?.temperature));
        this.topP.set(ModelDialog.numField(s?.topP));
        this.topK.set(ModelDialog.numField(s?.topK));
        this.minP.set(ModelDialog.numField(s?.minP));
        this.repetitionPenalty.set(ModelDialog.numField(s?.repetitionPenalty));
      }
    }
  }

  // A stored number back into the field, an absent one into an empty field.
  private static numField(v: number | undefined): string {
    return v === undefined ? '' : String(v);
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
  setTemperature(e: Event): void {
    this.temperature.set((e.target as HTMLInputElement).value);
  }
  setTopP(e: Event): void {
    this.topP.set((e.target as HTMLInputElement).value);
  }
  setTopK(e: Event): void {
    this.topK.set((e.target as HTMLInputElement).value);
  }
  setMinP(e: Event): void {
    this.minP.set((e.target as HTMLInputElement).value);
  }
  setRepetitionPenalty(e: Event): void {
    this.repetitionPenalty.set((e.target as HTMLInputElement).value);
  }

  // Reads one sampling field: empty -> undefined (nothing is sent, the provider
  // default applies), a number -> the number, anything else -> null with the
  // banner naming the field. An empty field is never coerced to 0 — for these
  // knobs 0 is a real value with its own meaning.
  private readNum(field: string, raw: string): number | undefined | null {
    const t = raw.trim();
    if (!t) return undefined;
    const n = Number(t);
    if (!Number.isFinite(n)) {
      this.ui.error.set(`"${field}" must be a number — leave it empty for the provider's default`);
      return null;
    }
    return n;
  }

  // The whole block, or null when a field holds junk. All five empty is no
  // block at all: the entry then says nothing about sampling and every provider
  // default stands, which is what an untouched model should mean.
  private readSampling(): ModelSampling | undefined | null {
    const fields: Array<[keyof ModelSampling, string, string]> = [
      ['temperature', 'Temperature', this.temperature()],
      ['topP', 'Top-p', this.topP()],
      ['topK', 'Top-k', this.topK()],
      ['minP', 'Min-p', this.minP()],
      ['repetitionPenalty', 'Repetition penalty', this.repetitionPenalty()],
    ];
    const block: ModelSampling = {};
    for (const [key, label, raw] of fields) {
      const value = this.readNum(label, raw);
      if (value === null) return null; // the banner already named the field
      if (value !== undefined) block[key] = value;
    }
    return Object.keys(block).length > 0 ? block : undefined;
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
    const sampling = this.readSampling();
    if (sampling === null) return; // the banner already named the field that is not a number
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
      // All five fields empty — the whole block is omitted, so the entry keeps
      // the provider defaults rather than a half-empty set of guesses.
      sampling,
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
