import express from "express";
import path from "path";
import { CharactersService } from "../characters/CharactersService";
import { PathHelper } from "../shared/PathHelper";
import { ImageGenerationService } from "../image_generation/ImageGenerationService";
import { ReplyService } from "../reply/ReplyService";
import { HttpHelper } from "../shared/HttpHelper";
import { ChatsService } from "./ChatsService";

// The /chats routes: the chat CRUD, the messages (send/edit/delete), the
// reply queue (POST /reply — one participant's line at a time — and
// /cancel), and the per-image generation controls (regenerate/cancel).
// The domain logic lives in the services (ChatsService, ReplyService); this
// file is the thin HTTP layer: parsing, validation, status codes.
export function createChatsRouter(
  chats: ChatsService,
  reply: ReplyService,
  characters: CharactersService,
  imageGeneration: ImageGenerationService,
): express.Router {
  const router = express.Router();

  // A list of ids from a string or an array of strings (empties dropped).
  function idList(v: unknown): string[] {
    if (typeof v === "string" && v) return [v];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
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
    chats.save(chat);
    res.json(chat);
  });

  router.delete("/:id", (req, res) => {
    res.json({ deleted: chats.delete(req.params.id) });
  });

  router.get("/:id/files/:name", (req, res) => {
    HttpHelper.sendImage(res, path.join(PathHelper.chatFilesDir(req.params.id), path.basename(req.params.name)));
  });

  // Imports a character photo into the chat files/ (for use as a reference)
  router.post("/:id/import-photo", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const { characterId, photo } = req.body ?? {};
    const character = characters.get(characterId);
    if (!character) {
      res.status(404).json({ error: "Character not found" });
      return;
    }
    const photoPath = characters.photoFile(character.id, String(photo));
    const name = photoPath ? chats.importCharacterPhoto(chat.id, photoPath) : null;
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
  router.post("/:id/messages", (req, res) => {
    const chat = chats.get(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    chats.addUserMessage(chat, req.body?.text ?? "", req.body?.images ?? []);
    res.json({ chat });
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
      res.json({ chat, reply: assistantReply });
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

  // Edits an existing message: the text and/or the image list
  // (a data URL — a new image, a file name — an already uploaded one).
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
    const { text, images } = req.body ?? {};
    if (text !== undefined && typeof text !== "string") {
      res.status(400).json({ error: "Expected text (text field)" });
      return;
    }
    if (images !== undefined && !Array.isArray(images)) {
      res.status(400).json({ error: "Expected an image list (images field)" });
      return;
    }
    chats.editMessage(chat, msg, text, images as string[] | undefined);
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

  // Regenerates one message image in the BACKGROUND (the domain sequence —
  // cancel the in-flight job, re-translate the prompt, mark "pending" on the
  // same reserved name, start the job — is in ReplyService.regenerateImage).
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
    const image = req.body?.image;
    if (typeof image !== "string" || !msg.images.includes(image)) {
      res.status(400).json({ error: "The message has no such image" });
      return;
    }
    if (!imageGeneration.hasAvailableGenerator()) {
      res.status(400).json({ error: "Image generation is not configured" });
      return;
    }
    const fresh = await reply.regenerateImage(chat, msg, image);
    if (!fresh) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json({ chat: fresh });
  });

  // Cancels the in-flight generation of one message image (the domain part —
  // cancel the job + mark the image "cancelled" — is in
  // ReplyService.cancelImage).
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
    const image = req.body?.image;
    if (typeof image !== "string" || !msg.images.includes(image)) {
      res.status(400).json({ error: "The message has no such image" });
      return;
    }
    const fresh = reply.cancelImage(chat, msg, image);
    res.json({ chat: fresh });
  });

  return router;
}
