import fs from "fs";
import { Character } from "../characters/Character";
import { CharactersService } from "../characters/CharactersService";
import { Chat } from "../chats/Chat";
import { ChatMessage, ImageGenerationData, isImageMessage } from "../chats/ChatMessage";
import { ChatsService } from "../chats/ChatsService";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { Model } from "../configuration/Model";
import { PathHelper } from "../shared/PathHelper";
import { createToken } from "../di";
import { ImageBrief, ImagePromptPlan, TextGenerationService } from "../text_generation/TextGenerationService";
import { ImageGenerationService } from "../image_generation/ImageGenerationService";
import { ImageGenerationRecord } from "../shared/ImageMeta";
import { ImageJob } from "../image_generation/ImageJob";
import { PersonsService } from "../persons/PersonsService";

// The DI token of the reply service (registered in index.ts).
export const DI_REPLY_SERVICE = createToken<ReplyService>("ReplyService");

// The top-level reply service: the orchestration of an AI reply (the system
// prompt, the history, the model call, the [SILENT] parsing, saving the
// message) and of the user's pictures — attaching them, drawing one on request,
// planning one for the user's turn, regenerating and cancelling. It also keeps
// the in-flight reply registry (the frontend asks for the replies one at a
// time; the /cancel route aborts the model call).
//
// It sits ABOVE the domain services (characters, persons, chats, text
// generation, image generation, configuration) and is HTTP-agnostic: it
// returns the results the routes layer applies (a saved chat, a message, or a
// typed failure).
//
// Pictures are the user's side of the conversation: a character reply is text
// only. Each picture is its own message — an image card — carrying its
// description and its generation data, and its file is named by a path relative
// to the data folder.
export class ReplyService {
  constructor(
    private readonly characters: CharactersService,
    private readonly persons: PersonsService,
    private readonly chats: ChatsService,
    private readonly textGeneration: TextGenerationService,
    private readonly imageGeneration: ImageGenerationService,
    private readonly configuration: ConfigurationService,
  ) {}

  // The model a chat's replies should run on: the llmModels entry the chat
  // references, falling back to the first model so a renamed/deleted model
  // keeps the chat working. Null when the config has no models at all.
  resolveChatModel(chat: Chat): Model | null {
    return this.textGeneration.resolveModel(this.configuration.loadConfig(), chat);
  }

  // The in-flight reply per chat: the controller is registered here so the
  // cancel route can abort the model call, while the /reply handler keeps it
  // to detect the cancellation.
  private readonly inFlightReplies = new Map<string, AbortController>();

  // Registers the in-flight reply of the chat and returns its controller.
  beginReply(chatId: string): AbortController {
    const ctrl = new AbortController();
    this.inFlightReplies.set(chatId, ctrl);
    return ctrl;
  }

  // Removes the in-flight reply of the chat (the /reply handler finished).
  endReply(chatId: string, ctrl: AbortController): void {
    if (this.inFlightReplies.get(chatId) === ctrl) this.inFlightReplies.delete(chatId);
  }

  // Cancels the in-flight reply of the chat: the model call is aborted and no
  // message is saved for it. A no-op when nothing is generating.
  cancelReply(chatId: string): void {
    this.inFlightReplies.get(chatId)?.abort();
  }

  // ---- the character's reply ----

