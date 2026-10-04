import express from "express";
import { ChatsService } from "../chats/ChatsService";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { ReplyService } from "../reply/ReplyService";
import { TextGenerationService } from "../text_generation/TextGenerationService";
import { ImageGenerationService } from "./ImageGenerationService";

// The /image routes: the availability flag (the "🎨" button and auto-[IMG] on
// the frontend) and the one-shot manual generation (the message with the
// "pending" image is saved right away; the file appears when the job
// finishes — the domain part is in ReplyService.manualImage).
export function createImageRouter(
  imageGeneration: ImageGenerationService,
  reply: ReplyService,
  chats: ChatsService,
  textGeneration: TextGenerationService,
  configuration: ConfigurationService,
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
      // The prompt is required in English: Russian is translated with the
      // chat's model.
      const model = textGeneration.resolveModel(configuration.loadConfig(), chat);
      const finalPrompt = await imageGeneration.ensureEnglishPrompt(model, String(prompt));
      const refList = Array.isArray(refs) ? (refs as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const { chat: saved, message } = reply.manualImage(chat, finalPrompt, refList);
      res.json({ chat: saved, message });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
