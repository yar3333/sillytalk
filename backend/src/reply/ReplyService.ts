import { Character } from "../characters/Character";
import { CharactersService } from "../characters/CharactersService";
import { Chat } from "../chats/Chat";
import { ChatMessage } from "../chats/ChatMessage";
import { ChatsService } from "../chats/ChatsService";
import { ConfigurationService } from "../configuration/ConfigurationService";
import { Model } from "../configuration/Model";
import { PathHelper } from "../shared/PathHelper";
import { createToken } from "../di";
import { ImageGenerationService } from "../image_generation/ImageGenerationService";
import { ImageJob } from "../image_generation/ImageJob";
import { PersonsService } from "../persons/PersonsService";
import { TextGenerationService } from "../text_generation/TextGenerationService";

// The DI token of the reply service (registered in index.ts).
export const DI_REPLY_SERVICE = createToken<ReplyService>("ReplyService");

// The top-level reply service: the orchestration of an AI reply — the system
// prompt, the history, the model call, the [SILENT]/[IMG]/[PHOTO] parsing,
// saving the message and starting the background image jobs. It also keeps
// the in-flight reply registry (the frontend asks for the replies one at a
// time; the /cancel route aborts the model call) and the manual image
// operations (generate, regenerate and cancel a message image).
//
// It sits ABOVE the domain services (characters, persons, chats, text
// generation, image generation, configuration) and is HTTP-agnostic: it
// returns the results the routes layer applies (a saved chat, a message, or a
// typed failure).
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

  // Generates and appends a reply of the given character to the chat.
  // Returns null when the character stays silent (the reply is exactly
  // [SILENT]). The common part of a normal send, "another message from the AI"
  // (empty send) and regeneration: system prompt, history, the model call,
  // parsing of self-requested images, saving. The author (characterId) is
  // stored on the message.
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
    const canGenerateImages = this.imageGeneration.hasAvailableGenerator();
    // The inventory is always needed: it backs both [PHOTO:N] (send a ready
    // image, no generator required) and [IMG:... | N] references (generation).
    const inventory = this.imageGeneration.imageInventory(chat, character);
    const inventoryText = inventory.map((it, i) => `#${i + 1} — ${it.label}`).join("\n");
    const person = chat.userId ? this.persons.get(chat.userId) : (this.persons.list()[0] ?? null);
    // The other character participants: in a group chat the prompt explains
    // the reply order and allows staying silent.
    const fellows = chat.characterIds
      .filter((id) => id !== characterId)
      .map((id) => this.characters.get(id))
      .filter((c): c is Character => c !== null);
    const system = this.textGeneration.systemPromptFor(
      character,
      person,
      canGenerateImages,
      inventoryText || undefined,
      fellows,
    );

    // In a group chat we label lines with authors — the model must understand
    // who said what. With a single character and a single persona the history
    // is left as-is. The chat's personas are derived from message authors;
    // there is no Chat.userIds.
    const multi = chat.characterIds.length > 1 || new Set(chat.messages.map((m) => m.userId)).size > 1;
    // The message being regenerated stays in the chat (visible to the user)
    // but is not part of the history the model sees — it is being replaced.
    const replacedIndex = replaceLast && chat.messages.length > 0 ? chat.messages.length - 1 : -1;
    const replacedMessage =
      replacedIndex !== -1 && chat.messages[replacedIndex]?.role === "assistant" ? chat.messages[replacedIndex] : null;
    const history = this.textGeneration.trimHistory(
      this.textGeneration.labelHistory(
        chat.messages.filter((m) => m !== replacedMessage && !m.error),
        Object.fromEntries(
          chat.characterIds
            .map((id) => [id, this.characters.get(id)?.name ?? id] as const)
            .filter(([id]) => chat.messages.some((m) => m.characterId === id)),
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
      chat.id,
      `The next reply is the line of the character ${character.name}. ` +
        'Write strictly in the first person of this character ("I"), ' +
        "do not write for the other characters or for the user. " +
        "If you have absolutely nothing to add to the conversation, output exactly [SILENT] instead of a reply. " +
        "Keep the reply short: 2–5 sentences, one paragraph.",
      signal,
    );

    // The character may have stayed silent (exactly [SILENT]) — no chat message.
    const spoken0 = this.textGeneration.parseSilence(replyText);
    if (spoken0 === null) return null;
    // Strip "Bob: …" / "Carol: Carol: …" — copies of author labels from the
    // history.
    const spoken = this.textGeneration.stripNamePrefixes(spoken0, [character.name, ...fellows.map((c) => c.name)]);

    // The model may have requested images itself with the [IMG:description |
    // 1,3] tag. The tags are removed and the images are generated in the
    // BACKGROUND: each gets a reserved file name that is stored in the message
    // right away (with the "pending" status) so the reply is returned to the
    // client without waiting for the (slow) generation. A failure or a cancel
    // marks the image "failed" (the broken placeholder with a Regenerate
    // button).
    const parsed = this.textGeneration.extractImageRequests(spoken);
    // [PHOTO:N] — send a ready image from the inventory as-is (a character
    // photo is copied into the chat files/ via importCharacterPhoto).
    const photoReq = this.textGeneration.extractPhotoRequests(parsed.text);
    const photoIdx = [...new Set(photoReq.photos)];
    const images: string[] =
      photoIdx.length > 0 ? this.imageGeneration.resolveInventoryRefs(chat.id, photoIdx, inventory) : [];
    const imagePrompts: Record<string, string> = {};
    const imageRefs: Record<string, string[]> = {};
    const imageStatus: Record<string, "pending" | "failed" | "cancelled"> = {};
    const pendingJobs: Array<{ name: string; prompt: string; refs: string[] }> = [];
    if (canGenerateImages) {
      for (const reqItem of parsed.requests) {
        const refs = this.imageGeneration.resolveInventoryRefs(chat.id, reqItem.refs, inventory);
        const name = this.imageGeneration.newGeneratedImageName();
        images.push(name);
        imagePrompts[name] = reqItem.prompt;
        if (refs.length > 0) imageRefs[name] = refs;
        imageStatus[name] = "pending";
        pendingJobs.push({ name, prompt: reqItem.prompt, refs });
      }
    }

    const assistantMsg: ChatMessage = {
      id: PathHelper.newId(),
      role: "assistant" as const,
      characterId,
      text: photoReq.text,
      images,
      imagePrompts: Object.keys(imagePrompts).length > 0 ? imagePrompts : undefined,
      imageRefs: Object.keys(imageRefs).length > 0 ? imageRefs : undefined,
      imageStatus: Object.keys(imageStatus).length > 0 ? imageStatus : undefined,
      timestamp: Date.now(),
    };
    // Save the reply into the chat RE-READ from disk: the model call took
    // seconds, and a concurrent change in the meantime (a message deleted or
    // added) must not be clobbered by the request-time snapshot. The
    // regeneration removal rides on the same re-read: the replaced message is
    // dropped only when it is still the last line (a cancel or an error never
    // reaches here — the original stays; a manual delete in the meantime
    // leaves nothing to remove).
    const fresh = this.chats.get(chat.id);
    if (!fresh) return null; // the chat was deleted while the model ran
    if (replacedMessage) {
      const idx = fresh.messages.findIndex((m) => m.id === replacedMessage.id);
      if (idx === fresh.messages.length - 1) fresh.messages.splice(idx, 1);
    }
    fresh.messages.push(assistantMsg);
    // Save the reply (with the reserved "pending" names) BEFORE starting the
    // jobs, so the client already sees the placeholders when the response
    // returns and the jobs update a message that exists on disk.
    this.chats.save(fresh);
    for (const job of pendingJobs) {
      this.startChatImageJob(chat.id, assistantMsg.id, job.name, job.prompt, job.refs);
    }
    return assistantMsg;
  }

  // Manual image generation (the frontend gen mode): appends a
  // "🖼️ Generated: …" assistant message with the reserved "pending" image name
  // and starts the background job. The prompt is required in English — a
  // non-English one is translated with the chat's model. Returns the saved
  // chat and the new message, or null when the chat was deleted while the
  // translation ran (nothing to save into).
  async manualImage(chat: Chat, prompt: string, refs: string[]): Promise<{ chat: Chat; message: ChatMessage } | null> {
    const finalPrompt = await this.imageGeneration.ensureEnglishPrompt(this.resolveChatModel(chat), prompt);
    const name = this.imageGeneration.newGeneratedImageName();
    const message: ChatMessage = {
      id: PathHelper.newId(),
      role: "assistant" as const,
      text: `🖼️ Generated: ${finalPrompt}`,
      images: [name],
      imagePrompts: { [name]: finalPrompt },
      imageStatus: { [name]: "pending" },
      timestamp: Date.now(),
    };
    // The chat is re-read from disk: the translation took seconds, and a
    // concurrent change in the meantime must not be clobbered by the
    // request-time snapshot (as in appendAssistantReply).
    const fresh = this.chats.get(chat.id);
    if (!fresh) return null; // the chat was deleted while translating
    fresh.messages.push(message);
    this.chats.save(fresh);
    this.startChatImageJob(chat.id, message.id, name, finalPrompt, refs);
    return { chat: fresh, message };
  }

  // Regenerates one message image in the BACKGROUND: the stored prompt (or
  // the message text) is run through the generator again, writing to the SAME
  // reserved name (the file name in the message does not change — no later
  // references need repointing). A regeneration in flight for this image is
  // cancelled first (one job per image). The status and the (possibly
  // re-translated) prompt are marked "pending" in a single re-read+save. If an
  // older image exists at the name and the run fails or is cancelled, the old
  // one is kept (the message stays ready). Returns null when the chat or the
  // message disappeared in the meantime (deleted while the request was in
  // flight).
  async regenerateImage(chat: Chat, message: ChatMessage, image: string): Promise<Chat | null> {
    const rawPrompt = message.imagePrompts?.[image] || message.text.trim() || "image";
    const prompt = await this.imageGeneration.ensureEnglishPrompt(this.resolveChatModel(chat), rawPrompt);
    const refs = message.imageRefs?.[image] ?? [];
    // A regeneration in flight for this image is cancelled — one job per image.
    this.imageGeneration.cancelJob(chat.id, image);
    const fresh = this.chats.get(chat.id);
    const fmsg = fresh?.messages.find((m) => m.id === message.id);
    if (!fresh || !fmsg) return null;
    fmsg.imagePrompts = { ...(fmsg.imagePrompts ?? {}), [image]: prompt };
    fmsg.imageStatus = { ...(fmsg.imageStatus ?? {}), [image]: "pending" };
    if (fmsg.imageErrors && image in fmsg.imageErrors) {
      delete fmsg.imageErrors[image];
      if (Object.keys(fmsg.imageErrors).length === 0) delete fmsg.imageErrors;
    }
    this.chats.save(fresh);
    this.startChatImageJob(chat.id, message.id, image, prompt, refs);
    return fresh;
  }

  // Cancels the in-flight generation of one message image. The image is marked
  // "cancelled" right away (the broken placeholder with the Regenerate
  // button); the job itself settles shortly after (its hadOld check keeps an
  // older image, if any, so a cancelled regeneration does not break a ready
  // one). Cancelling an image that is not "pending" is a no-op. Returns the
  // current chat (null when it was deleted in the meantime).
  cancelImage(chat: Chat, message: ChatMessage, image: string): Chat | null {
    if (message.imageStatus?.[image] === "pending") {
      this.imageGeneration.cancelJob(chat.id, image);
      this.chats.setMessageImageStatus(chat.id, message.id, image, "cancelled", "Generation cancelled");
    }
    return this.chats.get(chat.id);
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
      characterId: characterId || undefined,
      text: `⚠️ Error: ${error}`,
      images: [],
      timestamp: Date.now(),
      error: true,
    });
    this.chats.save(chat);
    return chat;
  }

  // Starts a background generation for the reserved image `name` (which must
  // already be saved in a chat message with the "pending" status) and updates
  // the message when it finishes:
  //   ok                       -> status cleared (the image is ready)
  //   failed / cancelled       -> "failed" + error, UNLESS an older image
  //                               existed at the name (hadOld) — then the old
  //                               file is kept and the message stays ready.
  // A job replaced by a newer one (a regeneration) does not update the
  // message.
  private startChatImageJob(chatId: string, messageId: string, name: string, prompt: string, refs: string[]): void {
    const job: ImageJob = this.imageGeneration.startImageJob({ chatId, name, prompt, refFilenames: refs });
    void job.result.then((res) => {
      // A regeneration started a newer job for the same image — it owns the
      // status now, so this (replaced) job stays silent.
      const current = this.imageGeneration.getCurrentJob(chatId, name);
      if (current !== undefined && current !== job) return;
      // ok, or a failed/cancelled run that found an older image to keep.
      if (res.status === "ok" || res.hadOld) {
        this.chats.setMessageImageStatus(chatId, messageId, name, undefined);
        return;
      }
      this.chats.setMessageImageStatus(
        chatId,
        messageId,
        name,
        res.status === "cancelled" ? "cancelled" : "failed",
        res.status === "failed" ? res.error : undefined,
      );
    });
  }
}
