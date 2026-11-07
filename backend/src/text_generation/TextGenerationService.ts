import fs from "fs";
import path from "path";
import { Chat, ChatSampling } from "../chats/Chat";
import { ChatMessage, isImageMessage } from "../chats/ChatMessage";
import { Config } from "../configuration/Config";
import { Model } from "../configuration/Model";
import { PathHelper } from "../shared/PathHelper";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { createToken } from "../di";

// The DI token of the LLM service (registered in index.ts).
export const DI_TEXT_GENERATION_SERVICE = createToken<TextGenerationService>("TextGenerationService");

// One picture the image-prompt request may use as material: its id (a path
// relative to the data folder), what is on it and how it got there. The model
// picks the references by the 1-based number it sees in the list.
export type ImageBrief = {
  id: string;
  description?: string;
  prompt?: string;
  // Who showed the user this picture ("the user", "Alice") and when it
  // appeared ("3 messages ago"), so the model can tell the recent from the old.
  owner?: string;
  age?: string;
  // upload — the user attached it, manual/auto — it was generated.
  origin?: string;
  // What the picture is worth AS A REFERENCE. "chat" (the default) — something
  // that happened in the conversation, worth keeping for a place or a style;
  // "look" — a picture whose only job is to say what one person looks like (a
  // character photo, an avatar, an earlier picture of the same person).
  role?: "chat" | "look";
  // The cast ref (`char:alice`) of the person a look reference belongs to.
  ofWho?: string;
  // Pre-rendered for the list: who is visible on the picture ("Alice",
  // "Alice and Bob"). Names belong to this text only — the generator never
  // sees them, see the no-names rule of composeImagePrompt.
  shows?: string;
};

// One participant a picture can show. The generator has never heard of these
// people, so the planner works with the name and the look description and
// answers by the cast `ref`; the app turns that into reference images.
export type ImageCastMember = {
  // Stable id the plan echoes back in `cast`: "char:<id>" / "user:<id>".
  ref: string;
  name: string;
  // What this person looks like, in English — the visual half of their card.
  look?: string;
  // Numbers (1-based, in the picture list below) of the pictures that show
  // them — the anchors the app can draw the face from.
  anchors: number[];
};

// What the image-prompt request answers: a short English name for the file,
// the caption of the result, the generation prompt, the reference numbers and
// the people in the scene.
export type ImagePromptPlan = {
  name: string;
  description: string;
  prompt: string;
  refs: number[];
  // Cast refs of the people the picture shows.
  cast: string[];
  // The visual phrase the prompt uses for a person ("the red-haired woman"),
  // so the app can bind them to a reference image without ever naming them.
  subjects: Array<{ ref: string; noun: string }>;
};

// One part of an OpenAI-compatible message content: text or an inline image.
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type MessageParam = { role: string; content: string | ContentPart[] };