  // Generates and appends a reply of the given character to the chat.
  // Returns null when the character stays silent (the reply is exactly
  // [SILENT]). The common part of a normal send, "another message from the AI"
  // (empty send) and regeneration: system prompt, history, the model call,
  // saving. The author (characterId) is stored on the message.
  //
  // The reply is text — a character has no picture to send or draw. The
  // pictures the user shared still reach the model: as image files for a model
  // with vision, as their descriptions for one without.
  //
  // `replaceLast` (regeneration): the last assistant message is being
  // replaced — it is excluded from the history (the model writes a fresh line)
  // and removed from the chat ONLY after the new reply is saved, so a cancel
  // or a model error keeps the original reply.
  async appendAssistantReply(
    chat: Chat,
    model: Model,
    characterId: string,
    signal?: AbortSignal,
    replaceLast = false,
  ): Promise<ChatMessage | null> {
    const character = this.characters.get(characterId);
    if (!character) return null;
    // The other character participants: in a group chat the prompt explains
    // the reply order and allows staying silent.
    const fellows = chat.characterIds
      .filter((id) => id !== characterId)
      .map((id) => this.characters.get(id))
      .filter((c): c is Character => c !== null);
    const person = chat.userId ? this.persons.get(chat.userId) : (this.persons.list()[0] ?? null);
    const system =
      this.textGeneration.systemPromptFor(character, person, fellows) +
      (chat.systemSuffix ? `\n${chat.systemSuffix}` : "");

    // In a group chat we label lines with authors — the model must understand
    // who said what. With a single character and a single persona the history
    // is left as-is. The chat's personas are derived from message authors;
    // there is no Chat.userIds.
    // The character authors are the ids the messages actually carry, resolved
    // through the whole catalog — a character that was toggled out of the chat
    // keeps its name on the lines it already said (and the count of voices
    // takes it into account, so those lines stay labeled).
    const authorIds = [
      ...new Set(chat.messages.map((m) => m.characterId).filter((id): id is string => !!id)),
    ];
    const multi =
      new Set([...chat.characterIds, ...authorIds]).size > 1 ||
      new Set(chat.messages.map((m) => m.userId)).size > 1;
    // The message being regenerated stays in the chat (visible to the user)
    // but is not part of the history the model sees — it is being replaced.
    const replacedIndex = replaceLast && chat.messages.length > 0 ? chat.messages.length - 1 : -1;
    const replacedMessage =
      replacedIndex !== -1 && chat.messages[replacedIndex]?.role === "assistant" ? chat.messages[replacedIndex] : null;
    const history = this.textGeneration.trimHistory(
      this.textGeneration.labelHistory(
        chat.messages.filter((m) => m !== replacedMessage && !m.error),
        Object.fromEntries(
          authorIds.map((id) => [id, this.characters.get(id)?.name ?? id] as const),
        ),
        Object.fromEntries(
          [...new Set(chat.messages.map((m) => m.userId).filter((id): id is string => !!id))].map(
            (id) => [id, this.persons.get(id)?.name ?? id] as const,
          ),
        ),
        multi,
      ),
      model.contextSize,
    );

    // A reminder at the end of the context: weak models forget whose turn it
    // is near the end of the history and keep speaking for the previous
    // speaker.
    const replyText = await this.textGeneration.chatCompletion(
      model,
      system,
      history,
      `The next reply is the line of the character ${character.name}. ` +
        'Write strictly in the first person of this character ("I"), ' +
        "do not write for the other characters or for the user. " +
        "If you have absolutely nothing to add to the conversation, output exactly [SILENT] instead of a reply. " +
        "Keep the reply short: 2–5 sentences, one paragraph.",
      signal,
      chat.sampling,
    );

    // The character may have stayed silent (exactly [SILENT]) — no chat message.
    const spoken0 = this.textGeneration.parseSilence(replyText);
    if (spoken0 === null) return null;
    // Strip "Bob: …" / "Carol: Carol: …" — copies of author labels from the
    // history.
    const spoken = this.textGeneration.stripNamePrefixes(spoken0, [character.name, ...fellows.map((c) => c.name)]);

    const assistantMsg: ChatMessage = {
      id: PathHelper.newId(),
      role: "assistant" as const,
      kind: "text",
      characterId,
      text: spoken,
      images: [],
      timestamp: Date.now(),
    };
    // Save the reply into the chat RE-READ from disk: the model call took
    // seconds, and a concurrent change in the meantime (a message deleted or
    // added, a picture the user attached) must not be clobbered by the
    // request-time snapshot. The regeneration removal rides on the same
    // re-read: the replaced message is dropped only when it is still the last
    // line (a cancel or an error never reaches here — the original stays; a
    // manual delete in the meantime leaves nothing to remove).
    const fresh = this.chats.get(chat.id);
    if (!fresh) return null; // the chat was deleted while the model ran
    if (replacedMessage) {
      const idx = fresh.messages.findIndex((m) => m.id === replacedMessage.id);
      if (idx === fresh.messages.length - 1) fresh.messages.splice(idx, 1);
    }
    fresh.messages.push(assistantMsg);
    this.chats.save(fresh);
    return assistantMsg;
  }

