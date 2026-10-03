import express from "express";
import fs from "fs";
import path from "path";
import { Character, Chat, ChatMessage, Config, Model, User } from "./types";
import {
  chatFilesDir,
  characterDir,
  characterPhotosDir,
  ensureDirs,
  listModels,
  loadConfig,
  saveConfig,
  userDir,
} from "./config";
import {
  createChat,
  deleteChat,
  getChat,
  importCharacterPhoto,
  listChats,
  newId,
  saveChat,
  saveChatImage,
} from "./chats";
import {
  cloneCharacter,
  getCharacter,
  isValidCharacterId,
  listCharacters,
  migrateCharacters,
  syncCharacters,
} from "./characters";
import { cloneUser, getUser, isValidUserId, listUsers, syncUsers } from "./users";
import {
  chatCompletion,
  extractImageRequests,
  extractPhotoRequests,
  labelHistory,
  parseSilence,
  stripNamePrefixes,
  systemPromptFor,
  trimHistory,
} from "./llm";
import { ImageGenerationService } from "./image_generating/ImageGenerationService";
import { ImageJob } from "./image_generating/ImageJob";

// The API router. The image-generation service is injected (the composition
// root in index.ts builds the DI container and hands the service in here).
export function createApiRouter(imageGeneration: ImageGenerationService): express.Router {
  const apiRouter = express.Router();

  apiRouter.use(express.json({ limit: "25mb" }));

  const IMAGE_CONTENT_TYPE: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };

  function sendImage(res: express.Response, file: string): void {
    if (!fs.existsSync(file)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", IMAGE_CONTENT_TYPE[path.extname(file).toLowerCase()] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  }

  // ---- avatars ----
  // The avatar is stored in the folder as avatar.<ext> (usually avatar.jpg);
  // the extension follows the actual format of the uploaded image.
  const AVATAR_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];

  function findAvatar(dir: string): string | null {
    for (const ext of AVATAR_EXTS) {
      const file = path.join(dir, `avatar.${ext}`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  function saveAvatarFile(dir: string, dataUrl: string): void {
    const match = /^data:image\/(jpeg|png|webp|gif);base64,([\w+/=\s]+)$/.exec(dataUrl);
    if (!match) throw new Error("Expected an image data URL (jpeg/png/webp/gif)");
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    fs.mkdirSync(dir, { recursive: true });
    for (const e of AVATAR_EXTS) {
      if (e === ext) continue;
      const old = path.join(dir, `avatar.${e}`);
      if (fs.existsSync(old)) fs.rmSync(old);
    }
    fs.writeFileSync(path.join(dir, `avatar.${ext}`), Buffer.from(match[2].replace(/\s/g, ""), "base64"));
  }

  function deleteAvatars(dir: string): boolean {
    let deleted = false;
    for (const ext of AVATAR_EXTS) {
      const file = path.join(dir, `avatar.${ext}`);
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        deleted = true;
      }
    }
    return deleted;
  }

  // The three avatar routes (GET/POST/DELETE) are identical for users/ and characters/.
  function avatarRoutes(kind: "user" | "character") {
    const dirFor = (id: string) => (kind === "user" ? userDir(id) : characterDir(id));
    const valid = (id: string) => (kind === "user" ? isValidUserId(id) : isValidCharacterId(id));
    return {
      get: (req: express.Request, res: express.Response): void => {
        const id = String(req.params.id);
        if (!valid(id)) {
          res.status(400).json({ error: "Invalid ID" });
          return;
        }
        const file = findAvatar(dirFor(id));
        if (!file) {
          res.status(404).end();
          return;
        }
        // Avatars change from settings — the browser must not cache them.
        res.setHeader("Cache-Control", "no-store");
        sendImage(res, file);
      },
      post: (req: express.Request, res: express.Response): void => {
        const id = String(req.params.id);
        if (!valid(id)) {
          res.status(400).json({ error: "Invalid ID" });
          return;
        }
        const data = req.body?.data;
        if (typeof data !== "string" || !data) {
          res.status(400).json({ error: "Expected an image data URL (data field)" });
          return;
        }
        try {
          saveAvatarFile(dirFor(id), data);
          res.json({ ok: true });
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      },
      delete: (req: express.Request, res: express.Response): void => {
        const id = String(req.params.id);
        if (!valid(id)) {
          res.status(400).json({ error: "Invalid ID" });
          return;
        }
        res.json({ deleted: deleteAvatars(dirFor(id)) });
      },
    };
  }

  const userAvatar = avatarRoutes("user");
  apiRouter.get("/users/:id/avatar", userAvatar.get);
  apiRouter.post("/users/:id/avatar", userAvatar.post);
  apiRouter.delete("/users/:id/avatar", userAvatar.delete);

  const characterAvatar = avatarRoutes("character");
  apiRouter.get("/characters/:id/avatar", characterAvatar.get);
  apiRouter.post("/characters/:id/avatar", characterAvatar.post);
  apiRouter.delete("/characters/:id/avatar", characterAvatar.delete);

  function resolveModel(config: Config, chat: Chat) {
    const models = listModels(config);
    // chat.modelId — the llmModels key (which is Model.name).
    return models.find((m) => m.name === chat.modelId) ?? models[0] ?? null;
  }

  // Normalizes the image list to file names in the chat files/: a data URL is
  // saved as a new file; a string without data: is a reference to an existing one.
  function normalizeChatImages(chatId: string, images: unknown[]): string[] {
    const filesDir = chatFilesDir(chatId);
    const saved: string[] = [];
    for (const img of images) {
      if (typeof img !== "string" || !img) continue;
      if (img.startsWith("data:")) {
        saved.push(saveChatImage(chatId, img));
      } else {
        const safe = path.basename(img);
        if (fs.existsSync(path.join(filesDir, safe))) saved.push(safe);
      }
    }
    return saved;
  }

  function chatMessagePayload(chatId: string, text: string, images: string[]): { text: string; images: string[] } {
    return { text, images: normalizeChatImages(chatId, images ?? []) };
  }

  // Sets (or clears, when status is undefined) the generation status of one
  // image of one message, saving the chat. The chat is re-read on every call so
  // a job finishing never clobbers a concurrent change (a new message, another
  // job finishing). A missing chat or message is a silent no-op (it was
  // deleted while the job ran).
  function setMessageImageStatus(
    chatId: string,
    messageId: string,
    image: string,
    status: "pending" | "failed" | "cancelled" | undefined,
    error?: string,
  ): void {
    const chat = getChat(chatId);
    if (!chat) return;
    const msg = chat.messages.find((m) => m.id === messageId);
    if (!msg) return;
    let dirty = false;
    if (status === undefined) {
      // The image is ready (or no longer belongs to the message): clear its
      // pending/failed status and the stored error.
      if (msg.imageStatus && image in msg.imageStatus) {
        delete msg.imageStatus[image];
        if (Object.keys(msg.imageStatus).length === 0) delete msg.imageStatus;
        dirty = true;
      }
      if (msg.imageErrors && image in msg.imageErrors) {
        delete msg.imageErrors[image];
        if (Object.keys(msg.imageErrors).length === 0) delete msg.imageErrors;
        dirty = true;
      }
    } else {
      msg.imageStatus = { ...(msg.imageStatus ?? {}), [image]: status };
      if (error !== undefined) msg.imageErrors = { ...(msg.imageErrors ?? {}), [image]: error };
      dirty = true;
    }
    if (dirty) saveChat(chat);
  }

  // Starts a background generation for the reserved image `name` (which must
  // already be saved in a chat message with the "pending" status) and updates
  // the message when it finishes:
  //   ok                       -> status cleared (the image is ready)
  //   failed / cancelled       -> "failed" + error, UNLESS an older image
  //                               existed at the name (hadOld) — then the old
  //                               file is kept and the message stays ready.
  // A job replaced by a newer one (a regeneration) does not update the message.
  function startChatImageJob(chatId: string, messageId: string, name: string, prompt: string, refs: string[]): void {
    const job: ImageJob = imageGeneration.startImageJob({ chatId, name, prompt, refFilenames: refs });
    void job.result.then((res) => {
      // A regeneration started a newer job for the same image — it owns the
      // status now, so this (replaced) job stays silent.
      const current = imageGeneration.getCurrentJob(chatId, name);
      if (current !== undefined && current !== job) return;
      // ok, or a failed/cancelled run that found an older image to keep.
      if (res.status === "ok" || res.hadOld) {
        setMessageImageStatus(chatId, messageId, name, undefined);
        return;
      }
      setMessageImageStatus(
        chatId,
        messageId,
        name,
        res.status === "cancelled" ? "cancelled" : "failed",
        res.status === "failed" ? res.error : undefined,
      );
    });
  }

  // Generates and appends a reply of the given character to the chat.
  // Returns null when the character stays silent (the reply is exactly [SILENT]).
  // The common part of a normal send, "another message from the AI" (empty
  // send) and regeneration: system prompt, history, the model call, parsing of
  // self-requested images, saving. The author (characterId) is stored on the message.
  // `replaceLast` (regeneration): the last assistant message is being replaced —
  // it is excluded from the history (the model writes a fresh line) and removed
  // from the chat ONLY after the new reply is saved, so a cancel or a model error
  // keeps the original reply.
  async function appendAssistantReply(
    chat: Chat,
    model: Model,
    characterId: string,
    signal?: AbortSignal,
    replaceLast = false,
  ): Promise<ChatMessage | null> {
    const character = getCharacter(characterId);
    if (!character) return null;
    const canGenerateImages = imageGeneration.hasAvailableGenerator();
    // The inventory is always needed: it backs both [PHOTO:N] (send a ready
    // image, no generator required) and [IMG:... | N] references (generation).
    const inventory = imageGeneration.imageInventory(chat, character);
    const inventoryText = inventory.map((it, i) => `#${i + 1} — ${it.label}`).join("\n");
    const user = chat.userId ? getUser(chat.userId) : (listUsers()[0] ?? null);
    // The other character participants: in a group chat the prompt explains the
    // reply order and allows staying silent.
    const fellows = chat.characterIds
      .filter((id) => id !== characterId)
      .map((id) => getCharacter(id))
      .filter((c): c is Character => c !== null);
    const system = systemPromptFor(character, user, canGenerateImages, inventoryText || undefined, fellows);

    // In a group chat we label lines with authors — the model must understand
    // who said what. With a single character and a single persona the history
    // is left as-is. The chat's personas are derived from message authors;
    // there is no Chat.userIds.
    const multi = chat.characterIds.length > 1 || new Set(chat.messages.map((m) => m.userId)).size > 1;
    // The message being regenerated stays in the chat (visible to the user) but
    // is not part of the history the model sees — it is being replaced.
    const replacedIndex = replaceLast && chat.messages.length > 0 ? chat.messages.length - 1 : -1;
    const replacedMessage =
      replacedIndex !== -1 && chat.messages[replacedIndex]?.role === "assistant" ? chat.messages[replacedIndex] : null;
    const history = trimHistory(
      labelHistory(
        chat.messages.filter((m) => m !== replacedMessage && !m.error),
        Object.fromEntries(
          chat.characterIds
            .map((id) => [id, getCharacter(id)?.name ?? id] as const)
            .filter(([id]) => chat.messages.some((m) => m.characterId === id)),
        ),
        Object.fromEntries(
          [...new Set(chat.messages.map((m) => m.userId).filter((id): id is string => !!id))].map(
            (id) => [id, getUser(id)?.name ?? id] as const,
          ),
        ),
        multi,
      ),
      model.contextSize,
    );

    // A reminder at the end of the context: weak models forget whose turn it
    // is near the end of the history and keep speaking for the previous speaker.
    const replyText = await chatCompletion(
      model,
      system,
      history,
      chat.id,
      `The next reply is the line of the character ${character.name}. ` +
        'Write strictly in the first person of this character ("I"), ' +
        "do not write for the other characters or for the user. " +
        "If you have absolutely nothing to add to the conversation, output exactly [SILENT] instead of a reply. " +
        "Keep the reply short: 2–5 sentences, one paragraph.",
      signal,
    );

    // The character may have stayed silent (exactly [SILENT]) — no chat message.
    const spoken0 = parseSilence(replyText);
    if (spoken0 === null) return null;
    // Strip "Bob: …" / "Carol: Carol: …" — copies of author labels from the history.
    const spoken = stripNamePrefixes(spoken0, [character.name, ...fellows.map((c) => c.name)]);

    // The model may have requested images itself with the [IMG:description | 1,3]
    // tag. The tags are removed and the images are generated in the BACKGROUND:
    // each gets a reserved file name that is stored in the message right away
    // (with the "pending" status) so the reply is returned to the client
    // without waiting for the (slow) generation. A failure or a cancel marks
    // the image "failed" (the broken placeholder with a Regenerate button).
    const parsed = extractImageRequests(spoken);
    // [PHOTO:N] — send a ready image from the inventory as-is (a character
    // photo is copied into the chat files/ via importCharacterPhoto).
    const photoReq = extractPhotoRequests(parsed.text);
    const photoIdx = [...new Set(photoReq.photos)];
    const images: string[] = photoIdx.length > 0 ? imageGeneration.resolveInventoryRefs(chat.id, photoIdx, inventory) : [];
    const imagePrompts: Record<string, string> = {};
    const imageRefs: Record<string, string[]> = {};
    const imageStatus: Record<string, "pending" | "failed" | "cancelled"> = {};
    const pendingJobs: Array<{ name: string; prompt: string; refs: string[] }> = [];
    if (canGenerateImages) {
      for (const reqItem of parsed.requests) {
        const refs = imageGeneration.resolveInventoryRefs(chat.id, reqItem.refs, inventory);
        const name = imageGeneration.newGeneratedImageName();
        images.push(name);
        imagePrompts[name] = reqItem.prompt;
        if (refs.length > 0) imageRefs[name] = refs;
        imageStatus[name] = "pending";
        pendingJobs.push({ name, prompt: reqItem.prompt, refs });
      }
    }

    const assistantMsg: ChatMessage = {
      id: newId(),
      role: "assistant" as const,
      characterId,
      text: photoReq.text,
      images,
      imagePrompts: Object.keys(imagePrompts).length > 0 ? imagePrompts : undefined,
      imageRefs: Object.keys(imageRefs).length > 0 ? imageRefs : undefined,
      imageStatus: Object.keys(imageStatus).length > 0 ? imageStatus : undefined,
      timestamp: Date.now(),
    };
    // Regeneration: remove the replaced message now that the new reply is
    // confirmed (a cancel or an error never reaches here — the original stays).
    if (replacedMessage && chat.messages[replacedIndex] === replacedMessage) {
      chat.messages.splice(replacedIndex, 1);
    }
    chat.messages.push(assistantMsg);
    // Save the reply (with the reserved "pending" names) BEFORE starting the
    // jobs, so the client already sees the placeholders when the response
    // returns and the jobs update a message that exists on disk.
    saveChat(chat);
    for (const job of pendingJobs) {
      startChatImageJob(chat.id, assistantMsg.id, job.name, job.prompt, job.refs);
    }
    return assistantMsg;
  }

  // ---- config ----
  apiRouter.get("/config", (_req, res) => {
    res.json(loadConfig());
  });

  apiRouter.put("/config", async (req, res) => {
    const cfg = req.body;
    if (!cfg || typeof cfg !== "object") {
      res.status(400).json({ error: "Invalid config" });
      return;
    }
    if (Array.isArray(cfg.characters)) {
      // characters are no longer in the config — move them into folders
      migrateCharacters(cfg.characters);
    }
    delete cfg.characters;
    // legacy fields are removed to avoid confusion
    delete cfg.port;
    delete cfg.models;
    delete cfg.userId;
    delete cfg.imageGeneration;
    saveConfig(cfg);
    ensureDirs();
    // recompute the available generators for the updated settings
    await imageGeneration.refreshAvailableGenerators(loadConfig().imageGenerators);
    res.json(loadConfig());
  });

  // ---- characters ----
  // Characters are stored in characters/<id>/ folders (see characters.ts).
  function charactersWithPhotos(): Array<Character & { photos: string[]; hasAvatar: boolean }> {
    return listCharacters().map((character) => {
      const dir = characterPhotosDir(character.id);
      let photos: string[] = [];
      if (fs.existsSync(dir)) {
        photos = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
      }
      return { ...character, photos, hasAvatar: findAvatar(characterDir(character.id)) !== null };
    });
  }

  apiRouter.get("/characters", (_req, res) => {
    res.json(charactersWithPhotos());
  });

  // Full sync: creates/updates/deletes characters to match the list.
  apiRouter.put("/characters", (req, res) => {
    const { characters } = req.body ?? {};
    if (!Array.isArray(characters)) {
      res.status(400).json({ error: "Expected a list of characters" });
      return;
    }
    const list: Character[] = [];
    const seen = new Set<string>();
    for (const entry of characters) {
      if (!entry || typeof entry !== "object") {
        res.status(400).json({ error: "Invalid character entry" });
        return;
      }
      const c = entry as Partial<Character>;
      if (!isValidCharacterId(c.id) || seen.has(c.id)) {
        res.status(400).json({ error: `Invalid or duplicate character ID: ${String(c.id)}` });
        return;
      }
      seen.add(c.id);
      list.push({
        id: c.id,
        name: typeof c.name === "string" ? c.name : c.id,
        description: typeof c.description === "string" ? c.description : "",
      });
    }
    syncCharacters(list);
    res.json(charactersWithPhotos());
  });

  // Clones the character folder (the photos and the avatar go along); the copy
  // is named "<name> (copy)" in a free <id>-copy* folder. The response carries
  // the new id (the UI opens the copy's edit dialog right away).
  apiRouter.post("/characters/:id/clone", (req, res) => {
    const newId = cloneCharacter(req.params.id);
    if (newId === null) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    res.json({ id: newId, characters: charactersWithPhotos() });
  });

  apiRouter.get("/characters/:id/photos/:name", (req, res) => {
    const character = getCharacter(req.params.id);
    if (!character) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    sendImage(res, path.join(characterPhotosDir(character.id), path.basename(req.params.name)));
  });

  // ---- users ----
  // Users are stored in users/<id>/ folders (see users.ts). Each chat picks its
  // own persona (Chat.userId) — there is none selected in the config.
  function usersWithAvatars(): Array<User & { hasAvatar: boolean }> {
    return listUsers().map((user) => ({
      ...user,
      hasAvatar: findAvatar(userDir(user.id)) !== null,
    }));
  }

  apiRouter.get("/users", (_req, res) => {
    res.json(usersWithAvatars());
  });

  // Full sync: creates/updates/deletes users to match the list.
  apiRouter.put("/users", (req, res) => {
    const { users } = req.body ?? {};
    if (!Array.isArray(users)) {
      res.status(400).json({ error: "Expected a list of users" });
      return;
    }
    const list: User[] = [];
    const seen = new Set<string>();
    for (const entry of users) {
      if (!entry || typeof entry !== "object") {
        res.status(400).json({ error: "Invalid user entry" });
        return;
      }
      const u = entry as Partial<User>;
      if (!isValidUserId(u.id) || seen.has(u.id)) {
        res.status(400).json({ error: `Invalid or duplicate user ID: ${String(u.id)}` });
        return;
      }
      seen.add(u.id);
      list.push({
        id: u.id,
        name: typeof u.name === "string" ? u.name : u.id,
        description: typeof u.description === "string" ? u.description : "",
      });
    }
    syncUsers(list);
    res.json(usersWithAvatars());
  });

  // Clones the user folder (the avatar goes along); the copy is named
  // "<name> (copy)" in a free <id>-copy* folder. The response carries the new
  // id (the UI opens the copy's edit dialog right away).
  apiRouter.post("/users/:id/clone", (req, res) => {
    const newId = cloneUser(req.params.id);
    if (newId === null) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ id: newId, users: usersWithAvatars() });
  });

  // ---- chats ----
  apiRouter.get("/chats", (_req, res) => {
    res.json(listChats());
  });

  // A list of ids from a string or an array of strings (empties dropped).
  function idList(v: unknown): string[] {
    if (typeof v === "string" && v) return [v];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  }

  apiRouter.post("/chats", (req, res) => {
    const body = req.body ?? {};
    // characterIds — participants in reply priority order; a single
    // characterId is also accepted. userId — the active persona; the personas
    // that participate in the chat are derived from message authors.
    const characterIds = idList(body.characterIds ?? body.characterId);
    if (characterIds.length === 0) {
      res.status(400).json({ error: "characterId is required" });
      return;
    }
    const chat = createChat(
      characterIds,
      typeof body.modelId === "string" ? body.modelId : "",
      typeof body.userId === "string" ? body.userId : "",
    );
    res.json(chat);
  });

  apiRouter.get("/chats/:id", (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    res.json(chat);
  });

  apiRouter.patch("/chats/:id", (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const { characterIds, modelId, userId } = req.body ?? {};
    // Participants can change at any time; the characterIds order = reply
    // priority (changed with the ↑/↓ buttons in the participants menu).
    if (characterIds !== undefined) {
      const ids = idList(characterIds);
      if (ids.length === 0) {
        res.status(400).json({ error: "The chat needs at least one character" });
        return;
      }
      chat.characterIds = ids;
    }
    if (modelId !== undefined) chat.modelId = modelId;
    // Switching the active persona: old messages stay under their former
    // authors — the author is stored on every message.
    if (userId !== undefined) chat.userId = userId;
    saveChat(chat);
    res.json(chat);
  });

  apiRouter.delete("/chats/:id", (req, res) => {
    res.json({ deleted: deleteChat(req.params.id) });
  });

  apiRouter.get("/chats/:id/files/:name", (req, res) => {
    sendImage(res, path.join(chatFilesDir(req.params.id), path.basename(req.params.name)));
  });

  // Imports a character photo into the chat files/ (for use as a reference)
  apiRouter.post("/chats/:id/import-photo", (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const { characterId, photo } = req.body ?? {};
    const character = getCharacter(characterId);
    if (!character) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    const name = importCharacterPhoto(chat.id, path.join(characterPhotosDir(character.id), path.basename(photo)));
    if (!name) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    res.json({ name });
  });

  // ---- messages ----
  // Saves the user message. The characters' replies are requested by the
  // frontend one at a time (POST /reply) — that way it knows who is "typing"
  // now and adds lines as they are generated.
  apiRouter.post("/chats/:id/messages", (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const payload = chatMessagePayload(chat.id, req.body?.text ?? "", req.body?.images ?? []);
    chat.messages.push({
      id: newId(),
      role: "user" as const,
      userId: chat.userId,
      text: payload.text,
      images: payload.images,
      timestamp: Date.now(),
    });
    saveChat(chat);
    res.json({ chat });
  });

  // The in-flight reply per chat (the frontend asks for the replies one at a
  // time): POST /chats/:id/cancel aborts the model call, and the /reply handler
  // saves no message for a cancelled run.
  const inFlightReplies = new Map<string, AbortController>();

  // The reply of a SINGLE chat character. The frontend calls it for each
  // participant in turn (in priority order, starting with the one mentioned by
  // name): between the calls it shows whose line is being generated, and the
  // silent ones (reply === null) are skipped.
  apiRouter.post("/chats/:id/reply", async (req, res) => {
    const characterId = typeof req.body?.characterId === "string" ? req.body.characterId : "";
    // `replaceLast` (regeneration): the last assistant message is being replaced —
    // the backend removes it only after the new reply is saved.
    const replaceLast = req.body?.replaceLast === true;
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    if (!characterId || !chat.characterIds.includes(characterId)) {
      res.status(400).json({ error: "The character is not a participant of the chat" });
      return;
    }
    const config = loadConfig();
    const model = resolveModel(config, chat);
    if (!model) {
      res.status(400).json({ error: "No model configured for the chat" });
      return;
    }
    const ctrl = new AbortController();
    inFlightReplies.set(chat.id, ctrl);
    try {
      const reply = await appendAssistantReply(chat, model, characterId, ctrl.signal, replaceLast);
      res.json({ chat, reply });
    } catch (err) {
      if (ctrl.signal.aborted) {
        // The user cancelled: no error message is saved, the chat stays as it
        // was. The client is already gone (it aborted its own fetch too).
        try {
          res.json({ chat: getChat(chat.id) ?? chat, reply: null });
        } catch {
          /* the connection is closed */
        }
        return;
      }
      const fresh = getChat(req.params.id);
      if (fresh) {
        fresh.messages.push({
          id: newId(),
          role: "assistant",
          characterId: characterId || undefined,
          text: `⚠️ Error: ${(err as Error).message}`,
          images: [],
          timestamp: Date.now(),
          error: true,
        });
        saveChat(fresh);
        res.json({ chat: fresh, reply: null });
      } else {
        res.status(500).json({ error: (err as Error).message });
      }
    } finally {
      if (inFlightReplies.get(chat.id) === ctrl) inFlightReplies.delete(chat.id);
    }
  });

  // Cancels the in-flight reply of the chat: the model call is aborted and no
  // message is saved for it. A no-op when nothing is generating. Returns the
  // current chat so the client can re-sync (a reply that landed in the last
  // moment is already saved and stays).
  apiRouter.post("/chats/:id/cancel", (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const ctrl = inFlightReplies.get(chat.id);
    if (ctrl) ctrl.abort();
    res.json({ chat });
  });

  // Edits an existing message: the text and/or the image list
  // (a data URL — a new image, a file name — an already uploaded one).
  apiRouter.patch("/chats/:id/messages/:messageId", (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const msg = chat.messages.find((m) => m.id === req.params.messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const { text, images } = req.body ?? {};
    if (text !== undefined) {
      if (typeof text !== "string") {
        res.status(400).json({ error: "Expected text (text field)" });
        return;
      }
      msg.text = text;
    }
    if (images !== undefined) {
      if (!Array.isArray(images)) {
        res.status(400).json({ error: "Expected an image list (images field)" });
        return;
      }
      msg.images = normalizeChatImages(chat.id, images);
    }
    saveChat(chat);
    res.json({ chat });
  });

  // Deletes a message: by default the message and all subsequent ones (trims
  // the tail of the dialogue), or only the single message with ?single=1.
  apiRouter.delete("/chats/:id/messages/:messageId", (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const single = req.query.single === "1";
    const idx = chat.messages.findIndex((m) => m.id === req.params.messageId);
    if (idx === -1) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    if (single) chat.messages.splice(idx, 1);
    else chat.messages.splice(idx); // from here to the end
    saveChat(chat);
    res.json({ chat });
  });

  // Regenerating the last reply is expressed with the primitives: the frontend
  // deletes the last message (DELETE /messages/:id) and requests one line
  // (POST /reply with its author) — no separate route is needed.

  // Regenerates one message image in the BACKGROUND: the stored prompt (or the
  // message text) is run through the generator again, writing to the SAME
  // reserved name (the file name in the message does not change). The image is
  // marked "pending" right away and the chat is returned immediately; the file
  // appears when the job finishes. A running generation for the same image is
  // cancelled first. If an older image exists at the name and the run fails or
  // is cancelled, the old one is kept (the message stays ready).
  apiRouter.post("/chats/:id/messages/:messageId/regenerate-image", async (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const msg = chat.messages.find((m) => m.id === req.params.messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const image = req.body?.image;
    if (typeof image !== "string" || !msg.images.includes(image)) {
      res.status(400).json({ error: "The message has no such image" });
      return;
    }
    const config = loadConfig();
    if (!imageGeneration.hasAvailableGenerator()) {
      res.status(400).json({ error: "Image generation is not configured" });
      return;
    }
    const rawPrompt = msg.imagePrompts?.[image] || msg.text.trim() || "image";
    const prompt = await imageGeneration.ensureEnglishPrompt(resolveModel(config, chat), rawPrompt);
    const refs = msg.imageRefs?.[image] ?? [];
    // A regeneration in flight for this image is cancelled — one job per image.
    imageGeneration.cancelJob(chat.id, image);
    // Mark "pending" (and clear a previous error) in a single re-read+save, so
    // the status and the (possibly re-translated) prompt land together.
    const fresh = getChat(chat.id);
    const fmsg = fresh?.messages.find((m) => m.id === msg.id);
    if (!fresh || !fmsg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    fmsg.imagePrompts = { ...(fmsg.imagePrompts ?? {}), [image]: prompt };
    fmsg.imageStatus = { ...(fmsg.imageStatus ?? {}), [image]: "pending" };
    if (fmsg.imageErrors && image in fmsg.imageErrors) {
      delete fmsg.imageErrors[image];
      if (Object.keys(fmsg.imageErrors).length === 0) delete fmsg.imageErrors;
    }
    saveChat(fresh);
    startChatImageJob(chat.id, msg.id, image, prompt, refs);
    res.json({ chat: fresh });
  });

  // Cancels the in-flight generation of one message image. The image is marked
  // "failed" right away (the broken placeholder with the Regenerate button);
  // the job itself settles shortly after (its hadOld check keeps an older
  // image, if any, so a cancelled regeneration does not break a ready one).
  // Cancelling an image that is not "pending" is a no-op.
  apiRouter.post("/chats/:id/messages/:messageId/cancel-image", (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const msg = chat.messages.find((m) => m.id === req.params.messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const image = req.body?.image;
    if (typeof image !== "string" || !msg.images.includes(image)) {
      res.status(400).json({ error: "The message has no such image" });
      return;
    }
    if (msg.imageStatus?.[image] === "pending") {
      imageGeneration.cancelJob(chat.id, image);
      setMessageImageStatus(chat.id, msg.id, image, "cancelled", "Generation cancelled");
    }
    res.json({ chat: getChat(chat.id) });
  });

  // ---- image generation ----
  // Whether any generator is available (for the "🎨" button and auto-[IMG] on the frontend).
  apiRouter.get("/image/status", (_req, res) => {
    res.json({ available: imageGeneration.hasAvailableGenerator() });
  });

  apiRouter.post("/image", async (req, res) => {
    try {
      const { chatId, prompt, refs } = req.body ?? {};
      const chat = getChat(chatId);
      if (!chat) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      if (!prompt) {
        res.status(400).json({ error: "Prompt is required" });
        return;
      }
      const config = loadConfig();
      if (!imageGeneration.hasAvailableGenerator()) {
        res.status(400).json({ error: "Image generation is not configured" });
        return;
      }
      // The prompt is required in English: Russian is translated with the chat's model.
      const model = resolveModel(config, chat);
      const finalPrompt = await imageGeneration.ensureEnglishPrompt(model, String(prompt));
      // The generation runs in the BACKGROUND: the message is saved right away
      // with the reserved name and the "pending" status (a spinner placeholder
      // in the UI) and the image file appears when the job finishes.
      const name = imageGeneration.newGeneratedImageName();
      const msg: ChatMessage = {
        id: newId(),
        role: "assistant",
        text: `🖼️ Generated: ${finalPrompt}`,
        images: [name],
        imagePrompts: { [name]: finalPrompt },
        imageStatus: { [name]: "pending" },
        timestamp: Date.now(),
      };
      chat.messages.push(msg);
      saveChat(chat);
      startChatImageJob(chat.id, msg.id, name, finalPrompt, refs ?? []);
      res.json({ chat, message: msg });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return apiRouter;
}
