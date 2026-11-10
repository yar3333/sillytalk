import { Component, OnInit, inject, signal } from '@angular/core';
import {
  AppConfig,
  ComfyUiSettings,
  ImageGenerator,
  PictureLanguage,
  SdApiSettings,
  isComfyUiGenerator,
} from '../../services/api';
import { ConfigStore } from '../../services/config-store';
import { UiStore } from '../../services/ui-store';

// The "Settings" modal: the listen address and the image generators. The
// models, characters and personas are managed by their own edit dialogs
// (opened from the top-bar menus) — the sections were removed from here.
@Component({
  selector: 'app-settings',
  template: `
    @if (m()) {
      <div class="settings-body">
        <label class="field">
          <span>Address (host:port)</span>
          <input [value]="m()!.listen" (input)="setListen($event)" />
        </label>

        <div class="hint">
          Models, characters and personas are edited in the menus on the header (the name or the
          model chip) — with per-item dialogs.
        </div>

        <h3>Picture descriptions</h3>
        <label class="field">
          <span>Language</span>
          <!-- The list comes from the backend (it is the one that tells the
               model to write in that language), and [selected] goes on the
               option — [value] on the <select> would be set before the @for
               options exist and silently fail. -->
          <select data-testid="settings-picture-language" (change)="setPictureLanguage($event)">
            @for (lang of languages(); track lang.code) {
              <option [value]="lang.code" [selected]="lang.code === pictureLanguage()">
                {{ lang.name }}
              </option>
            }
          </select>
        </label>
        <div class="hint">
          The language of a picture's DESCRIPTION: the vision model's "Describe the picture", the
          caption of an attached picture and the caption the 📷 plan gives its own picture. The
          generation PROMPT is always English — that is what the generators read.
        </div>

        <h3>Picture prompt model</h3>
        <label class="field">
          <span>Prompt model</span>
          <!-- [selected] on the option: [value] on the <select> would be set
               before the @for options exist and silently fail. -->
          <select data-testid="settings-prompt-model" (change)="setPromptModel($event)">
            <option value="" [selected]="!m()!.imagePromptModel">Default (the chat model)</option>
            @for (model of configStore.models(); track model.name) {
              <option [value]="model.name" [selected]="model.name === m()!.imagePromptModel">
                {{ model.name }}
              </option>
            }
          </select>
        </label>
        <div class="hint">
          The model that plans the picture prompts — the 📷 "picture of my turn" and the editor's
          "From the chat". Leave it on Default to use the app's chat model (the model chip in the
          header); pick a strong one here to plan with it instead. Replies and picture captions use
          the chat model and the vision chip.
        </div>

        <h3>Image generation</h3>
        <div class="hint">
          Every enabled and available generator works in parallel — the jobs of one server are
          queued (one run at a time). A ComfyUI server running two models is two generators, one
          per model.
        </div>
        @for (g of generators(); track $index; let i = $index) {
          <div class="block">
            <div class="row">
              <span>{{ genKind(g) }}</span>
              <label class="chk">
                <input type="checkbox" [checked]="g.enabled !== false" (change)="setGenEnabled(i, $event)" />
                enabled
              </label>
              <button class="btn danger" (click)="removeGenerator(i)" style="margin-left: auto">✕</button>
            </div>
            @if (isComfy(g)) {
              <input class="full" placeholder="ComfyUI URL (http://127.0.0.1:8188)" [value]="g.url" (input)="setGenStr(i, 'url', $event)" />
              <div class="row">
                <label class="grow">
                  <span>model</span>
                  <!-- [selected] on the option: [value] on the <select> would be set
                       before the @for options exist and silently fail. -->
                  <select (change)="setGenStr(i, 'model', $event)">
                    @for (name of comfyModels(); track name) {
                      <option [value]="name" [selected]="name === g.model">{{ name }}</option>
                    }
                  </select>
                </label>
                <label><span>GPU device</span> <input [value]="g.device" (input)="setGenStr(i, 'device', $event)" /></label>
              </div>
              <div class="row">
                <label><span>width</span> <input type="number" [value]="g.width" (input)="setGenNum(i, 'width', $event)" /></label>
                <label><span>height</span> <input type="number" [value]="g.height" (input)="setGenNum(i, 'height', $event)" /></label>
              </div>
              <div class="hint">
                The workflow of {{ g.model }} runs on that server, so the server needs its models
                and the "comfyui-workflow-to-api-converter-endpoint" node. The picture size follows
                width × height here.
              </div>
            } @else {
              <input class="full" placeholder="URL (http://127.0.0.1:7860)" [value]="g.url" (input)="setGenStr(i, 'url', $event)" />
              <div class="row">
                <label><span>steps</span> <input type="number" [value]="g.steps" (input)="setGenNum(i, 'steps', $event)" /></label>
                <label><span>width</span> <input type="number" [value]="g.width" (input)="setGenNum(i, 'width', $event)" /></label>
                <label><span>height</span> <input type="number" [value]="g.height" (input)="setGenNum(i, 'height', $event)" /></label>
              </div>
              <label class="row"><span>denoising</span> <input type="number" step="0.05" [value]="g.denoisingStrength" (input)="setGenNum(i, 'denoisingStrength', $event)" /></label>
              <input class="full" placeholder="Negative prompt" [value]="g.negativePrompt" (input)="setGenStr(i, 'negativePrompt', $event)" />
            }
          </div>
        }
        <div class="row">
          <button class="btn" (click)="addComfyUi()">+ ComfyUI</button>
          <button class="btn" (click)="addSdApi()">+ SD API</button>
        </div>

        <div class="row actions">
          <button class="btn primary" (click)="save()">Save</button>
          <button class="btn" (click)="onCancel()">Cancel</button>
        </div>
      </div>
    }
  `,
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  // The config — from ConfigStore (editingConfig — a copy of the config).
  // The error banner — UiStore.
  readonly configStore = inject(ConfigStore);
  readonly ui = inject(UiStore);

  m = signal<AppConfig | null>(null);

  ngOnInit(): void {
    // editingConfig — a copy of the config made in configStore.openSettings().
    const cfg = this.configStore.editingConfig();
    if (cfg) {
      this.m.set(JSON.parse(JSON.stringify(cfg)) as AppConfig);
    }
  }

  // Handlers: casts and Number cannot be written in the template — done in TS.
  private setListen(e: Event): void {
    const c = this.m()!;
    c.listen = (e.target as HTMLInputElement).value;
    this.m.set({ ...c });
  }

  // The global picture-prompt model. An empty pick is a real choice — the chat's
  // own model plans again — so the field is dropped rather than stored empty.
  private setPromptModel(e: Event): void {
    const c = this.m()!;
    const name = (e.target as HTMLSelectElement).value;
    if (name) c.imagePromptModel = name;
    else delete c.imagePromptModel;
    this.m.set({ ...c });
  }

  // ---- picture descriptions (the language of the captions) ----
  // The languages the backend can ask a model to write in; the pick stores the
  // code, and the name travels with it, so the prompt and the list cannot
  // disagree.
  languages(): PictureLanguage[] {
    return this.configStore.pictureLanguages();
  }
  // English is what a config without the field means.
  pictureLanguage(): string {
    return this.m()?.pictureLanguage || 'en';
  }
  private setPictureLanguage(e: Event): void {
    const c = this.m();
    if (!c) return;
    c.pictureLanguage = (e.target as HTMLSelectElement).value;
    this.m.set({ ...c });
  }

  // ---- image generators (imageGenerators: ImageGenerator[]) ----
  generators(): ImageGenerator[] {
    return this.m()?.imageGenerators ?? [];
  }
  // The models a ComfyUI generator can be pointed at — from the backend, which
  // knows the workflows the app ships.
  comfyModels(): string[] {
    return this.configStore.comfyUiModels();
  }
  genKind(g: ImageGenerator): string {
    return isComfyUiGenerator(g) ? `ComfyUI — ${g.model}` : 'SD API';
  }
  // Type guards must be component methods: narrowing imported functions
  // in the template does not work.
  private isComfy(g: ImageGenerator): g is ComfyUiSettings {
    return isComfyUiGenerator(g);
  }
  // An <input> and a <select> both hand over their value the same way, so one
  // setter covers the text fields and the model pick.
  private setGenStr(i: number, key: string, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i] as unknown as Record<string, unknown>;
    if (!gen) return;
    gen[key] = (e.target as HTMLInputElement).value;
    this.m.set({ ...c });
  }
  private setGenNum(i: number, key: string, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i] as unknown as Record<string, unknown>;
    if (!gen) return;
    gen[key] = Number((e.target as HTMLInputElement).value);
    this.m.set({ ...c });
  }
  private setGenEnabled(i: number, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!gen) return;
    gen.enabled = (e.target as HTMLInputElement).checked;
    this.m.set({ ...c });
  }
  private removeGenerator(i: number): void {
    const c = this.m()!;
    const imageGenerators = [...c.imageGenerators];
    imageGenerators.splice(i, 1);
    this.m.set({ ...c, imageGenerators });
  }
  private addComfyUi(): void {
    const c = this.m()!;
    const models = this.comfyModels();
    const g: ComfyUiSettings = {
      kind: 'comfyui',
      url: 'http://127.0.0.1:8188',
      // the first model the app can draw with; the pick offers the rest
      model: models[0] ?? 'qwen-image-2.1',
      device: 'cuda:0',
      width: 1328,
      height: 1328,
      enabled: true,
    };
    this.m.set({ ...c, imageGenerators: [...c.imageGenerators, g] });
  }
  private addSdApi(): void {
    const c = this.m()!;
    const g: SdApiSettings = {
      kind: 'sdapi',
      url: 'http://127.0.0.1:7860',
      steps: 30,
      width: 768,
      height: 768,
      denoisingStrength: 0.75,
      negativePrompt: '',
      enabled: true,
    };
    this.m.set({ ...c, imageGenerators: [...c.imageGenerators, g] });
  }

  save(): void {
    if (this.m()) {
      this.configStore.saveSettings(this.m()!);
    }
  }

  onCancel(): void {
    this.configStore.settingsOpen.set(false);
  }
}
