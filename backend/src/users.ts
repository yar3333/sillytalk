import fs from 'fs';
import path from 'path';
import { User } from './types';
import { isDirEntry, userDir, userFile, usersDir } from './config';

// The user ID is a folder name, so the allowed characters are limited.
export function isValidUserId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 100 &&
    !id.startsWith('.') &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('\0') &&
    /^[\p{L}\p{N}._-]+$/u.test(id)
  );
}

function readUserFile(id: string, root: string): User | null {
  const file = userFile(id, root);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<User>;
    return {
      id,
      name: typeof data.name === 'string' ? data.name : id,
      description: typeof data.description === 'string' ? data.description : '',
    };
  } catch {
    return null;
  }
}

// The user list: every folder with a user.json. Sorted by name.
export function listUsers(root: string = usersDir()): User[] {
  if (!fs.existsSync(root)) return [];
  const result: User[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!isDirEntry(root, entry)) continue;
    const user = readUserFile(entry.name, root);
    if (user) result.push(user);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function getUser(id: string, root: string = usersDir()): User | null {
  if (!isValidUserId(id)) return null;
  return readUserFile(id, root);
}

// Creates the user folder and writes user.json.
export function saveUser(user: User, root: string = usersDir()): void {
  if (!isValidUserId(user.id)) {
    throw new Error(`Invalid user ID: ${String(user.id)}`);
  }
  fs.mkdirSync(userDir(user.id, root), { recursive: true });
  const data = {
    name: user.name ?? '',
    description: user.description ?? '',
  };
  fs.writeFileSync(userFile(user.id, root), JSON.stringify(data, null, 2), 'utf-8');
}

// Deletes the user together with the folder (avatar and everything else).
export function deleteUser(id: string, root: string = usersDir()): boolean {
  if (!isValidUserId(id)) return false;
  const dir = userDir(id, root);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// The next free clone folder: <id>-copy, <id>-copy2, … (a timestamp-based
// name when the base is too long for a folder).
function nextCloneId(base: string, root: string): string {
  if (base.length + 5 > 100) {
    let id = `copy${Date.now()}`;
    while (fs.existsSync(path.join(root, id))) {
      id = `copy${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    }
    return id;
  }
  let id = `${base}-copy`;
  let n = 2;
  while (fs.existsSync(path.join(root, id))) id = `${base}-copy${n++}`;
  return id;
}

// Copies the user folder (user.json, the avatar) into a new one; the copy is
// named "<name> (copy)". Returns the new id, null when the source is missing.
export function cloneUser(id: string, root: string = usersDir()): string | null {
  if (!isValidUserId(id)) return null;
  const source = readUserFile(id, root);
  if (!source) return null;
  const newId = nextCloneId(id, root);
  fs.cpSync(userDir(id, root), userDir(newId, root), { recursive: true });
  saveUser({ id: newId, name: `${source.name} (copy)`, description: source.description }, root);
  return newId;
}

// Brings the set of users in line with the given list:
// creates new ones, updates existing ones, deletes the extras.
export function syncUsers(users: User[], root: string = usersDir()): void {
  const keep = new Set<string>();
  for (const user of users) {
    saveUser(user, root);
    keep.add(user.id);
  }
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!isDirEntry(root, entry)) continue;
    if (!keep.has(entry.name)) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
}
