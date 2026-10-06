import express from "express";
import { ChatsService } from "../chats/ChatsService";
import { ReplyService } from "../reply/ReplyService";
import { ImageGenerationService } from "./ImageGenerationService";

// The /image routes: the availability flag (the "🎨" button and auto-[IMG] on
// the frontend) and the one-shot manual generation (the message with the
// "pending" image is saved right away; the file appears when the job
// finishes — the domain part, including the English-prompt translation, is
// in ReplyService.manualImage).
export function createImageRouter(
  imageGeneration: ImageGenerationService,
  reply: ReplyService,
  chats: ChatsService,
): express.Router {
  const router = express.Router();

  router.get("/status", (_req, res) => {
    res.json({ available: imageGeneration.hasAvailableGenerator() });
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

  return router;
}
