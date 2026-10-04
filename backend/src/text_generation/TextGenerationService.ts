import fs from "fs";
import path from "path";
import { Chat } from "../chats/Chat";
import { ChatMessage } from "../chats/ChatMessage";
import { Config } from "../configuration/Config";
import { Model } from "../configuration/Model";
import { PathHelper } from "../configuration/PathHelper";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { createToken } from "../di";

// The DI token of the LLM service (registered in index.ts).
export const DI_TEXT_GENERATION_SERVICE = createToken<TextGenerationService>("TextGenerationService");

// A model request to generate an image: prompt + reference numbers from the inventory (from 1).
export type ImageRequest = { prompt: string; refs: number[] };

// One part of an OpenAI-compatible message content: text or an inline image.
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type MessageParam = { role: string; content: string | ContentPart[] };

// The top-level LLM service: the OpenAI-compatible provider client
// (chatCompletion — text + images with the no-mmproj retry, translatePrompt)
// and the prompt/history helpers the reply pipeline is built from (the system
// prompt, the [IMG]/[PHOTO] tag parsing, the [SILENT] handling, author labels,
// history trimming). The service is stateless — every call works on its
// arguments; the provider key and the model list are resolved through the
// lower-level configuration service, the chat file paths through the shared
// data layout.
export class TextGenerationService {
  constructor(private readonly configuration: ConfigurationService) {}