// The top-level LLM service: the OpenAI-compatible provider client
// (chatCompletion — text + images with the no-mmproj retry, translatePrompt,
// composeImagePrompt) and the prompt/history helpers the reply pipeline is
// built from (the system prompt, the [SILENT] handling, author labels, history
// trimming). The service is stateless — every call works on its arguments; the
// provider key and the model list are resolved through the lower-level
// configuration service, the image files through the shared data layout (an
// image is named by its path relative to the data folder).
//
// A character never asks for an image: the [IMG]/[PHOTO] tag protocol is gone,
// and the system prompt no longer offers one. Pictures are the user's own —
// attached, drawn on request, or planned by composeImagePrompt for the user's
// turn.
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

  // The model that looks at pictures for this chat (the one that writes card
  // captions). Three cases, in order:
  //  - the chat picked one (the header's vision menu) — that pick is honoured
  //    even when the model cannot see, so the caller's guard can say plainly
  //    "this model cannot see pictures" instead of quietly using another;
  //  - the chat's own model can see — nothing to add, it does both jobs;
  //  - otherwise the first vision-capable model of the config, which is the
  //    user's own ranking: a roleplay model with no vision still gets the
  //    user's pictures described, and the caption is what such a model reads
  //    about them in the history.
  // Null when no model of the config can see at all.
  resolveVisionModel(config: Config, chat: Chat): Model | null {
    const models = this.configuration.listModels(config);
    if (chat.visionModelId) {
      const picked = models.find((m) => m.name === chat.visionModelId);
      if (picked) return picked;
    }
    const own = models.find((m) => m.name === chat.modelId);
    if (own?.supportsImages) return own;
    return models.find((m) => m.supportsImages) ?? null;
  }

  // ---- prompts and history ----

  // person — the active persona (users/<id>/user.json); if it has a persona
  // description, the model knows who it is talking to. fellowCharacters — the
  // other characters in the chat: in a group chat the prompt explains the reply
  // order and allows staying silent with the [SILENT] tag.
  //
  // The prompt offers no image protocol: a character cannot attach or generate
  // a picture — those are the user's messages only.
  systemPromptFor(
    character: { name: string; description: string },
    person?: { name: string; description: string } | null,
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
    prompt +=
      "\nYou cannot send or create images — text only. When the user shares a picture, describe or react to it in words instead.";
    return prompt;
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

  // Prepares a prompt for the generator: it is translated to English AND
  // rewritten the way a text-to-image model reads best — the "Make it English"
  // button of the picture editor. Unlike translatePrompt this is not a literal
  // translation: the model may reorder and enrich the text (subject first, then
  // setting, light and style) while keeping everything the user asked for.
  async tunePrompt(model: Model, text: string, sampling?: ChatSampling): Promise<string> {
    return this.requestCompletion(
      model,
      [
        {
          role: "system",
          content:
            "You prepare an image generation prompt for a text-to-image model. " +
            "Rewrite the user's text as ONE prompt in English: keep every subject, action, place and " +
            "detail it mentions; put the subject and the action first, then the setting, the lighting, " +
            "the mood and the style; you may add details that make the picture better, but never people, " +
            "events or objects the text does not imply. " +
            "Answer with the prompt itself: a flowing description of the scene, no lists, no quotes, " +
            'no preamble, no "image of".',
        },
        { role: "user", content: text },
      ],
      undefined,
      sampling,
    );
  }

  // Describes a picture with a model that can see: one sentence in English
  // saying what is on it — the "Describe the picture" button of the editor.
  // The text becomes the card's caption, which is also what a model without
  // vision is told about the picture in the history.
  //
  // The picture comes either as an image id of the data folder (a picture the
  // chat already has, or one picked from the catalog) or as a data URL (a file
  // the user just picked from disk).
  async describePicture(
    model: Model,
    input: { imageId?: string; dataUrl?: string },
    sampling?: ChatSampling,
  ): Promise<string> {
    if (!model.supportsImages) {
      throw new Error("The model cannot see pictures — choose a model that supports images");
    }
    let url = "";
    if (input.dataUrl) {
      if (!/^data:image\//.test(input.dataUrl)) throw new Error("Expected a picture data URL");
      url = input.dataUrl;
    } else if (input.imageId) {
      const file = PathHelper.resolveImageId(input.imageId);
      if (!file || !fs.existsSync(file)) throw new Error(`Unknown picture "${input.imageId}"`);
      url = TextGenerationService.imageDataUrl(file);
    }
    if (!url) throw new Error("No picture to describe");
    const answer = await this.requestCompletion(
      model,
      [
        {
          role: "system",
          content:
            "You describe pictures for a roleplay chat. Answer with ONE short sentence in English, " +
            "present tense: who or what is on the picture, what happens, the setting and the light. " +
            "No preamble, no quotes, no lists.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What is on this picture?" },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
      undefined,
      sampling,
    );
    return answer.trim();
  }

  // ---- planning a picture for the user's turn ----

  // Asks the model to plan the picture the user wants on their own turn: it
  // gets the whole dialogue, the CAST of people who can appear (each with the
  // look description and the numbers of the pictures that show them), and the
  // numbered list of pictures to draw from. It answers with the scene to draw,
  // a short English name for the file, the caption of the result, the reference
  // numbers and the people it put in the scene.
  //
  // The no-names rule is the point of this call. The generator is a model that
  // has never heard of Alice or Carol: a prompt naming them gets a brand-new
  // face every run, which is exactly the inconsistency the user sees. So the
  // planner describes people by how they look or binds them to a reference
  // image, and the app assembles the references and the binding sentence around
  // its answer (see ReplyService.finishPlan).
  //
  // The answer is JSON the model has to produce — models wrap it in prose or a
  // code fence, so it is extracted rather than parsed as-is, and a plan that
  // cannot be read is reported as null so the caller can fall back to something
  // sensible instead of failing the user's request.
  async composeImagePrompt(
    model: Model,
    input: {
      scene: string;
      images: ImageBrief[];
      cast?: ImageCastMember[];
      // How many reference images the generator can take — the planner is told
      // so it does not ask for more than the picture can carry.
      maxRefs?: number;
      // The look every picture of this chat shares (the chat's style setting).
      style?: string;
      signal?: AbortSignal;
      sampling?: ChatSampling;
    },
  ): Promise<ImagePromptPlan | null> {
    const castRefs = new Set((input.cast ?? []).map((c) => c.ref));
    const maxRefs = input.maxRefs ?? 2;
    const list =
      input.images.length === 0
        ? "There are no pictures to draw from, so the picture must come from the text alone."
        : input.images
            .map((img, i) => {
              const bits = [
                img.role === "look"
                  ? `a look reference${img.shows ? ` of ${img.shows}` : ""}`
                  : img.description
                    ? `shows: ${img.description}`
                    : "no description",
                img.prompt ? `generated from prompt: ${img.prompt}` : img.origin === "uploaded" ? "uploaded by the user" : "",
                img.owner ? `shared by ${img.owner}` : "",
                img.age ?? "",
              ].filter(Boolean);
              return `#${i + 1} — ${bits.join("; ")}`;
            })
            .join("\n");
    const people =
      (input.cast ?? []).length === 0
        ? "Nobody is known by name in this conversation."
        : (input.cast ?? [])
            .map(
              (c) =>
                `${c.ref} — ${c.name}${c.look ? `: ${c.look}` : ""}` +
                (c.anchors.length > 0 ? ` (shown on picture ${c.anchors.join(", ")})` : " (no picture of them)"),
            )
            .join("\n");

    const answer = await this.requestCompletion(
      model,
      [
        {
          role: "system",
          content:
            "You plan one picture for the next message of the user in a roleplay chat. " +
            "Look at the conversation and decide what the user would want to show right now.\n" +
            "The picture is drawn by an image generator that has NEVER heard the names of these people: " +
            "it understands only a visual description and the reference images it is given.\n" +
            "Answer with ONE JSON object and nothing else:\n" +
            '{"name": "2-5 english words naming the picture", ' +
            '"description": "one sentence saying what the finished picture shows", ' +
            '"prompt": "the image generation prompt, in english, 1-3 sentences: subjects, action, setting, lighting, style", ' +
            '"refs": [numbers of the pictures below to draw from], ' +
            '"cast": [the ids of the people who appear in the picture], ' +
            '"subjects": [{"id": "the cast id", "noun": "the 2-4 word english phrase the prompt uses for them"}]}\n' +
            "Rules:\n" +
            "- everything in english;\n" +
            "- the prompt describes a single concrete scene, not a story;\n" +
            "- NEVER write a person's name in the prompt. Call a person by how they look " +
            '(the "look" line of their cast entry: "the red-haired woman in a green coat") or by their ' +
            'reference picture ("the woman from the first reference image");\n' +
            "- for every person you show, put their cast id in cast and give the exact noun phrase you used;\n" +
            `- refs: at most ${maxRefs} numbers from the list below. Use a look reference for every person you ` +
            "show, and a conversation picture when the new one must keep its place or its style;\n" +
            "- keep the picture in the same style as the pictures of this conversation." +
            (input.style ? `\n- the pictures of this chat share one style: ${input.style}` : ""),
        },
        {
          role: "user",
          content:
            `${input.scene}\n\nPeople in this conversation:\n${people}\n\n` +
            `Pictures to draw from:\n${list}`,
        },
      ],
      input.signal,
      input.sampling,
    );

    const plan = TextGenerationService.parseJsonPlan(answer);
    if (!plan) return null;
    const prompt = typeof plan.prompt === "string" ? plan.prompt.trim() : "";
    if (!prompt) return null;
    const refs = Array.isArray(plan.refs)
      ? plan.refs
          .map((n) => (typeof n === "number" ? n : parseInt(String(n), 10)))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= input.images.length)
      : [];
    // Ids the model invented cannot point at anything — a person the planner
    // made up is not in the cast, so the app ignores them rather than binding a
    // reference to nothing.
    const cast = Array.isArray(plan.cast)
      ? plan.cast.filter((x): x is string => typeof x === "string" && castRefs.has(x))
      : [];
    const subjects = Array.isArray(plan.subjects)
      ? plan.subjects
          .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
          .map((s) => ({
            ref: typeof s.id === "string" ? s.id : "",
            noun: typeof s.noun === "string" ? s.noun.trim() : "",
          }))
          .filter((s) => s.ref && s.noun && castRefs.has(s.ref))
      : [];
    const name = typeof plan.name === "string" ? plan.name.trim() : "";
    const description = typeof plan.description === "string" ? plan.description.trim() : "";
    return {
      name: name || prompt,
      description,
      prompt,
      refs: [...new Set(refs)],
      cast: [...new Set(cast)],
      subjects,
    };
  }

  // Pulls the JSON object out of a model answer (bare, in a ``` fence, or
  // wrapped in a sentence). Null when there is nothing readable in it.
  private static parseJsonPlan(text: string): Record<string, unknown> | null {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    for (const candidate of [fenced?.[1], text]) {
      if (!candidate) continue;
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start === -1 || end <= start) continue;
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // try the next candidate
      }
    }
    return null;
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
    closingNote?: string,
    signal?: AbortSignal,
    sampling?: ChatSampling,
  ): Promise<string> {
    const toMessages = (withImages: boolean): MessageParam[] => {
      const msgs: MessageParam[] = [
        { role: "system", content: systemPrompt },
        ...history.map((m) => ({
          role: m.role,
          content: withImages ? this.buildContent(model, m) : TextGenerationService.historyText(m),
        })),
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
      return await this.requestCompletion(model, toMessages(true), signal, sampling);
    } catch (err) {
      // A model without an mmproj rejects the image — retry with text only so
      // the dialogue is not aborted with a 500 error. A cancel (an aborted
      // signal) is never retried: its error does not look like an image reject.
      const sentImages = history.some((m) => (m.images?.length ?? 0) > 0);
      if (!sentImages || !TextGenerationService.IMAGE_REJECT_RE.test((err as Error).message)) throw err;
      try {
        const reply = await this.requestCompletion(model, toMessages(false), signal, sampling);
        return `⚠️ The model rejected the image — the message was sent without it.\n\n${reply}`;
      } catch {
        throw err;
      }
    }
  }

  // One /chat/completions call: the OpenAI-compatible request (the api key,
  // the reasoning level in both spellings) and the reply extraction.
  private async requestCompletion(
    model: Model,
    messages: MessageParam[],
    signal?: AbortSignal,
    sampling?: ChatSampling,
  ): Promise<string> {
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
    // llama.cpp) and reasoning.effort (OpenRouter). When the level is off,
    // chat_template_kwargs.enable_thinking=false is the reliable cross-backend
    // switch (Qwen/llama.cpp): reasoning_effort alone does not turn thinking
    // off on llama.cpp, and a default-on hybrid model would keep thinking.
    // A provider ignores a field it does not know, so this is safe to send.
    if (model.reasoning) {
      payload.reasoning_effort = model.reasoning;
      payload.reasoning = { effort: model.reasoning };
    } else {
      payload.chat_template_kwargs = { enable_thinking: false };
    }
    // The per-chat sampling overrides (Chat.sampling): a field left undefined
    // is not sent — the provider applies its own default. Sent in the common
    // OpenAI-compatible spellings (temperature / min_p / repetition_penalty —
    // the last one is understood by llama.cpp, vLLM, Aphrodite and OpenRouter).
    if (sampling?.temperature !== undefined) payload.temperature = sampling.temperature;
    if (sampling?.minP !== undefined) payload.min_p = sampling.minP;
    if (sampling?.repetitionPenalty !== undefined) payload.repetition_penalty = sampling.repetitionPenalty;

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
  // support, the message images as image_url data-URIs. An image is addressed
  // by its id (a path relative to the data folder); a missing file — a picture
  // that is still being generated, or one the user deleted — is skipped.
  //
  // A model without vision gets a sentence in place of the picture: the card's
  // description, so the dialogue still knows what was shown.
  private buildContent(model: Model, message: ChatMessage): string | ContentPart[] {
    const files = (message.images ?? [])
      .map((id) => PathHelper.resolveImageId(id))
      .filter((file): file is string => file !== null && fs.existsSync(file));

    if (isImageMessage(message)) {
      const caption = message.text.trim();
      if (!model.supportsImages || files.length === 0) return TextGenerationService.historyText(message);
      const parts: ContentPart[] = [];
      parts.push({
        type: "text",
        text: caption ? `A picture you are shown, it shows: ${caption}` : "A picture you are shown.",
      });
      for (const file of files) {
        parts.push({ type: "image_url", image_url: { url: TextGenerationService.imageDataUrl(file) } });
      }
      return parts;
    }

    if (model.supportsImages && files.length > 0) {
      const parts: ContentPart[] = [];
      if (message.text) parts.push({ type: "text", text: message.text });
      for (const file of files) {
        parts.push({ type: "image_url", image_url: { url: TextGenerationService.imageDataUrl(file) } });
      }
      return parts;
    }
    return message.text;
  }

  // The text stand-in of a message, for a model that cannot see: an image card
  // becomes its description (or a plain note when nobody wrote one), everything
  // else is its own text.
  private static historyText(message: ChatMessage): string {
    if (!isImageMessage(message)) return message.text;
    const caption = message.text.trim();
    return caption ? `[A picture: ${caption}]` : "[A picture without a description]";
  }

  private static imageDataUrl(file: string): string {
    const mime = TextGenerationService.MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "image/png";
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  }
}
