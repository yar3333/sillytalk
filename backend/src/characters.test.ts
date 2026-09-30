import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  cloneCharacter,
  deleteCharacter,
  getCharacter,
  isValidCharacterId,
  listCharacters,
  migrateCharacters,
  saveCharacter,
  syncCharacters,
} from './characters';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytalk-chars-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isValidCharacterId', () => {
  it('accepts ordinary folder names', () => {
    expect(isValidCharacterId('assistant')).toBe(true);
    expect(isValidCharacterId('alisa')).toBe(true);
    expect(isValidCharacterId('c1712345678901')).toBe(true);
    // unicode letters are allowed in folder names
    expect(isValidCharacterId('а-лиса_1.2')).toBe(true);
  });

  it('rejects empty and dangerous values', () => {
    expect(isValidCharacterId('')).toBe(false);
    expect(isValidCharacterId('a/b')).toBe(false);
    expect(isValidCharacterId('a\\b')).toBe(false);
    expect(isValidCharacterId('..')).toBe(false);
    expect(isValidCharacterId('.hidden')).toBe(false);
    expect(isValidCharacterId('a b')).toBe(false);
    expect(isValidCharacterId(42)).toBe(false);
    expect(isValidCharacterId(undefined)).toBe(false);
  });
});

describe('saveCharacter / getCharacter / listCharacters', () => {
  it('saves the character into a folder and reads it back', () => {
    saveCharacter({ id: 'alisa', name: 'Alice', description: 'a kind fairy' }, root);
    expect(getCharacter('alisa', root)).toEqual({
      id: 'alisa',
      name: 'Alice',
      description: 'a kind fairy',
    });
    expect(listCharacters(root).map((c) => c.id)).toEqual(['alisa']);
  });

  it('creates the photos folder', () => {
    saveCharacter({ id: 'a', name: 'A', description: '' }, root);
    expect(fs.existsSync(path.join(root, 'a', 'photos'))).toBe(true);
  });

  it('listCharacters ignores folders without character.json and broken files', () => {
    fs.mkdirSync(path.join(root, 'empty'));
    fs.mkdirSync(path.join(root, 'broken'));
    fs.writeFileSync(path.join(root, 'broken', 'character.json'), '{oops', 'utf-8');
    saveCharacter({ id: 'ok', name: 'OK', description: '' }, root);
    expect(listCharacters(root).map((c) => c.id)).toEqual(['ok']);
  });
});

describe('syncCharacters', () => {
  it('creates new ones, updates changed ones, deletes the extras', () => {
    saveCharacter({ id: 'one', name: 'One', description: 'old' }, root);
    saveCharacter({ id: 'two', name: 'Two', description: '' }, root);
    syncCharacters(
      [
        { id: 'one', name: 'One', description: 'new' },
        { id: 'three', name: 'Three', description: '' },
      ],
      root,
    );
    expect(listCharacters(root).map((c) => c.id).sort()).toEqual(['one', 'three']);
    expect(getCharacter('one', root)?.description).toBe('new');
  });

  it('deletes the character together with the photos', () => {
    saveCharacter({ id: 'one', name: 'One', description: '' }, root);
    fs.writeFileSync(path.join(root, 'one', 'photos', 'a.png'), 'x');
    syncCharacters([], root);
    expect(fs.existsSync(path.join(root, 'one'))).toBe(false);
  });
});

describe('migrateCharacters', () => {
  it('moves entries from the old config into folders', () => {
    migrateCharacters(
      [
        { id: 'alisa', name: 'Alice', description: 'kind' },
        { id: 'bad id', name: 'X', description: '' },
        'not an object',
        null,
      ],
      root,
    );
    expect(listCharacters(root).map((c) => c.id)).toEqual(['alisa']);
    expect(getCharacter('alisa', root)?.description).toBe('kind');
  });

  it('does not overwrite existing character.json', () => {
    saveCharacter({ id: 'alisa', name: 'New', description: '' }, root);
    migrateCharacters([{ id: 'alisa', name: 'Old', description: '' }], root);
    expect(getCharacter('alisa', root)?.name).toBe('New');
  });
});

describe('symlink folders', () => {
  it('listCharacters sees a character behind a symlink/junction', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytalk-real-'));
    try {
      fs.mkdirSync(path.join(real, 'carol'));
      fs.writeFileSync(
        path.join(real, 'carol', 'character.json'),
        JSON.stringify({ name: 'Carol', description: '' }),
        'utf-8',
      );
      let linked = false;
      try {
        fs.symlinkSync(
          path.join(real, 'carol'),
          path.join(root, 'carol'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        linked = true;
      } catch {
        // no permission to create links — the check is unavailable
      }
      if (linked) {
        expect(listCharacters(root).map((c) => c.id)).toContain('carol');
        expect(getCharacter('carol', root)?.name).toBe('Carol');
      }
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('a broken link is not counted as a character', () => {
    let linked = false;
    try {
      fs.symlinkSync(
        path.join(root, 'no-such-folder'),
        path.join(root, 'ghost'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      linked = true;
    } catch {
      // no permission to create links — the check is unavailable
    }
    if (linked) {
      expect(listCharacters(root)).toEqual([]);
    }
  });
});

describe('deleteCharacter', () => {
  it('deletes the character folder', () => {
    saveCharacter({ id: 'a', name: 'A', description: '' }, root);
    expect(deleteCharacter('a', root)).toBe(true);
    expect(getCharacter('a', root)).toBeNull();
    expect(deleteCharacter('a', root)).toBe(false);
    expect(deleteCharacter('a/b', root)).toBe(false);
  });
});

describe('cloneCharacter', () => {
  it('copies the folder (photos and avatar go along) with the (copy) name', () => {
    saveCharacter({ id: 'alice', name: 'Alice', description: 'a friend' }, root);
    fs.writeFileSync(path.join(root, 'alice', 'photos', 'p1.png'), 'img');
    fs.writeFileSync(path.join(root, 'alice', 'avatar.jpg'), 'av');
    const newId = cloneCharacter('alice', root);
    expect(newId).toBe('alice-copy');
    expect(getCharacter('alice-copy', root)).toEqual({
      id: 'alice-copy',
      name: 'Alice (copy)',
      description: 'a friend',
    });
    expect(fs.existsSync(path.join(root, 'alice-copy', 'photos', 'p1.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'alice-copy', 'avatar.jpg'))).toBe(true);
    // the source is left untouched
    expect(getCharacter('alice', root)?.name).toBe('Alice');
  });

  it('finds a free id when the first candidate is taken', () => {
    saveCharacter({ id: 'a', name: 'A', description: '' }, root);
    saveCharacter({ id: 'a-copy', name: 'Taken', description: '' }, root);
    expect(cloneCharacter('a', root)).toBe('a-copy2');
  });

  it('returns null for a missing or invalid source', () => {
    expect(cloneCharacter('nope', root)).toBeNull();
    expect(cloneCharacter('a b', root)).toBeNull();
  });
});
