import fs from 'fs';
import path from 'path';
import { Character } from './types';
import { characterDir, characterFile, characterPhotosDir, charactersDir, isDirEntry } from './config';

// The character ID is a folder name, so the allowed characters are limited.
export function isValidCharacterId(id: unknown): id is string {
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

function readCharacterFile(id: string, root: string): Character | null {
  const file = characterFile(id, root);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<Character>;
    return {
      id,
      name: typeof data.name === 'string' ? data.name : id,
      description: typeof data.description === 'string' ? data.description : '',
    };
  } catch {
    return null;
  }
}

// The character list: every folder with a character.json. Sorted by name.
export function listCharacters(root: string = charactersDir()): Character[] {
  if (!fs.existsSync(root)) return [];
  const result: Character[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!isDirEntry(root, entry)) continue;
    const character = readCharacterFile(entry.name, root);
    if (character) result.push(character);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function getCharacter(id: string, root: string = charactersDir()): Character | null {
  if (!isValidCharacterId(id)) return null;
  return readCharacterFile(id, root);
}

// Creates the character folder (including photos/) and writes character.json.
export function saveCharacter(character: Character, root: string = charactersDir()): void {
  if (!isValidCharacterId(character.id)) {
    throw new Error(`Invalid character ID: ${String(character.id)}`);
  }
  fs.mkdirSync(characterPhotosDir(character.id, root), { recursive: true });
  const data = {
    name: character.name ?? '',
    description: character.description ?? '',
  };
  fs.writeFileSync(characterFile(character.id, root), JSON.stringify(data, null, 2), 'utf-8');
}

// Deletes the character together with its folder (photos and everything else).
export function deleteCharacter(id: string, root: string = charactersDir()): boolean {
  if (!isValidCharacterId(id)) return false;
  const dir = characterDir(id, root);
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

// Copies the character folder (character.json, photos/, the avatar) into a
// new one; the copy is named "<name> (copy)". Returns the new id, null when
// the source does not exist.
export function cloneCharacter(id: string, root: string = charactersDir()): string | null {
  if (!isValidCharacterId(id)) return null;
  const source = readCharacterFile(id, root);
  if (!source) return null;
  const newId = nextCloneId(id, root);
  fs.cpSync(characterDir(id, root), characterDir(newId, root), { recursive: true });
  saveCharacter({ id: newId, name: `${source.name} (copy)`, description: source.description }, root);
  return newId;
}

// Brings the set of characters in line with the given list:
// creates new ones, updates existing ones, deletes the extras.
export function syncCharacters(characters: Character[], root: string = charactersDir()): void {
  const keep = new Set<string>();
  for (const character of characters) {
    saveCharacter(character, root);
    keep.add(character.id);
  }
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!isDirEntry(root, entry)) continue;
    if (!keep.has(entry.name)) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
}

// Migration from the old config.json format: character entries are moved
// into folders; existing character.json files are not overwritten.
export function migrateCharacters(entries: unknown, root: string = charactersDir()): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<Character>;
    if (!isValidCharacterId(candidate.id)) continue;
    if (fs.existsSync(characterFile(candidate.id, root))) continue;
    saveCharacter(
      {
        id: candidate.id,
        name: typeof candidate.name === 'string' ? candidate.name : candidate.id,
        description: typeof candidate.description === 'string' ? candidate.description : '',
      },
      root,
    );
  }
}
