import fs from 'fs';
import os from 'os';
import path from 'path';
import { cloneUser, deleteUser, getUser, isValidUserId, listUsers, saveUser, syncUsers } from './users';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytalk-users-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isValidUserId', () => {
  it('accepts ordinary folder names', () => {
    expect(isValidUserId('me')).toBe(true);
    expect(isValidUserId('u1712345678901')).toBe(true);
    // unicode letters are allowed in folder names
    expect(isValidUserId('а-лиса_1.2')).toBe(true);
  });

  it('rejects empty and dangerous values', () => {
    expect(isValidUserId('')).toBe(false);
    expect(isValidUserId('a/b')).toBe(false);
    expect(isValidUserId('a\\b')).toBe(false);
    expect(isValidUserId('..')).toBe(false);
    expect(isValidUserId('.hidden')).toBe(false);
    expect(isValidUserId('a b')).toBe(false);
    expect(isValidUserId(42)).toBe(false);
    expect(isValidUserId(undefined)).toBe(false);
  });
});

describe('saveUser / getUser / listUsers', () => {
  it('saves the user into a folder and reads it back', () => {
    saveUser({ id: 'me', name: 'You', description: 'engineer' }, root);
    expect(getUser('me', root)).toEqual({
      id: 'me',
      name: 'You',
      description: 'engineer',
    });
    expect(listUsers(root).map((u) => u.id)).toEqual(['me']);
  });

  it('listUsers ignores folders without user.json and broken files', () => {
    fs.mkdirSync(path.join(root, 'empty'));
    fs.mkdirSync(path.join(root, 'broken'));
    fs.writeFileSync(path.join(root, 'broken', 'user.json'), '{oops', 'utf-8');
    saveUser({ id: 'ok', name: 'OK', description: '' }, root);
    expect(listUsers(root).map((u) => u.id)).toEqual(['ok']);
  });

  it('sorts the list by name', () => {
    saveUser({ id: 'b', name: 'Bob', description: '' }, root);
    saveUser({ id: 'a', name: 'Anna', description: '' }, root);
    expect(listUsers(root).map((u) => u.id)).toEqual(['a', 'b']);
  });
});

describe('syncUsers', () => {
  it('creates new ones, updates changed ones, deletes the extras', () => {
    saveUser({ id: 'one', name: 'One', description: 'old' }, root);
    saveUser({ id: 'two', name: 'Two', description: '' }, root);
    syncUsers(
      [
        { id: 'one', name: 'One', description: 'new' },
        { id: 'three', name: 'Three', description: '' },
      ],
      root,
    );
    expect(listUsers(root).map((u) => u.id).sort()).toEqual(['one', 'three']);
    expect(getUser('one', root)?.description).toBe('new');
  });

  it('deletes the user together with the avatar', () => {
    saveUser({ id: 'one', name: 'One', description: '' }, root);
    fs.writeFileSync(path.join(root, 'one', 'avatar.jpg'), 'x');
    syncUsers([], root);
    expect(fs.existsSync(path.join(root, 'one'))).toBe(false);
  });
});

describe('symlink folders', () => {
  it('listUsers sees a user behind a symlink/junction', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytalk-real-'));
    try {
      fs.mkdirSync(path.join(real, 'friend'));
      fs.writeFileSync(
        path.join(real, 'friend', 'user.json'),
        JSON.stringify({ name: 'Friend', description: '' }),
        'utf-8',
      );
      let linked = false;
      try {
        fs.symlinkSync(
          path.join(real, 'friend'),
          path.join(root, 'friend'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        linked = true;
      } catch {
        // no permission to create links — the check is unavailable
      }
      if (linked) {
        expect(listUsers(root).map((u) => u.id)).toContain('friend');
        expect(getUser('friend', root)?.name).toBe('Friend');
      }
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('deleteUser', () => {
  it('deletes the user folder', () => {
    saveUser({ id: 'a', name: 'A', description: '' }, root);
    expect(deleteUser('a', root)).toBe(true);
    expect(getUser('a', root)).toBeNull();
    expect(deleteUser('a', root)).toBe(false);
    expect(deleteUser('a/b', root)).toBe(false);
  });
});

describe('cloneUser', () => {
  it('copies the folder (the avatar goes along) with the (copy) name', () => {
    saveUser({ id: 'me', name: 'You', description: 'engineer' }, root);
    fs.writeFileSync(path.join(root, 'me', 'avatar.jpg'), 'av');
    const newId = cloneUser('me', root);
    expect(newId).toBe('me-copy');
    expect(getUser('me-copy', root)).toEqual({
      id: 'me-copy',
      name: 'You (copy)',
      description: 'engineer',
    });
    expect(fs.existsSync(path.join(root, 'me-copy', 'avatar.jpg'))).toBe(true);
    // the source is left untouched
    expect(getUser('me', root)?.name).toBe('You');
  });

  it('finds a free id when the first candidate is taken', () => {
    saveUser({ id: 'a', name: 'A', description: '' }, root);
    saveUser({ id: 'a-copy', name: 'Taken', description: '' }, root);
    expect(cloneUser('a', root)).toBe('a-copy2');
  });

  it('returns null for a missing or invalid source', () => {
    expect(cloneUser('nope', root)).toBeNull();
    expect(cloneUser('a b', root)).toBeNull();
  });
});