  // ---- the user's pictures ----

  // The user attaches pictures: the text they typed becomes a text message and
  // every picture its own image card right after it — a card carries exactly
  // one, so a description and a generation record can belong to it. An empty
  // caption message is not stored: a bare attachment is only the card.
  attachUserImages(chatId: string, text: string, images: unknown[]): { chat: Chat; messages: ChatMessage[] } | null {
    const fresh = this.chats.get(chatId);
    if (!fresh) return null;
    const ids = this.chats.normalizeImages(fresh.id, images);
    const caption = text.trim();
    const messages: ChatMessage[] = [];
    if (caption) messages.push(this.chats.addUserMessage(fresh, caption));
    for (const id of ids) {
      messages.push(this.chats.addImageMessage(fresh, id, { userId: fresh.userId, generation: { source: "upload" } }));
    }
    return { chat: fresh, messages };
  }

  // Draws a picture on the user's request (the 🎨 mode): a card of the active
  // persona is saved right away with its reserved id and the "pending" status,
  // and the generation runs in the background — the client polls and the file
  // appears. The prompt is required in English, so a non-English one is
  // translated with the chat's model first; the file name is made of the
  // prompt's first words, so a picture is recognisable in the files folder.
  //
  // Returns the saved chat and the new message, or null when the chat was
  // deleted while the translation ran (nothing to save into).
  async manualImage(chat: Chat, prompt: string, refs: string[]): Promise<{ chat: Chat; message: ChatMessage } | null> {
    const finalPrompt = await this.imageGeneration.ensureEnglishPrompt(this.resolveChatModel(chat), prompt);
    const id = this.chats.reservedImageId(chat.id, finalPrompt);
    const fresh = this.chats.get(chat.id);
    if (!fresh) return null; // the chat was deleted while translating
    const generation: ImageGenerationData = {
      prompt: finalPrompt,
      refs: refs.length > 0 ? refs : undefined,
      source: "manual",
      model: chat.modelId,
      createdAt: new Date().toISOString(),
    };
    const message = this.chats.addImageMessage(fresh, id, {
      userId: fresh.userId,
      generation,
      status: "pending",
    });
    this.startChatImageJob(id, finalPrompt, refs, chat.id, {
      prompt: finalPrompt,
      refs,
      source: "manual",
      model: chat.modelId,
    });
    return { chat: fresh, message };
  }

  // ---- the picture of the user's turn ----

  // Draws the picture the user wants on their own turn, planned by the model
  // from the whole dialogue. The call returns as soon as the placeholder card
  // is in the chat: the planning and the generation run in the background, so
  // the user can keep writing and send their own message meanwhile, and the
  // client's polling shows the placeholder becoming the picture.
  //
  // Returns the saved chat with the placeholder, or null when the chat is gone.
  // The card's Cancel button works the usual way — the background run notices
  // it before it reaches the generator.
  requestUserTurnImage(chatId: string): Chat | null {
    const fresh = this.chats.get(chatId);
    if (!fresh) return null;
    // A provisional id: the model has not named the picture yet. The card is
    // repointed at the readable name once the plan is in.
    const placeholder = this.chats.reservedImageId(fresh.id, "a picture for the conversation");
    const message = this.chats.addImageMessage(fresh, placeholder, {
      userId: fresh.userId,
      generation: { source: "auto", model: fresh.modelId, createdAt: new Date().toISOString() },
      status: "pending",
    });
    void this.runUserTurnImage(fresh.id, message.id, placeholder);
    return fresh;
  }

