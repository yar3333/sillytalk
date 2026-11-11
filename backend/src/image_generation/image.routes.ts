import express from "express";
import fs from "fs";
import { ChatsService } from "../chats/ChatsService";
import { PICTURE_LANGUAGES } from "../configuration/PictureLanguage";
import { ReplyService } from "../reply/ReplyService";
import { HttpHelper } from "../shared/HttpHelper";
import { PathHelper } from "../shared/PathHelper";
import { ImageGenerationService } from "./ImageGenerationService";
import { comfyUiModelNames } from "./comfyui/ComfyUiWorkflows";

// The /image routes: the availability flag (it decides whether the picture
// buttons of the input bar are shown) and the helpers of the picture-editor
// dialog: the three LLM calls ("From the chat", "Make it English", "Describe the
// picture") and the caption of an attached card. Drawing itself lives with the
// chat it happens in — /chats/:id/picture-request, /auto-image, /picture-file —
// because a picture of this app is always a message of one conversation.
export function createImageRouter(
  imageGeneration: ImageGenerationService,
  reply: ReplyService,
  chats: ChatsService,
): express.Router {
  const router = express.Router();

  router.get("/status", (_req, res) => {
    res.json({
      available: imageGeneration.hasAvailableGenerator(),
      // The image models a ComfyUI generator can be pointed at: what the app
      // ships a workflow for (the settings dialog offers exactly these).
      comfyUiModels: comfyUiModelNames(),
      // The languages a picture's description can be written in — the Settings
      // dialog fills its pick from here, so the list of what the model can be
      // asked for lives in one place (configuration/PictureLanguage.ts).
      pictureLanguages: PICTURE_LANGUAGES,
    });
  });

  // There is no "draw this exact prompt" endpoint any more. A picture of this
  // app is always a PICTURE WITH A STORY: it is asked for in words
  // (POST /api/chats/:id/picture-request), planned by the model into a drawing
  // prompt plus a reference set, and only then handed to a generator — which is
  // what keeps a named person the same face from picture to picture. The one
  // place a literal prompt is still written by hand is the picture editor of a
  // card, and it redraws through /chats/:id/messages/:id/regenerate-image.

  // ---- the picture-editor dialog ----
  //
  // (the catalog of the pictures the dialog can point a card at is the picture
  // browser's own route: GET /api/pictures — one list of the data folder, with
  // the row of the images table that belongs to each picture)

  // The prompt for a card, planned by the model from the dialogue (the "From
  // the chat" button). The answer is the finished prompt, the description the
  // plan suggests and the reference pictures it was built around — the three
  // belong together, since the prompt says what each of those images is for.
  // 502 — the model gave nothing usable (it never fails the request with an
  // exception: a missing model is the same as an unreadable answer).
  router.post("/prompt", async (req, res) => {
    try {
      const { chatId, messageId } = req.body ?? {};
      const chat = typeof chatId === "string" ? chats.get(chatId) : null;
      if (!chat) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      if (messageId !== undefined && typeof messageId !== "string") {
        res.status(400).json({ error: "Expected messageId (string)" });
        return;
      }
      const plan = await reply.planPicturePrompt(chat.id, typeof messageId === "string" ? messageId : undefined);
      if (!plan) {
        res.status(502).json({ error: "The model did not describe a picture to draw" });
        return;
      }
      res.json(plan);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Rewrites a typed prompt into an English one shaped for the generator (the
  // "Make it English" button).
  router.post("/tune-prompt", async (req, res) => {
    try {
      const { chatId, prompt } = req.body ?? {};
      const chat = typeof chatId === "string" ? chats.get(chatId) : null;
      if (!chat) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      if (typeof prompt !== "string" || !prompt.trim()) {
        res.status(400).json({ error: "Prompt is required" });
        return;
      }
      const tuned = await reply.tunePicturePrompt(chat.id, prompt);
      if (tuned === null) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      res.json({ prompt: tuned });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // One sentence about a picture (the "Describe the picture" button): an
  // existing picture of the data folder (`image`) or a data URL of a file the
  // user just picked (`data`). Needs a model with vision — without one the
  // answer is a 400 the banner can show as-is.
  router.post("/describe", async (req, res) => {
    try {
      const { chatId, image, data } = req.body ?? {};
      const chat = typeof chatId === "string" ? chats.get(chatId) : null;
      if (!chat) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      if (typeof image !== "string" && typeof data !== "string") {
        res.status(400).json({ error: "Expected a picture id (image) or a data URL (data)" });
        return;
      }
      if (typeof image === "string") {
        const file = PathHelper.resolvePictureId(image);
        if (!file || !fs.existsSync(file) || !HttpHelper.isImage(file)) {
          res.status(400).json({ error: `Unknown picture "${image}"` });
          return;
        }
      }
      if (typeof data === "string" && !data.startsWith("data:image/")) {
        res.status(400).json({ error: "Expected a picture data URL" });
        return;
      }
      const model = reply.resolveVisionModel();
      if (!model || !model.supportsImages) {
        res.status(400).json({ error: ReplyService.noVisionMessage(model) });
        return;
      }
      const description = await reply.describePicture(chat.id, {
        ...(typeof image === "string" ? { imageId: image } : {}),
        ...(typeof data === "string" ? { dataUrl: data } : {}),
      });
      if (description === null) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      res.json({ description });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Writes the caption of a picture card the user attached without one (the 📎
  // flow calls this right after saving the message, so the picture gets a line
  // the chat model can read even when it cannot see). A card that already has a
  // caption, a chat with nothing to look with and a model that could not answer
  // all leave the card as it is — and the answer is the current chat either way,
  // so the client just applies it. An unlabelled picture is a normal state, not
  // a failed request, so this route has no error path of its own.
  router.post("/caption", async (req, res) => {
    try {
      const { chatId, messageId } = req.body ?? {};
      if (typeof chatId !== "string" || typeof messageId !== "string") {
        res.status(400).json({ error: "chatId and messageId are required" });
        return;
      }
      const chat = await reply.captionPicture(chatId, messageId);
      if (!chat) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      res.json({ chat });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
