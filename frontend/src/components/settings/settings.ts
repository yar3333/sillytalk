import { Component, OnInit, inject, signal } from '@angular/core';
import {
  AppConfig,
  ImageGenerator,
  LocalProgramSettings,
  SdApiSettings,
  isLocalGenerator,
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

        <h3>Image generation</h3>
        <div class="hint">At startup the methods are tried in list order — the first available one is used.</div>
        @for (g of generators(); track $index; let i = $index) {
          <div class="block">
            <div class="row">
              <span>{{ genKind(g) }}</span>
              <button class="btn danger" (click)="removeGenerator(i)">✕</button>
            </div>
            @if (isLocal(g)) {
              <input class="full" placeholder="Command (e.g. python)" [value]="g.command" (input)="setGenStr(i, 'command', $event)" />
              <div class="args">
                @for (a of g.args; track $index; let k = $index) {
                  <div class="row">
                    <input class="grow" [value]="a" (input)="setGenArg(i, k, $event)" />
                    <button class="btn danger" (click)="removeGenArg(i, k)">✕</button>
                  </div>
                }
              </div>
              <button class="btn" (click)="addGenArg(i)">+ argument</button>
              <label class="row"><span>max. references (0 = unlimited)</span> <input type="number" [value]="g.maxInputImages" (input)="setGenNum(i, 'maxInputImages', $event)" /></label>
              <div class="hint">Placeholders: {{ '{prompt}' }}, {{ '{absolutePathsToInputImages}' }}, {{ '{absolutePathToOutputImage}' }}</div>
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
          <button class="btn" (click)="addSdApi()">+ SD API</button>
          <button class="btn" (click)="addLocal()">+ local program</button>
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

  // ---- image generators (imageGenerators: ImageGenerator[]) ----
  generators(): ImageGenerator[] {
    return this.m()?.imageGenerators ?? [];
  }
  genKind(g: ImageGenerator): string {
    return isLocalGenerator(g) ? 'local program' : 'SD API';
  }
  // Type guards must be component methods: narrowing imported functions
  // in the template does not work.
  private isLocal(g: ImageGenerator): g is LocalProgramSettings {
    return isLocalGenerator(g);
  }
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
  private setGenArg(i: number, k: number, e: Event): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!gen || !isLocalGenerator(gen)) return;
    gen.args[k] = (e.target as HTMLInputElement).value;
    this.m.set({ ...c });
  }
  private addGenArg(i: number): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!gen || !isLocalGenerator(gen)) return;
    gen.args = [...gen.args, ''];
    this.m.set({ ...c });
  }
  private removeGenArg(i: number, k: number): void {
    const c = this.m()!;
    const gen = c.imageGenerators[i];
    if (!gen || !isLocalGenerator(gen)) return;
    gen.args = gen.args.filter((_, idx) => idx !== k);
    this.m.set({ ...c });
  }
  private removeGenerator(i: number): void {
    const c = this.m()!;
    const imageGenerators = [...c.imageGenerators];
    imageGenerators.splice(i, 1);
    this.m.set({ ...c, imageGenerators });
  }
  private addSdApi(): void {
    const c = this.m()!;
    const g: SdApiSettings = {
      url: 'http://127.0.0.1:7860',
      steps: 30,
      width: 768,
      height: 768,
      denoisingStrength: 0.75,
      negativePrompt: '',
    };
    this.m.set({ ...c, imageGenerators: [...c.imageGenerators, g] });
  }
  private addLocal(): void {
    const c = this.m()!;
    const g: LocalProgramSettings = {
      command: '',
      args: ['--prompt', '{prompt}', '--input', '{absolutePathsToInputImages}', '--output', '{absolutePathToOutputImage}'],
      maxInputImages: 0,
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