  // The background half of requestUserTurnImage: ask the model what to draw and
  // from which references, rename the placeholder to the name it chose, then
  // run the generation. Each step re-reads the card — the user may have
  // cancelled or deleted it while the model was thinking, and a cancelled card
  // stays cancelled.
  private async runUserTurnImage(chatId: string, messageId: string, placeholder: string): Promise<void> {
    const giveUp = (error: string): void => {
      this.chats.setMessageImageStatus(chatId, messageId, placeholder, "failed", error);
    };
    try {
      const chat = this.chats.get(chatId);
      if (!chat) return;
      const model = this.resolveChatModel(chat);
      if (!model) {
        giveUp("No model configured for the chat");
        return;
      }
      const catalogue = this.pictureCatalogue(chat, messageId);
      const plan = await this.textGeneration.composeImagePrompt(model, {
        scene: this.dialogueForImage(chat, messageId),
        images: catalogue,
        sampling: chat.sampling,
      });
      if (!plan) {
        giveUp("The model did not describe a picture to draw");
        return;
      }
      // Cancelled or deleted while the model was thinking — leave it as the
      // user left it.
      if (!this.cardIsPending(chatId, messageId, placeholder)) return;
      const refs = plan.refs.map((n) => catalogue[n - 1]?.id).filter((id): id is string => id !== undefined);
      const id = this.chats.reservedImageId(chatId, plan.name);
      if (!this.chats.replaceMessageImageId(chatId, messageId, placeholder, id)) return;
      this.chats.setMessageImageStatus(chatId, messageId, id, "pending");
      const generation: ImageGenerationData = {
        prompt: plan.prompt,
        refs: refs.length > 0 ? refs : undefined,
        source: "auto",
        model: chat.modelId,
        createdAt: new Date().toISOString(),
      };
      this.chats.writeSidecar(id, plan.description, generation);
      if (plan.description) this.chats.setMessageText(chatId, messageId, plan.description);
      this.startChatImageJob(id, plan.prompt, refs, chatId, {
        prompt: plan.prompt,
        refs,
        source: "auto",
        model: chat.modelId,
      });
    } catch (err) {
      giveUp((err as Error).message);
    }
  }

  // Whether the card still waits for its picture (it exists and is pending).
  private cardIsPending(chatId: string, messageId: string, imageId: string): boolean {
    const msg = this.chats.get(chatId)?.messages.find((m) => m.id === messageId);
    return msg?.imageStatus?.[imageId] === "pending";
  }

  // Everything the picture-planning call needs to know about the conversation:
  // who is in it and what happened, as plain text. The plan is a text call —
  // the pictures are described, not shown — so any model can make it.
  // The card being filled right now is left out: it is the app's own
  // placeholder, not something that happened in the dialogue.
  private dialogueForImage(chat: Chat, exceptMessageId?: string): string {
    const persona = this.persons.get(chat.userId);
    const lines = chat.messages
      .filter((m) => !m.error && m.id !== exceptMessageId)
      .map((m) => {
        const who = this.authorName(m);
        if (isImageMessage(m)) return `${who}: [shares a picture: ${m.text.trim() || "a picture with no description"}]`;
        return `${who}: ${m.text}`;
      });
    return [
      `Characters: ${chat.characterIds.map((id) => this.characters.get(id)?.name ?? id).join(", ") || "nobody"}.`,
      `The user: ${persona?.name ?? "the user"}${persona?.description?.trim() ? ` — ${persona.description.trim()}` : ""}.`,
      "The conversation so far:",
      lines.length > 0 ? lines.join("\n") : "(it has just started)",
      "The user is about to send their next message with a picture.",
    ].join("\n");
  }

