import express from "express";
import fs from "fs";
import { ImageGenerationService } from "../image_generation/ImageGenerationService";
import { ReplyService } from "../reply/ReplyService";
import { HttpHelper } from "../shared/HttpHelper";
import { PathHelper } from "../shared/PathHelper";
import { ChatsService } from "./ChatsService";

// The /chats routes: the chat CRUD, the messages (a text line and the image
// cards the user attaches), the reply queue (POST /reply — one participant's
// line at a time — and /cancel), the picture of the user's turn (auto-image)
// and the per-picture controls (regenerate / cancel / replace / edit).
//
// An image is addressed by its id — a path relative to the data folder — and
// served by the /media route in routes.ts, so the files route used to hang off
// the chat folder is gone.
//
// The domain logic lives in the services (ChatsService, ReplyService); this
// file is the thin HTTP layer: parsing, validation, status codes.
export function createChatsRouter(
  chats: ChatsService,
  reply: ReplyService,
  imageGeneration: ImageGenerationService,
): express.Router {
  const router = express.Router();

  // A list of ids from a string or an array of strings (empties dropped).
  function idList(v: unknown): string[] {
    if (typeof v === "string" && v) return [v];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  }

  // The image in a request body: a string that one of the message's cards
  // actually carries.
  function imageOf(body: unknown, images: string[]): string | null {
    const image = (body as { image?: unknown })?.image;
    return typeof image === "string" && images.includes(image) ? image : null;
  }

  router.get("/", (_req, res) => {
    res.json(chats.list());
  });

  router.post("/", (req, res) => {
    const body = req.body ?? {};
    // characterIds — participants in reply priority order; a single
    // characterId is also accepted. userId — the active persona; the personas
    // that participate in the chat are derived from message authors.
    const characterIds = idList(body.characterIds ?? body.characterId);
    if (characterIds.length === 0) {
      res.status(400).json({ error: "characterId is required" });
      return;
    }
    const chat = chats.create(
      characterIds,
      typeof body.modelId === "string" ? body.modelId : "",
      typeof body.userId === "string" ? body.userId : "",
    );
    res.json(chat);
  });

  router.get("/:id", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    res.json(chat);
  });

  router.patch("/:id", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const { characterIds, modelId, visionModelId, userId, sampling, systemSuffix, name, stylePrompt } =
      req.body ?? {};
    // The chat's own name — the title in the header. An empty name is stored as
    // "no name", which is what makes the header fall back to the creation date.
    if (name !== undefined) {
      const t = typeof name === "string" ? name.trim() : "";
      if (t) chat.name = t;
      else delete chat.name;
    }
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
    // The vision model of this chat (the one that describes pictures). An empty
    // pick is a real choice: it means "no own vision model — use the chat's
    // model, or the first one that can see". A key the config does not know is
    // dropped on the next read (ensureVisionModelId), so a hand-written body
    // cannot leave the chat pointing at a model that is not there.
    if (visionModelId !== undefined) {
      const t = typeof visionModelId === "string" ? visionModelId.trim() : "";
      if (t) chat.visionModelId = t;
      else delete chat.visionModelId;
    }
    // Switching the active persona: old messages stay under their former
    // authors — the author is stored on every message.
    if (userId !== undefined) chat.userId = userId;
    // Per-chat sampling overrides: only finite numbers are kept (a null /
    // a missing field clears the whole block — the dialog sends it only
    // when at least one parameter is set).
    if (sampling !== undefined) {
      const s = (sampling ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      chat.sampling = {
        temperature: num(s.temperature),
        minP: num(s.minP),
        repetitionPenalty: num(s.repetitionPenalty),
      };
      if (Object.values(chat.sampling).every((v) => v === undefined)) delete chat.sampling;
    }
    // A free-text addition to the system prompt: a trimmed string (empty —
    // cleared) or nothing — the whole field is removed when absent.
    if (systemSuffix !== undefined) {
      const t = typeof systemSuffix === "string" ? systemSuffix.trim() : "";
      if (t) chat.systemSuffix = t;
      else delete chat.systemSuffix;
    }
    // The one look of every picture of this chat ("photorealistic, 35mm, warm
    // light"). Same rule as the system addition: a trimmed string, empty —
    // removed.
    if (stylePrompt !== undefined) {
      const t = typeof stylePrompt === "string" ? stylePrompt.trim() : "";
      if (t) chat.stylePrompt = t;
      else delete chat.stylePrompt;
    }
    chats.save(chat);
    res.json(chat);
  });

  router.delete("/:id", (req, res) => {
    res.json({ deleted: chats.delete(req.params.id) });
  });

  // Duplicates the chat: its messages, its pictures (copied into the copy's own
  // folder) and its settings. The answer is the copy — the client opens it, the
  // same way a new chat is opened.
  router.post("/:id/clone", (req, res) => {
    const copy = chats.clone(req.params.id);
    if (!copy) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    res.json({ chat: copy });
  });

  // Gives the chat a new ID — the same kind of move a character rename is: the
  // ID is the key of the chat's rows AND the name of its folder chats/<id>/, so
  // the folder, the cards and the picture ids of the chat follow it (the rules
  // and the reason are in ChatsService.rename). The new ID is a path segment,
  // so it travels in the body.
  router.post("/:id/rename", (req, res) => {
    const newId = typeof req.body?.newId === "string" ? req.body.newId.trim() : "";
    if (!newId) {
      res.status(400).json({ error: "Expected the new ID (newId field)" });
      return;
    }
    try {
      const chat = chats.rename(String(req.params.id), newId);
      res.json({ id: newId, chat });
    } catch (err) {
      // The service says why the name is not usable (taken, malformed, a
      // picture still drawing) — the banner can show it as it is.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ---- messages ----

  // Saves what the user sent: their text becomes a text message and every
  // attached picture an image card right after it. The characters' replies are
  // requested by the frontend one at a time (POST /reply) — that way it knows
  // who is "typing" now and adds lines as they are generated.
  router.post("/:id/messages", (req, res) => {
    const body = req.body ?? {};
    const text = typeof body.text === "string" ? body.text : "";
    const images = Array.isArray(body.images) ? body.images : [];
    if (!text.trim() && images.length === 0) {
      res.status(400).json({ error: "A message needs a text or a picture" });
      return;
    }
    const result = reply.attachUserImages(req.params.id, text, images);
    if (!result) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    if (result.messages.length === 0) {
      res.status(400).json({ error: "No readable message or picture in the request" });
      return;
    }
    res.json({ chat: result.chat, messages: result.messages });
  });

  // The reply of a SINGLE chat character. The frontend calls it for each
  // participant in turn (in priority order, starting with the one mentioned
  // by name): between the calls it shows whose line is being generated, and
  // the silent ones (reply === null) are skipped. The in-flight reply is
  // registered in the reply service: POST /cancel aborts the model call, and
  // the handler saves no message for a cancelled run.
  router.post("/:id/reply", async (req, res) => {
    const characterId = typeof req.body?.characterId === "string" ? req.body.characterId : "";
    // `replaceLast` (regeneration): the last assistant message is being
    // replaced — the service removes it only after the new reply is saved.
    const replaceLast = req.body?.replaceLast === true;
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    if (!characterId || !chat.characterIds.includes(characterId)) {
      res.status(400).json({ error: "The character is not a participant of the chat" });
      return;
    }
    const model = reply.resolveChatModel(chat);
    if (!model) {
      res.status(400).json({ error: "No model configured for the chat" });
      return;
    }
    const ctrl = reply.beginReply(chat.id);
    try {
      const assistantReply = await reply.appendAssistantReply(chat, model, characterId, ctrl.signal, replaceLast);
      // The service saved the reply into a chat re-read from disk (the
      // request-time snapshot is stale after the model call) — answer with
      // the current one.
      res.json({ chat: chats.get(chat.id) ?? chat, reply: assistantReply });
    } catch (err) {
      if (ctrl.signal.aborted) {
        // The user cancelled: no error message is saved, the chat stays as
        // it was. The client is already gone (it aborted its own fetch too).
        try {
          res.json({ chat: chats.get(chat.id) ?? chat, reply: null });
        } catch {
          /* the connection is closed */
        }
        return;
      }
      // The visible error line is a domain concern — the reply service
      // appends and saves it (null when the chat was deleted in the
      // meantime).
      const fresh = reply.saveErrorMessage(chat.id, characterId, (err as Error).message);
      if (fresh) {
        res.json({ chat: fresh, reply: null });
      } else {
        res.status(500).json({ error: (err as Error).message });
      }
    } finally {
      reply.endReply(chat.id, ctrl);
    }
  });

  // Cancels the in-flight reply of the chat: the model call is aborted and no
  // message is saved for it. A no-op when nothing is generating. Returns the
  // current chat so the client can re-sync (a reply that landed in the last
  // moment is already saved and stays).
  router.post("/:id/cancel", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    reply.cancelReply(chat.id);
    res.json({ chat });
  });

  // ---- the picture of the user's turn ----

  // Plans and draws a picture for the user's next turn from the whole
  // dialogue. The answer comes back as soon as the placeholder card is saved:
  // the model call and the generation run in the background and the client
  // sees the result through the usual polling, so the user can write and send
  // their own message meanwhile.
  router.post("/:id/auto-image", (req, res) => {
    if (!imageGeneration.hasAvailableGenerator()) {
      res.status(400).json({ error: "Image generation is not configured" });
      return;
    }
    const fresh = reply.requestUserTurnImage(req.params.id);
    if (!fresh) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    res.json({ chat: fresh });
  });

  // ---- one message ----

  // Edits the text of a message: the line of a text message, the description
  // (caption) of an image card.
  router.patch("/:id/messages/:messageId", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const msg = chat.messages.find((m) => m.id === req.params.messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const { text } = req.body ?? {};
    if (text !== undefined && typeof text !== "string") {
      res.status(400).json({ error: "Expected text (text field)" });
      return;
    }
    chats.editMessage(chat, msg, typeof text === "string" ? text : msg.text);
    res.json({ chat });
  });

  // Deletes a message: by default the message and all subsequent ones (trims
  // the tail of the dialogue), or only the single message with ?single=1.
  router.delete("/:id/messages/:messageId", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const single = req.query.single === "1";
    if (!chats.deleteMessage(chat, req.params.messageId, single)) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json({ chat });
  });

  // Regenerating the last reply is expressed with the primitives: the
  // frontend deletes the last message (DELETE /messages/:id) and requests one
  // line (POST /reply with its author) — no separate route is needed.

  // ---- one picture of a card ----

  // Regenerates the card's picture in the BACKGROUND (cancel the in-flight
  // job, re-translate the prompt, mark "pending" on the same id, start the
  // job — the sequence is in ReplyService.regenerateImage). An optional
  // `prompt` overrides the stored one.
  router.post("/:id/messages/:messageId/regenerate-image", async (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const msg = chat.messages.find((m) => m.id === req.params.messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const image = imageOf(req.body, msg.images);
    if (!image) {
      res.status(400).json({ error: "The message has no such image" });
      return;
    }
    if (!imageGeneration.hasAvailableGenerator()) {
      res.status(400).json({ error: "Image generation is not configured" });
      return;
    }
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : undefined;
    const fresh = await reply.regenerateImage(chat, msg, image, prompt);
    if (!fresh) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json({ chat: fresh });
  });

  // Replaces the card's picture with a file the user picked (a data URL): the
  // new image is saved under its own id and the card loses its generation data
  // (the domain part is in ReplyService.replaceImage).
  router.post("/:id/messages/:messageId/replace-image", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const msg = chat.messages.find((m) => m.id === req.params.messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const image = imageOf(req.body, msg.images);
    const data = req.body?.data;
    if (!image) {
      res.status(400).json({ error: "The message has no such image" });
      return;
    }
    if (typeof data !== "string" || !data.startsWith("data:")) {
      res.status(400).json({ error: "Expected a data URL (data field)" });
      return;
    }
    const fresh = reply.replaceImage(chat, msg, image, data);
    if (!fresh) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json({ chat: fresh });
  });

  // Cancels the in-flight generation of the card's picture (the domain part —
  // cancel the job + mark it "cancelled" — is in ReplyService.cancelImage).
  router.post("/:id/messages/:messageId/cancel-image", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const msg = chat.messages.find((m) => m.id === req.params.messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const image = imageOf(req.body, msg.images);
    if (!image) {
      res.status(400).json({ error: "The message has no such image" });
      return;
    }
    const fresh = reply.cancelImage(chat, msg, image);
    res.json({ chat: fresh });
  });

  // Edits what the card says about its picture — the picture-editor dialog:
  // the description (what is on it), the prompt it should be redrawn with, the
  // picture itself (`image` — an existing image id of the data folder the card
  // should point at) and the `kind` the card is now ("generated" / "file").
  // The picture's row of the images table is updated along with the message, so
  // the one source a card is read from never lags behind.
  router.patch("/:id/messages/:messageId/picture", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const msg = chat.messages.find((m) => m.id === req.params.messageId);
    if (!msg) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    const { description, prompt, image, kind, refs, depicts } = req.body ?? {};
    if (description !== undefined && typeof description !== "string") {
      res.status(400).json({ error: "Expected description (string)" });
      return;
    }
    if (prompt !== undefined && typeof prompt !== "string") {
      res.status(400).json({ error: "Expected prompt (string)" });
      return;
    }
    // The references and the cast arrive as lists of ids; anything else in the
    // list is dropped rather than rejected — a half-parsed catalog entry is
    // still a valid edit of the rest of it.
    if (refs !== undefined && !Array.isArray(refs)) {
      res.status(400).json({ error: "Expected refs (a list of picture ids)" });
      return;
    }
    if (depicts !== undefined && !Array.isArray(depicts)) {
      res.status(400).json({ error: "Expected depicts (a list of participant ids)" });
      return;
    }
    if (Array.isArray(refs)) {
      for (const ref of refs as unknown[]) {
        if (typeof ref !== "string" || !PathHelper.resolveImageId(ref)) {
          res.status(400).json({ error: `Unknown picture "${String(ref)}"` });
          return;
        }
      }
    }
    if (kind !== undefined && kind !== "generated" && kind !== "file") {
      res.status(400).json({ error: 'Expected kind "generated" or "file"' });
      return;
    }
    if (image !== undefined) {
      if (typeof image !== "string") {
        res.status(400).json({ error: "Expected image (string)" });
        return;
      }
      // The picture the card should point at: a picture of the data folder the
      // media route can serve (the same rule the /media route applies).
      const file = PathHelper.resolveImageId(image);
      if (!file || !fs.existsSync(file) || !HttpHelper.isImage(file)) {
        res.status(400).json({ error: `Unknown picture "${image}"` });
        return;
      }
      // The picture the card carries now may still be generating — repointing
      // it would leave the job writing to an id nobody points at any more.
      if (msg.images[0] !== image && msg.imageStatus?.[msg.images[0]] === "pending") {
        res.status(400).json({ error: "The picture is still being generated" });
        return;
      }
    }
    const fresh = reply.editPicture(chat, msg, {
      ...(description !== undefined ? { description } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(image !== undefined ? { image } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(refs !== undefined
        ? { refs: (refs as unknown[]).filter((x): x is string => typeof x === "string") }
        : {}),
      ...(depicts !== undefined
        ? { depicts: (depicts as unknown[]).filter((x): x is string => typeof x === "string") }
        : {}),
    });
    if (!fresh) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json({ chat: fresh });
  });

  return router;
}
