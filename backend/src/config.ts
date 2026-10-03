import fs from 'fs';
import os from 'os';
import path from 'path';
import { Config, ImageGenerator, LlmModel, Model } from './types';

// The data root is ~/.config/sillytalk. Overridden by environment variables
// (for e2e tests and relocatable installs): SILLYTALK_DATA_DIR — the whole
// root, SILLYTALK_CHATS_DIR / SILLYTALK_CHARACTERS_DIR / SILLYTALK_USERS_DIR
// — individual folders, SILLYTALK_LISTEN — the listen address on top of
// config.json.
export const CONFIG_DIR =
  process.env.SILLYTALK_DATA_DIR || path.join(os.homedir(), '.config', 'sillytalk');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const CHATS_DIR =
  process.env.SILLYTALK_CHATS_DIR || path.join(CONFIG_DIR, 'chats');

export function expandPath(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// A character is a ~/.config/sillytalk/characters/<id>/ folder:
// the folder name is the character ID, character.json holds name and description.
export function charactersDir(): string {
  return process.env.SILLYTALK_CHARACTERS_DIR || path.join(CONFIG_DIR, 'characters');
}

export function characterDir(id: string, root: string = charactersDir()): string {
  return path.join(root, id);
}

export function characterFile(id: string, root: string = charactersDir()): string {
  return path.join(characterDir(id, root), 'character.json');
}

// The path to a character's photo folder is always fixed: ~/.config/sillytalk/characters/<id>/photos
export function characterPhotosDir(id: string, root: string = charactersDir()): string {
  return path.join(characterDir(id, root), 'photos');
}

// A user is a ~/.config/sillytalk/users/<id>/ folder:
// the folder name is the user ID, user.json holds name and persona description.
export function usersDir(): string {
  return process.env.SILLYTALK_USERS_DIR || path.join(CONFIG_DIR, 'users');
}

export function userDir(id: string, root: string = usersDir()): string {
  return path.join(root, id);
}

export function userFile(id: string, root: string = usersDir()): string {
  return path.join(userDir(id, root), 'user.json');
}

// The listen address "host:port" -> { host, port } (port defaults to 3210).
// Supports IPv6 in brackets ([::1]:3210) as well as plain ":3210" / "3210".
export function parseListen(listen: string): { host: string; port: number } {
  const value = (listen ?? '').trim();
  if (!value) return { host: '0.0.0.0', port: 3210 };
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close !== -1) {
      const host = value.slice(1, close);
      const port = parseInt(value.slice(close + 1).replace(/^:/, ''), 10);
      return { host, port: Number.isFinite(port) && port > 0 ? port : 3210 };
    }
  }
  const idx = value.lastIndexOf(':');
  if (idx === -1) return { host: value, port: 3210 };
  const host = value.slice(0, idx) || '0.0.0.0';
  const port = parseInt(value.slice(idx + 1), 10);
  return { host, port: Number.isFinite(port) && port > 0 ? port : 3210 };
}

export function defaultConfig(): Config {
  return {
    listen: '0.0.0.0:3210',
    llmModels: {
      default: {
        id: 'default',
        baseUrl: 'http://127.0.0.1:8000/v1',
        apiKey: '',
        contextSize: 8192,
        supportsImages: false,
      },
    },
    imageGenerators: [],
  };
}

// The provider key: envKey (environment variable) takes priority over apiKey.
export function resolveApiKey(model: Pick<LlmModel, 'apiKey' | 'envKey'>): string {
  if (model.envKey) {
    const v = process.env[model.envKey];
    if (v) return v;
  }
  return model.apiKey ?? '';
}

// The model list as a flat array: llmModels key -> Model.name.
export function listModels(config: Config): Model[] {
  return Object.entries(config.llmModels).map(([name, m]) => ({ name, ...m }));
}

// Strips // and /* */ comments from JSONC, leaving the ones inside strings
// untouched (otherwise values like https://... URLs would break).
function stripJsoncComments(raw: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function normalizeLlmModels(raw: unknown, def: Config): Record<string, LlmModel> {
  const result: Record<string, LlmModel> = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const [name, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Partial<LlmModel>;
    result[name] = {
      id: typeof v.id === 'string' ? v.id : '',
      baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : '',
      apiKey: typeof v.apiKey === 'string' ? v.apiKey : undefined,
      envKey: typeof v.envKey === 'string' ? v.envKey : undefined,
      contextSize: typeof v.contextSize === 'number' ? v.contextSize : 8192,
      supportsImages: typeof v.supportsImages === 'boolean' ? v.supportsImages : false,
    };
  }
  return Object.keys(result).length > 0 ? result : def.llmModels;
}

function normalizeGenerators(raw: unknown): ImageGenerator[] {
  if (!Array.isArray(raw)) return [];
  const result: ImageGenerator[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const g = entry as Record<string, unknown>;
    // enabled defaults to true — a generator without the field is on.
    const enabled = typeof g.enabled === 'boolean' ? g.enabled : true;
    if (typeof g.command === 'string') {
      result.push({
        command: g.command,
        args: Array.isArray(g.args) ? g.args.map((a) => String(a)) : [],
        maxInputImages: typeof g.maxInputImages === 'number' ? g.maxInputImages : 0,
        enabled,
      });
    } else if (typeof g.url === 'string') {
      result.push({
        url: g.url,
        steps: typeof g.steps === 'number' ? g.steps : 30,
        width: typeof g.width === 'number' ? g.width : 768,
        height: typeof g.height === 'number' ? g.height : 768,
        denoisingStrength: typeof g.denoisingStrength === 'number' ? g.denoisingStrength : 0.75,
        negativePrompt: typeof g.negativePrompt === 'string' ? g.negativePrompt : '',
        enabled,
      });
    }
  }
  return result;
}

export function loadConfig(): Config {
  const config = loadConfigFromFile();
  // The listen address from the environment wins over config.json (e2e
  // starts an isolated server on its own port).
  if (process.env.SILLYTALK_LISTEN) config.listen = process.env.SILLYTALK_LISTEN;
  return config;
}

function loadConfigFromFile(): Config {
  if (!fs.existsSync(CONFIG_FILE)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    // The config may be written as JSONC (with comments) — they are stripped
    // before parsing. Legacy fields (port, models, userId, imageGeneration,
    // characters) are simply ignored.
    const parsed = JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
    const def = defaultConfig();
    return {
      listen:
        typeof parsed.listen === 'string' && parsed.listen ? parsed.listen : def.listen,
      llmModels: normalizeLlmModels(parsed.llmModels, def),
      imageGenerators: normalizeGenerators(parsed.imageGenerators),
    };
  } catch (err) {
    throw new Error(`Failed to read ${CONFIG_FILE}: ${(err as Error).message}`);
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function ensureDirs(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  fs.mkdirSync(charactersDir(), { recursive: true });
  fs.mkdirSync(usersDir(), { recursive: true });
}

export function chatsDir(): string {
  return CHATS_DIR;
}

export function chatDir(chatId: string): string {
  return path.join(CHATS_DIR, chatId);
}

export function chatFilesDir(chatId: string): string {
  return path.join(chatDir(chatId), `files`);
}

// Dirent.isDirectory() returns false for symlinks and Windows junctions,
// so a link folder is counted as a directory when stat through the link
// answers "dir". A broken link is not a directory.
export function isDirEntry(root: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(root, entry.name)).isDirectory();
  } catch {
    return false;
  }
}