  // The pictures the chat already has, in the order the planning model numbers
  // them: what each one shows, how it got there and who shared it. The card
  // being filled right now is left out — it is the picture being planned, and
  // there is nothing on it yet. A picture whose file is gone is left out too,
  // so the model is never offered a reference that cannot be drawn from.
  private pictureCatalogue(chat: Chat, exceptMessageId?: string): ImageBrief[] {
    const total = chat.messages.length;
    const briefs: ImageBrief[] = [];
    chat.messages.forEach((m, index) => {
      if (!isImageMessage(m) || m.id === exceptMessageId) return;
      const id = m.images[0];
      if (!id) return;
      const file = PathHelper.resolveImageId(id);
      if (!file || !fs.existsSync(file)) return;
      const fromEnd = total - 1 - index;
      briefs.push({
        id,
        description: m.text.trim() || undefined,
        prompt: m.generation?.prompt,
        owner: this.authorName(m),
        age: fromEnd === 0 ? "the last message" : `${fromEnd} messages ago`,
        origin: m.generation?.prompt ? "generated" : "uploaded",
      });
    });
    return briefs;
  }

  // Who showed the model this line: a character by name, a persona by name.
  private authorName(message: ChatMessage): string {
    if (message.role === "assistant") return this.characters.get(message.characterId ?? "")?.name ?? "A character";
    return this.persons.get(message.userId ?? "")?.name ?? "The user";
  }

  // ---- one picture: regenerate / cancel / replace / edit ----

  // Regenerates one picture in the BACKGROUND: the card's prompt (or its
  // description, when nobody wrote a prompt) is run through the generator
  // again, writing to the SAME id — nothing that points at the picture needs
  // repointing. A regeneration already in flight for it is cancelled first (one
  // job per picture). The status and the (possibly re-translated) prompt are
  // marked "pending" in a single re-read+save and mirrored into the sidecar. If
  // an older file exists at the id and the run fails or is cancelled, the old
  // one is kept (the card stays ready).
  //
  // `promptOverride` — a new prompt typed by the user (the "edit prompt then
  // regenerate" flow): when given, it replaces the stored one (after the usual
  // English translation).
  //
  // Returns null when the chat or the message disappeared in the meantime.
  async regenerateImage(chat: Chat, message: ChatMessage, image: string, promptOverride?: string): Promise<Chat | null> {
    const rawPrompt =
      (promptOverride && promptOverride.trim()) || message.generation?.prompt || message.text.trim() || "image";
    const prompt = await this.imageGeneration.ensureEnglishPrompt(this.resolveChatModel(chat), rawPrompt);
    const refs = message.generation?.refs ?? [];
    // A regeneration in flight for this picture is cancelled — one job per image.
    this.imageGeneration.cancelJob(image);
    const fresh = this.chats.get(chat.id);
    const fmsg = fresh?.messages.find((m) => m.id === message.id);
    if (!fresh || !fmsg) return null;
    fmsg.generation = { ...(fmsg.generation ?? {}), prompt, refs: refs.length > 0 ? refs : undefined };
    fmsg.imageStatus = { ...(fmsg.imageStatus ?? {}), [image]: "pending" };
    if (fmsg.imageErrors && image in fmsg.imageErrors) {
      delete fmsg.imageErrors[image];
      if (Object.keys(fmsg.imageErrors).length === 0) delete fmsg.imageErrors;
    }
    this.chats.save(fresh);
    this.chats.writeSidecar(image, fmsg.text, fmsg.generation);
    this.startChatImageJob(image, prompt, refs, chat.id, {
      prompt,
      refs,
      source: fmsg.generation.source ?? "manual",
      model: chat.modelId,
    });
    return fresh;
  }