  // Image MIME types by file extension (image_url parts are sent as data URIs).
  private static readonly MIME_BY_EXT: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };

  // Signs of the provider refusing specifically because of an image (for
  // example, llama-server without an mmproj answers 500 "image input is not supported").
  private static readonly IMAGE_REJECT_RE = /image input|images? (?:are |is )?not supported|mmproj|multimodal/i;

  // ---- model resolution ----

  // The model a chat should use: the llmModels entry the chat references
  // (chat.modelId is the llmModels key = Model.name), falling back to the
  // first model so a chat whose model was renamed or deleted keeps working.
  resolveModel(config: Config, chat: Chat): Model | null {
    const models = this.configuration.listModels(config);
    return models.find((m) => m.name === chat.modelId) ?? models[0] ?? null;
  }

  // ---- prompts and history ----

  // person — the active persona (users/<id>/user.json); if it has a persona
  // description, the model knows who it is talking to. fellowCharacters — the
  // other characters in the chat: in a group chat the prompt explains the reply
  // order and allows staying silent with the [SILENT] tag. canGenerateImages
  // enables the instruction about self-initiated image generation with the
  // [IMG:description | refs] tag; imageInventory — a text list of available
  // reference images (built by routes from ImageGenerationService.imageInventory).
  // The inventory is included regardless of the generator: the [PHOTO:number]
  // tag works by it too — send an existing image as-is without generation.
  systemPromptFor(
    character: { name: string; description: string },
    person?: { name: string; description: string } | null,
    canGenerateImages = false,
    imageInventory?: string,
    fellowCharacters: Array<{ name: string; description: string }> = [],
  ): string {
    let prompt = `You are ${character.name}. ${character.description}\nStay in character; never break role.`;
    prompt += "\nKeep replies short: 2–5 sentences, one short paragraph. No long monologues.";
    prompt +=
      "\nWrite character dialogue as plain text. Anything that is not dialogue — descriptions of the " +
      "setting, actions and atmosphere — goes in /* ... */ (for example: /*Yaroslav sits at the bar and takes a sip.*/).";
    if (fellowCharacters.length > 0) {
      const list = fellowCharacters.map((c) => `${c.name} — ${c.description || "a character"}`).join("; ");
      prompt +=
        `\nThis is a group chat: other characters are also present — ${list}. ` +
        "Each character takes turns to reply. Reply only as yourself (" +
        `${character.name}); do not write dialogue for the others. ` +
        "Do not copy or paraphrase other characters' replies — write only your own line. " +
        "If someone addresses you by name or asks you a question — reply yourself, do not stay silent.";
    }
    if (person && person.description.trim()) {
      const name = person.name.trim();
      prompt += `\nYou are talking to ${name || "the user"}. ${person.description.trim()}`;
    }
    if (fellowCharacters.length > 0) {
      prompt +=
        "\nIf it is not your turn, no one addressed you and you have nothing to add to the conversation — " +
        "output exactly [SILENT] instead of a reply and nothing else. In all other cases reply as usual.";
    }
    if (canGenerateImages) {
      prompt +=
        "\nYou can create images: insert a [IMG:detailed scene description] tag into your reply, and the tag will be replaced with a real image. " +
        "If the image should be based on specific existing images (a person's appearance from a photo, a scene, a style) — reference them by number: [IMG:description | 1,3]. " +
        "Write the scene description in the tag in English ONLY (the generator understands it best); 1–3 sentences is enough. " +
        "If the user explicitly asks you to send or show a photo — you MUST insert the tag. " +
        "On your own initiative, insert the tag when you want to show an image.";
    }
    if (imageInventory) {
      prompt +=
        "\nYou can also send one of the images below as-is, without generating a new one: insert a [PHOTO:number] tag " +
        "(several at once — comma separated: [PHOTO:1,3]), and the tag will be replaced by that image. " +
        "The numbering matches the [IMG] reference numbers.\n" +
        "Available images:\n" +
        imageInventory;
    }
    return prompt;
  }

  // Extracts [IMG:description] / [IMG:description | 1,3] tags from a model reply.
  // Strict format: without a colon and a description ([IMG]) it is not a tag —
  // otherwise a model that copied the tag literally would get an empty-prompt image.
  extractImageRequests(text: string): { text: string; requests: ImageRequest[] } {
    const requests: ImageRequest[] = [];
    const clean = text.replace(
      /\[IMG:\s*([^\]|]*?)(?:\s*\|\s*([^\]]*))?\][ \t]*/gi,
      (_match, desc: string, refsStr?: string) => {
        requests.push({
          prompt: desc.trim(),
          refs: (refsStr ?? "")
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0),
        });
        return "";
      },
    );
    return { text: clean.replace(/\n{3,}/g, "\n\n").trim(), requests };
  }

  // Extracts [PHOTO:number] / [PHOTO:1,3] tags from a model reply — a request
  // to send an existing image from the inventory (a character photo or a chat
  // image) as-is, without generation. Strict format: numbers only — a bare
  // [PHOTO] or [PHOTO:] is not a tag and stays literal text.
  extractPhotoRequests(text: string): { text: string; photos: number[] } {
    const photos: number[] = [];
    const clean = text.replace(/\[PHOTO:\s*(\d+(?:\s*,\s*\d+)*)\s*\][ \t]*/gi, (_match, nums: string) => {
      for (const part of nums.split(",")) {
        const n = parseInt(part.trim(), 10);
        if (Number.isFinite(n) && n > 0) photos.push(n);
      }
      return "";
    });
    return { text: clean.replace(/\n{3,}/g, "\n\n").trim(), photos };
  }

  // The character decided to stay silent: the reply is only the [SILENT] tag
  // (case-insensitive, surrounding whitespace allowed). Stray [SILENT]
  // occurrences inside text are removed but do not count as silence.
  parseSilence(reply: string): string | null {
    if (/^\s*\[SILENT\]\s*$/i.test(reply)) return null;
    return reply.replace(/\[SILENT\]\s*/gi, "").trim();
  }

  // Strips artifact "Name: " prefixes at the start of a reply: the model copies
  // author labels from the labeled history ("Bob: Bob: …") or adds its
  // own prefix. Only repetitions of known participant names are removed, from
  // the start of the text; the rest of the text is left as-is.
  stripNamePrefixes(text: string, names: string[]): string {
    const known = [...new Set(names.map((n) => n.trim()).filter(Boolean))].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    if (known.length === 0) return text;
    const re = new RegExp(`^\\s*(?:${known.join("|")})\\s*:\\s*`, "i");
    let out = text;
    while (re.test(out)) out = out.replace(re, "");
    return out.trim();
  }

  // Labels lines with their authors when the chat has several characters or
  // several personas — otherwise the model cannot tell who said what. The caller
  // decides `multi` (chat.characterIds.length > 1 || distinct user authors > 1).
  labelHistory(
    history: ChatMessage[],
    characterNames: Record<string, string>, // characterId -> name
    userNames: Record<string, string>, // userId -> name
    multi: boolean,
  ): ChatMessage[] {
    if (!multi) return history;
    return history.map((m) => {
      if (m.role === "assistant" && m.characterId && characterNames[m.characterId]) {
        return { ...m, text: `${characterNames[m.characterId]}: ${m.text}` };
      }
      if (m.role === "user" && m.userId && userNames[m.userId]) {
        return { ...m, text: `${userNames[m.userId]}: ${m.text}` };
      }
      return m;
    });
  }

  // Trims the history to fit the context (rough estimate: 1 token ≈ 4 chars, image ≈ 1000 tokens).
  // The first message (the system prompt) is always kept.
  trimHistory(history: ChatMessage[], contextSize: number): ChatMessage[] {
    const estimate = (message: ChatMessage): number =>
      Math.ceil(message.text.length / 4) + (message.images?.length ?? 0) * 1000;
    const [first, ...rest] = history;
    const kept: ChatMessage[] = [];
    let total = estimate(first);
    for (let i = rest.length - 1; i >= 0; i--) {
      total += estimate(rest[i]);
      if (total > contextSize * 3 && kept.length >= 2) break;
      kept.unshift(rest[i]);
    }
    return [first, ...kept];
  }

  // ---- the provider client ----

  // Translates a generation prompt to English (manual input may be in another language).
  async translatePrompt(model: Model, text: string): Promise<string> {
    return this.requestCompletion(model, [
      {
        role: "system",
        content:
          "Translate the image generation prompt text into English. " +
          "Return only the translation, without quotes or explanations.",
      },
      { role: "user", content: text },
    ]);
  }

  // The main model call of a chat reply: the system prompt + the labeled
  // history (with images for a model that supports them) + an optional closing
  // note. When the provider rejects the request because of an image (a model
  // without an mmproj), the request is retried text-only so the dialogue is
  // not aborted with a 500 error — the reply notes the image was dropped.
  async chatCompletion(
    model: Model,
    systemPrompt: string,
    history: ChatMessage[],
    chatId: string,
    closingNote?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const toMessages = (withImages: boolean): MessageParam[] => {
      const msgs: MessageParam[] = [
        { role: "system", content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: withImages ? this.buildContent(model, m, chatId) : m.text })),
      ];
      if (closingNote) {
        // The role reminder must stand at the END of the context, but providers
        // like llama.cpp (Jinja templates) accept system only as the first
        // message — so it is appended to the last user message, or, when the
        // history ends with an assistant reply, as a separate user line in
        // square brackets (like author notes).
        const note = `[${closingNote}]`;
        const last = msgs[msgs.length - 1];
        if (last && last.role === "user") {
          if (typeof last.content === "string") {
            last.content = `${last.content}\n${note}`;
          } else {
            last.content = [...last.content, { type: "text", text: note }];
          }
        } else {
          msgs.push({ role: "user", content: note });
        }
      }
      return msgs;
    };

    try {
      return await this.requestCompletion(model, toMessages(true), signal);
    } catch (err) {
      // A model without an mmproj rejects the image — retry with text only so
      // the dialogue is not aborted with a 500 error. A cancel (an aborted
      // signal) is never retried: its error does not look like an image reject.
      const sentImages = history.some((m) => (m.images?.length ?? 0) > 0);
      if (!sentImages || !TextGenerationService.IMAGE_REJECT_RE.test((err as Error).message)) throw err;
      try {
        const reply = await this.requestCompletion(model, toMessages(false), signal);
        return `⚠️ The model rejected the image — the message was sent without it.\n\n${reply}`;
      } catch {
        throw err;
      }
    }
  }

  // One /chat/completions call: the OpenAI-compatible request (the api key,
  // the reasoning level in both spellings) and the reply extraction.
  private async requestCompletion(model: Model, messages: MessageParam[], signal?: AbortSignal): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = this.configuration.resolveApiKey(model);
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    // The model id may be left empty in the config — then the provider picks the
    // default model itself, so the `model` field is simply not sent.
    const payload: Record<string, unknown> = {
      messages,
      max_tokens: Math.max(256, Math.floor(model.contextSize / 4)),
    };
    if (model.id) payload.model = model.id;
    // The reasoning level (when enabled) is sent in the two common
    // OpenAI-compatible spellings: top-level reasoning_effort (OpenAI,
    // llama.cpp) and reasoning.effort (OpenRouter). A provider ignores the
    // field it does not know, so sending both is safe.
    if (model.reasoning) {
      payload.reasoning_effort = model.reasoning;
      payload.reasoning = { effort: model.reasoning };
    }

    const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // The reply can be cancelled by the user (POST /chats/:id/cancel): the
      // abort rejects this fetch, the caller decides what to do with it.
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Provider returned ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | ContentPart[] } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    }
    throw new Error("Provider returned an empty response");
  }

  // Message content for the provider: the text plus, for a model with image
  // support, the message images as image_url data-URIs (missing files are
  // silently dropped).
  private buildContent(model: Model, message: ChatMessage, chatId: string): string | ContentPart[] {
    const filesDir = PathHelper.chatFilesDir(chatId);
    const images = (message.images ?? [])
      .map((name) => path.join(filesDir, path.basename(name)))
      .filter((file) => fs.existsSync(file));

    if (model.supportsImages && images.length > 0) {
      const parts: ContentPart[] = [];
      if (message.text) parts.push({ type: "text", text: message.text });
      for (const file of images) {
        parts.push({ type: "image_url", image_url: { url: TextGenerationService.imageDataUrl(file) } });
      }
      return parts;
    }
    return message.text;
  }

  private static imageDataUrl(file: string): string {
    const mime = TextGenerationService.MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "image/png";
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  }
}
