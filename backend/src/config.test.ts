import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_REASONING_LEVELS, reasoningLevelsOf } from './config';
import { Config } from './types';

// loadConfig() resolves the data dir when the module is loaded, so each
// scenario gets a fresh module instance with its own SILLYTALK_DATA_DIR.
function loadConfigWith(raw: string): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytalk-config-'));
  fs.writeFileSync(path.join(dir, 'config.json'), raw, 'utf-8');
  let cfg: Config | undefined;
  jest.isolateModules(() => {
    process.env.SILLYTALK_DATA_DIR = dir;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./config') as typeof import('./config');
    cfg = mod.loadConfig();
  });
  return cfg as Config;
}

// A minimal valid config with one model; extra fields go into the entry.
const base = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    listen: '127.0.0.1:3210',
    llmModels: {
      m: { id: 'm', baseUrl: 'http://x/v1', contextSize: 100, supportsImages: false, ...extra },
    },
  });

describe('the reasoning config fields', () => {
  it('default: reasoning off, the standard level set', () => {
    const cfg = loadConfigWith(base());
    expect(cfg.llmModels.m.reasoning).toBe(false);
    expect(cfg.llmModels.m.reasoningLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('keeps a level that is in the model list', () => {
    const cfg = loadConfigWith(base({ reasoning: 'high', reasoningLevels: ['low', 'high'] }));
    expect(cfg.llmModels.m.reasoning).toBe('high');
    expect(cfg.llmModels.m.reasoningLevels).toEqual(['low', 'high']);
  });

  it('a level outside the model list becomes off', () => {
    const cfg = loadConfigWith(base({ reasoning: 'max', reasoningLevels: ['low'] }));
    expect(cfg.llmModels.m.reasoning).toBe(false);
  });

  it('false, empty and non-string levels become off', () => {
    expect(loadConfigWith(base({ reasoning: false })).llmModels.m.reasoning).toBe(false);
    expect(loadConfigWith(base({ reasoning: '' })).llmModels.m.reasoning).toBe(false);
    expect(loadConfigWith(base({ reasoning: 7 })).llmModels.m.reasoning).toBe(false);
  });

  it('an empty or junk level list falls back to the default set', () => {
    expect(loadConfigWith(base({ reasoningLevels: [] })).llmModels.m.reasoningLevels).toEqual(
      DEFAULT_REASONING_LEVELS,
    );
    expect(
      loadConfigWith(base({ reasoningLevels: [1, '  ', 'low'] })).llmModels.m.reasoningLevels,
    ).toEqual(['low']);
  });
});

describe('reasoningLevelsOf', () => {
  it('uses the model list when it is non-empty', () => {
    expect(reasoningLevelsOf({ reasoningLevels: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('falls back to the default set', () => {
    expect(reasoningLevelsOf({})).toEqual(DEFAULT_REASONING_LEVELS);
    expect(reasoningLevelsOf({ reasoningLevels: [] })).toEqual(DEFAULT_REASONING_LEVELS);
  });
});