  // Cancels the in-flight generation of one picture. The card is marked
  // "cancelled" right away (the placeholder with the Regenerate button); the
  // job itself settles shortly after (its hadOld check keeps an older file, if
  // any, so a cancelled regeneration does not break a ready picture).
  // Cancelling a picture that is not "pending" is a no-op. Returns the current
  // chat (null when it was deleted in the meantime).
  cancelImage(chat: Chat, message: ChatMessage, image: string): Chat | null {
    if (message.imageStatus?.[image] === "pending") {
      this.imageGeneration.cancelJob(image);
      this.chats.setMessageImageStatus(chat.id, message.id, image, "cancelled", "Generation cancelled");
    }
    return this.chats.get(chat.id);
  }

  // Replaces a ready picture with a file the user picked: the new image is
  // saved into the chat files/ under its own id and swapped for the old one in
  // the card, which loses its generation data — what is there now is the user's
  // own file, with no prompt behind it. The old file is not deleted (another
  // picture may still use it as a reference). Returns the saved chat, or null
  // when the chat or the message disappeared in the meantime.
  replaceImage(chat: Chat, message: ChatMessage, image: string, dataUrl: string): Chat | null {
    const id = this.chats.saveImage(chat.id, dataUrl);
    const fresh = this.chats.get(chat.id);
    const fmsg = fresh?.messages.find((m) => m.id === message.id);
    if (!fresh || !fmsg) return null;
    this.chats.replaceMessageImage(fresh, fmsg, image, id);
    return fresh;
  }

  // Edits what a picture says about itself — the picture-editor dialog:
  //   description — what is on it;
  //   prompt      — the prompt it should be redrawn with (a generated picture);
  //   image       — point the card at another picture of the data folder (the
  //                 swap drops the old generation data);
  //   kind        — what the card IS now: "generated" keeps/creates the
  //                 generation block (source "manual" when it had none), "file"
  //                 drops it (a plain file has nothing to be redrawn from). An
  //                 omitted kind leaves the block alone.
  // The message and the sidecar next to its file are both updated. Returns the
  // saved chat (null — the card is gone).
  editPicture(
    chat: Chat,
    message: ChatMessage,
    patch: { description?: string; prompt?: string; image?: string; kind?: "generated" | "file" },
  ): Chat | null {
    const fresh = this.chats.get(chat.id);
    const fmsg = fresh?.messages.find((m) => m.id === message.id);
    if (!fresh || !fmsg) return null;
    // Re-pointing the card at another picture comes first: the swap drops the
    // generation block, then the fields below describe the new picture.
    const current = fmsg.images[0];
    const repointed = patch.image !== undefined && patch.image !== current;
    if (repointed) this.chats.replaceMessageImage(fresh, fmsg, current, patch.image as string);
    const prompt = patch.prompt?.trim();
    let generation: ImageGenerationData | null | undefined;
    if (patch.kind === "file") {
      // The card keeps its picture but stops claiming a generation. The
      // sidecar's generation keys go too, or the prompt would come back on
      // read. A re-pointed card needs nothing: the swap already dropped the
      // block, and the new file's sidecar (which another card may share) is
      // not ours to rewrite.
      generation = repointed ? undefined : null;
    } else if (patch.kind === "generated" || prompt !== undefined) {
      generation = {
        ...(fmsg.generation ?? {}),
        // an empty prompt is a real edit — the card then has nothing to redraw
        // from until the user writes one
        ...(prompt !== undefined ? { prompt } : {}),
        source: fmsg.generation?.source ?? ("manual" as const),
      };
    }
    this.chats.editImageCard(fresh, fmsg, {
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(generation !== undefined ? { generation } : {}),
    });
    return fresh;
  }

  // ---- the LLM helpers of the picture editor ----

  // The prompt for one picture card, planned by the model from the dialogue —
  // the "From the chat" button: what the user wants to show right now, with the
  // card being edited left out of the dialogue and of the picture catalogue (it
  // is what is being planned). Returns null when the chat is gone and when the
  // model cannot produce a readable plan.
  async planPicturePrompt(chatId: string, messageId?: string): Promise<ImagePromptPlan | null> {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    const model = this.resolveChatModel(chat);
    if (!model) return null;
    return this.textGeneration.composeImagePrompt(model, {
      scene: this.dialogueForImage(chat, messageId),
      images: this.pictureCatalogue(chat, messageId),
      sampling: chat.sampling,
    });
  }

