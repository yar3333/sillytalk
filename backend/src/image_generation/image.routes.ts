import express from "express";
import fs from "fs";
import { ChatsService } from "../chats/ChatsService";
import { ReplyService } from "../reply/ReplyService";
import { HttpHelper } from "../shared/HttpHelper";
import { PathHelper } from "../shared/PathHelper";
import { ImageGenerationService } from "./ImageGenerationService";
import { comfyUiModelNames } from "./comfyui/ComfyUiWorkflows";

// The /image routes: the availability flag (it decides whether the "🎨" prompt
// box and the "📷" turn button are shown on the frontend), the one-shot manual
// generation (the card with the "pending" image is saved right away; the file
// appears when the job finishes — the domain part, including the
// English-prompt translation, is in ReplyService.manualImage) and the helpers
// of the picture-editor dialog: the catalog of the data folder's pictures and
// the three LLM calls ("From the chat", "Make it English", "Describe the
// picture").
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
    });
  });

  router.post("/", async (req, res) => {
    try {
      const { chatId, prompt, refs } = req.body ?? {};
      const chat = chats.get(chatId);
      if (!chat) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      if (!prompt) {
        res.status(400).json({ error: "Prompt is required" });
        return;
      }
      if (!imageGeneration.hasAvailableGenerator()) {
        res.status(400).json({ error: "Image generation is not configured" });
        return;
      }
      const refList = Array.isArray(refs) ? (refs as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const result = await reply.manualImage(chat, String(prompt), refList);
      if (!result) {
        // The chat was deleted while the prompt was translating.
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      res.json({ chat: result.chat, message: result.message });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---- the picture-editor dialog ----

  // The picture catalog: every picture of the data folder as an image id,
  // newest first — the "from a file" pick. PathHelper.listPictureIds walks only
  // the folders pictures live in, so each id it offers loads through /media.
  router.get("/pictures", (_req, res) => {
    res.json({ images: PathHelper.listPictureIds() });
  });

  // The prompt for a card, planned by the model from the dialogue (the "From
  // the chat" button). The answer also carries the description the plan
  // suggests; 502 — the model gave nothing usable (it never fails the request
  // with an exception: a missing model is the same as an unreadable answer).
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
      res.json({ prompt: plan.prompt, description: plan.description });
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
      const model = reply.resolveChatModel(chat);
      if (!model) {
        res.status(400).json({ error: "No model configured for the chat" });
        return;
      }
      if (!model.supportsImages) {
        res.status(400).json({ error: "The chat's model cannot see pictures — choose a model that supports images" });
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

  return router;
}