  // Rewrites a typed prompt for the generator — English + tuned (the "Make it
  // English" button). The chat's model does the work with the chat's sampling;
  // null when the chat is gone (a model error propagates to the route).
  async tunePicturePrompt(chatId: string, prompt: string): Promise<string | null> {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    const model = this.resolveChatModel(chat);
    if (!model) throw new Error("No model configured for the chat");
    return (await this.textGeneration.tunePrompt(model, prompt, chat.sampling)).trim();
  }

  // Describes a picture with the chat's model (vision) — the "Describe the
  // picture" button: an existing picture of the data folder or a data URL of a
  // file the user just picked. Null when the chat is gone (a model error — no
  // vision, no model — propagates to the route).
  async describePicture(
    chatId: string,
    input: { imageId?: string; dataUrl?: string },
  ): Promise<string | null> {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    const model = this.resolveChatModel(chat);
    if (!model) throw new Error("No model configured for the chat");
    if (!model.supportsImages) {
      throw new Error("The chat's model cannot see pictures — choose a model that supports images");
    }
    return (await this.textGeneration.describePicture(model, input, chat.sampling)).trim();
  }

  // The visible error line of a failed model call: appended as an assistant
  // message with the error flag (a cancelled run saves nothing — the route
  // never calls this for one). Returns the saved chat, or null when the chat
  // disappeared in the meantime.
  saveErrorMessage(chatId: string, characterId: string, error: string): Chat | null {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    chat.messages.push({
      id: PathHelper.newId(),
      role: "assistant" as const,
      kind: "text",
      characterId: characterId || undefined,
      text: `⚠️ Error: ${error}`,
      images: [],
      timestamp: Date.now(),
      error: true,
    });
    this.chats.save(chat);
    return chat;
  }

  // ---- the background job ----

  // Starts a background generation for the reserved image `id` (already saved
  // in a chat card with the "pending" status) and updates that card when the
  // job settles:
  //   ok                       -> status cleared (the picture is ready)
  //   failed / cancelled       -> "failed" + error, UNLESS an older file
  //                               existed at the id (hadOld) — then the old one
  //                               is kept and the card stays ready.
  // A job replaced by a newer one (a regeneration) does not touch the card.
  private startChatImageJob(
    id: string,
    prompt: string,
    refs: string[],
    chatId: string,
    meta: ImageGenerationRecord,
  ): void {
    const job: ImageJob = this.imageGeneration.startImageJob({ id, prompt, refs, chatId, meta });
    void job.result.then((res) => {
      // A regeneration started a newer job for the same picture — it owns the
      // status now, so this (replaced) job stays silent.
      const current = this.imageGeneration.getCurrentJob(id);
      if (current !== undefined && current !== job) return;
      // The card is found by the id it carries, not remembered from the start:
      // a placeholder is renamed while the plan is being made, and the card may
      // have been deleted while the job ran.
      const messageId = this.cardOfImage(chatId, id);
      if (!messageId) return;
      if (res.status === "ok" || res.hadOld) {
        this.chats.setMessageImageStatus(chatId, messageId, id, undefined);
        return;
      }
      this.chats.setMessageImageStatus(
        chatId,
        messageId,
        id,
        res.status === "cancelled" ? "cancelled" : "failed",
        res.status === "failed" ? res.error : undefined,
      );
    });
  }

  // The id of the card that carries an image, or null when nothing does.
  private cardOfImage(chatId: string, id: string): string | null {
    const msg = this.chats.get(chatId)?.messages.find((m) => m.images.includes(id));
    return msg?.id ?? null;
  }
}
