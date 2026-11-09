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
import { ImageBrief, ImageCastMember, ImagePromptPlan, TextGenerationService } from "../text_generation/TextGenerationService";
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

  // The model that describes pictures for this chat: its own pick (the header's
  // vision menu), else the chat's model when it can see, else the first model of
  // the config that can. Null when nothing in the config has vision.
  resolveVisionModel(chat: Chat): Model | null {
    return this.textGeneration.resolveVisionModel(this.configuration.loadConfig(), chat);
  }

  // The model that writes the picture prompts (the 📷 planner and "From the
  // chat"): the global Settings pick when it names a model, else the chat's own
  // model. The rule lives in TextGenerationService; this is the chat-aware entry.
  resolveImagePromptModel(chat: Chat): Model | null {
    return this.textGeneration.resolveImagePromptModel(this.configuration.loadConfig(), chat);
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
    const spoken = await this.imageGeneration.ensureEnglishPrompt(this.resolveChatModel(chat), prompt);
    const finalPrompt = this.withChatStyle(chat, spoken);
    const id = this.chats.reservedImageId(chat.id, spoken);
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
      const model = this.resolveImagePromptModel(chat);
      if (!model) {
        giveUp("No model configured for the chat");
        return;
      }
      const maxRefs = this.imageGeneration.maxReferenceCount();
      const material = this.pictureMaterial(chat, messageId, maxRefs);
      const plan = await this.textGeneration.composeImagePrompt(model, {
        scene: this.dialogueForImage(chat, messageId),
        images: material.images,
        cast: material.cast,
        maxRefs,
        ...(chat.stylePrompt ? { style: chat.stylePrompt } : {}),
        sampling: chat.sampling,
      });
      if (!plan) {
        giveUp("The model did not describe a picture to draw");
        return;
      }
      // Cancelled or deleted while the model was thinking — leave it as the
      // user left it.
      if (!this.cardIsPending(chatId, messageId, placeholder)) return;
      const done = this.finishPlan(chat, plan, material);
      const id = this.chats.reservedImageId(chatId, done.name);
      if (!this.chats.replaceMessageImageId(chatId, messageId, placeholder, id)) return;
      this.chats.setMessageImageStatus(chatId, messageId, id, "pending");
      const generation: ImageGenerationData = {
        prompt: done.prompt,
        refs: done.refs.length > 0 ? done.refs : undefined,
        source: "auto",
        model: chat.modelId,
        createdAt: new Date().toISOString(),
      };
      // Who is on the picture goes in before the caption: both writes go to the
      // same row of the images table, and the row must already know the cast.
      if (done.depicts.length > 0) this.chats.setMessageDepicts(chatId, messageId, done.depicts);
      this.chats.writeImageMeta(id, done.description, generation, done.depicts);
      if (done.description) this.chats.setMessageText(chatId, messageId, done.description);
      this.startChatImageJob(id, done.prompt, done.refs, chatId, {
        prompt: done.prompt,
        refs: done.refs,
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

  // ---- the material a picture is planned from ----

  // The numbered pictures to draw from plus the cast they belong to. Both are
  // built here, in one pass, because the cast is expressed IN the numbering:
  // a person's entry says "shown on picture 3", and picture 3 is one of the
  // briefs below.
  //
  // The pictures come from two places, and the second one is the whole point:
  // besides what already appeared in the chat, every person brings their own
  // look references — the character's photo set, their avatar, and the earlier
  // pictures this chat already drew of them. Without that the generator gets a
  // name it has never heard and invents a new face on every roll.
  private pictureMaterial(
    chat: Chat,
    exceptMessageId?: string,
    maxRefs = 0,
  ): { images: ImageBrief[]; cast: ImageCastMember[] } {
    const images = this.chatPictureBriefs(chat, exceptMessageId);
    const anchorsOf = Math.max(0, Math.min(2, maxRefs));
    const cast: ImageCastMember[] = [];
    for (const person of this.pictureCast(chat)) {
      // The chat's own pictures of this person, newest first — they are worth
      // more than a studio photo: the same person AND the same look as the rest
      // of the conversation. Then their own photo set, then the avatar.
      const drawn = this.personChatPictureIds(chat, person.ref, exceptMessageId);
      const anchors = [...drawn, ...this.lookPhotoIds(person).filter((id) => !drawn.includes(id))];
      const member: ImageCastMember = {
        ref: person.ref,
        name: person.name,
        ...(person.look ? { look: person.look } : {}),
        anchors: [],
      };
      if (anchorsOf > 0) {
        for (const id of anchors.slice(0, anchorsOf)) {
          let number = images.findIndex((b) => b.id === id) + 1;
          if (number === 0) {
            images.push({ id, role: "look", ofWho: person.ref, shows: person.name });
            number = images.length;
          }
          member.anchors.push(number);
        }
      }
      cast.push(member);
    }
    return { images, cast };
  }

  // The pictures of this chat that say who this person is (their cards, newest
  // first), so the next scene is drawn from a face the conversation already
  // uses. A card whose file is gone cannot be drawn from and is not offered.
  private personChatPictureIds(chat: Chat, ref: string, exceptMessageId?: string): string[] {
    return chat.messages
      .filter((m) => isImageMessage(m) && m.id !== exceptMessageId && (m.depicts ?? []).includes(ref))
      .map((m) => m.images[0])
      .filter((id) => {
        const file = id ? PathHelper.resolveImageId(id) : null;
        return file !== null && fs.existsSync(file);
      })
      .reverse();
  }

  // ---- the picture cast ----

  // The people a picture of this chat can show: the characters in it, the
  // active persona, and every persona that ever spoke here (a former one still
  // turns up in the story). Each carries the cast ref the plan answers with and
  // the visual description the generator has to work from — the card text,
  // which the planner reads for the appearance in it.
  private pictureCast(chat: Chat): Array<{ ref: string; name: string; look?: string; id: string; kind: "char" | "user" }> {
    const ids = [...chat.characterIds];
    const personas = [...new Set([chat.userId, ...chat.messages.map((m) => m.userId)].filter((id): id is string => !!id))];
    const out: Array<{ ref: string; name: string; look?: string; id: string; kind: "char" | "user" }> = [];
    for (const id of ids) {
      const c = this.characters.get(id);
      if (!c) continue;
      const look = this.visualLine(c.description);
      out.push({ ref: `char:${id}`, name: c.name, id, kind: "char", ...(look ? { look } : {}) });
    }
    for (const id of personas) {
      const p = this.persons.get(id);
      if (!p) continue;
      const look = this.visualLine(p.description);
      out.push({ ref: `user:${id}`, name: p.name, id, kind: "user", ...(look ? { look } : {}) });
    }
    return out;
  }

  // The visual line of a cast entry: the card text, capped so one long card
  // cannot eat the whole planning prompt. A roleplay card mixes a personality
  // with an appearance and the generator can only use the second half, so this
  // line is a hint beside the reference pictures, not a description of a face.
  private visualLine(description: string): string | undefined {
    const text = description.trim();
    if (!text) return undefined;
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }

  // The person's own pictures — the faces the generator should copy instead of
  // inventing. Their avatar first (the one picture the user picked to BE their
  // face), then the rest of their folder; a persona has only the avatar. The
  // ids are data-root-relative picture ids, so they reach the generator the
  // same way as any reference.
  private lookPhotoIds(person: { id: string; kind: "char" | "user" }): string[] {
    const ids: string[] = [];
    const avatar =
      person.kind === "char" ? this.characters.getAvatarId(person.id) : this.persons.getAvatarId(person.id);
    if (avatar) ids.push(avatar);
    if (person.kind === "char") ids.push(...this.characters.pictureIdsOf(person.id));
    // Two is plenty for one person and the reference budget is smaller than the
    // number of people in a group chat — every slot a spare photo takes is a
    // face another character does not get.
    const seen = new Set<string>();
    return ids
      .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
      .filter((id) => {
        const file = PathHelper.resolvePictureId(id);
        return file !== null && fs.existsSync(file);
      })
      .slice(0, 2);
  }

  // The pictures the chat itself produced, in the order of the conversation:
  // what each shows, how it got there, who shared it, and who stands in it.
  // A card whose file is gone is left out, so the model is never offered a
  // reference that cannot be drawn from; only the most recent pictures are
  // offered at all — an old one is unlikely to be what the next scene needs.
  private chatPictureBriefs(chat: Chat, exceptMessageId?: string, limit = 8): ImageBrief[] {
    const total = chat.messages.length;
    const rows: Array<{ brief: ImageBrief; depicts: string[] }> = [];
    chat.messages.forEach((m, index) => {
      if (!isImageMessage(m) || m.id === exceptMessageId) return;
      const id = m.images[0];
      if (!id) return;
      const file = PathHelper.resolveImageId(id);
      if (!file || !fs.existsSync(file)) return;
      const fromEnd = total - 1 - index;
      rows.push({
        brief: {
          id,
          role: "chat",
          description: m.text.trim() || undefined,
          prompt: m.generation?.prompt,
          owner: this.authorName(m),
          age: fromEnd === 0 ? "the last message" : `${fromEnd} messages ago`,
          origin: m.generation?.prompt ? "generated" : "uploaded",
        },
        depicts: m.depicts ?? [],
      });
    });
    return rows
      .slice(Math.max(0, rows.length - limit))
      .map(({ brief, depicts }) => {
        const shows = this.castNameOfRefs(depicts);
        return shows ? { ...brief, shows } : brief;
      });
  }

  // The display names of cast refs, for a picture's "shows:" line. The names
  // live in the planning prompt only — the generator never sees them.
  private castNameOfRefs(refs: string[]): string {
    const names = refs
      .map((ref) => {
        const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
        if (kind === "char") return this.characters.get(id)?.name;
        if (kind === "user") return this.persons.get(id)?.name;
        return undefined;
      })
      .filter((n): n is string => !!n);
    return names.join(" and ");
  }

  // ---- what the plan becomes: the prompt and the references of one picture ----

  // Turns the model's plan into what the generator is given. The model decides
  // the scene; the app decides the references and says what each of them is
  // for, because that is the half a text model gets wrong: it names people the
  // generator has never heard of and picks no face to copy.
  //
  // Three deterministic steps:
  //   1. every person the plan shows gets a picture of their own as a reference
  //      — a familiar face before anything else;
  //   2. then whatever else the plan asked to keep (a place, a style);
  //   3. clamped to what the generator can actually take.
  // The prompt then gets every name replaced by the plan's own visual phrase
  // (a disobedient model still cannot send a name to the generator) and the
  // binding sentence that ties each reference to its role by its ORDER — the
  // order the driver uploads and loads them in.
  private finishPlan(
    chat: Chat,
    plan: ImagePromptPlan,
    material: { images: ImageBrief[]; cast: ImageCastMember[] },
  ): { name: string; description: string; prompt: string; refs: string[]; depicts: string[] } {
    const maxRefs = this.imageGeneration.maxReferenceCount();
    const refs: string[] = [];
    const addRef = (number: number | undefined): void => {
      const id = number !== undefined ? material.images[number - 1]?.id : undefined;
      if (id && !refs.includes(id)) refs.push(id);
    };
    for (const ref of plan.cast) {
      for (const anchor of material.cast.find((c) => c.ref === ref)?.anchors ?? []) addRef(anchor);
    }
    for (const n of plan.refs) addRef(n);
    const chosen = refs.slice(0, Math.max(0, maxRefs));
    const prompt = this.withChatStyle(
      chat,
      [this.describePeople(plan, material), this.refBinding(chosen, this.ownerOfAnchors(material), plan)]
        .filter(Boolean)
        .join(" ")
        .trim(),
    );
    return { name: plan.name, description: plan.description, prompt, refs: chosen, depicts: [...plan.cast] };
  }

  // Which person each offered picture was chosen as the face OF. The cast's
  // anchors are the authority, not a picture's own role: a card from the chat
  // is a piece of the story AND, when it shows somebody, their face — and the
  // binding sentence has to say the second part, or the generator keeps its
  // style and quietly repaints the person.
  private ownerOfAnchors(material: {
    images: ImageBrief[];
    cast: ImageCastMember[];
  }): Map<string, string> {
    const owners = new Map<string, string>();
    for (const member of material.cast) {
      for (const anchor of member.anchors) {
        const id = material.images[anchor - 1]?.id;
        if (id && !owners.has(id)) owners.set(id, member.ref);
      }
    }
    return owners;
  }

  // The safety net under the no-names rule: a prompt that still says "Alice" is
  // rewritten to the phrase the plan itself used for her ("the red-haired
  // woman"). Only for the people the plan actually shows, and only when it
  // found a phrase — an invented substitution would change the scene.
  private describePeople(
    plan: ImagePromptPlan,
    material: { images: ImageBrief[]; cast: ImageCastMember[] },
  ): string {
    let text = plan.prompt;
    for (const subject of plan.subjects) {
      const name = material.cast.find((c) => c.ref === subject.ref)?.name?.trim();
      if (!name) continue;
      text = text.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), subject.noun);
    }
    return text;
  }

  // Says what each reference image is for, in the order the generator receives
  // them: a face to keep identical, or a picture of this conversation whose
  // style to keep. Names are never used here either — the generator reads
  // "the first image", not "Alice".
  private refBinding(refs: string[], owners: Map<string, string>, plan: ImagePromptPlan): string {
    if (refs.length === 0) return "";
    const clauses = refs.map((id, i) => {
      const owner = owners.get(id);
      const noun = owner ? plan.subjects.find((s) => s.ref === owner)?.noun : undefined;
      const at = `the ${ReplyService.ordinal(i + 1)} reference image`;
      if (noun) return `${at} shows ${noun} — draw them with exactly the same face, hair and outfit`;
      if (owner) return `${at} shows a person of this story — keep their face and clothing identical`;
      return `${at} is a picture from this conversation — keep its art style`;
    });
    return `Reference images: ${clauses.join("; ")}.`;
  }

  // The one look of this chat, appended last so every picture of one
  // conversation is drawn in the same technique. A prompt that already carries
  // it — a regeneration of a stored prompt — is left alone, or the style would
  // stack once per redraw.
  private withChatStyle(chat: Chat, prompt: string): string {
    const style = chat.stylePrompt?.trim();
    if (!style || prompt.includes(style)) return prompt;
    return `${prompt.trim()} Style: ${style}`;
  }

  // "the first reference image", "the second…" — a generator follows an
  // ordinal better than a bare number, and beyond the third the number is as
  // good a word as any.
  private static ordinal(n: number): string {
    return ["first", "second", "third"][n - 1] ?? String(n);
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
  // marked "pending" in a single re-read+save and written into the picture's
  // row. If an older file exists at the id and the run fails or is cancelled,
  // the old one is kept (the card stays ready).
  //
  // `promptOverride` — a new prompt typed by the user (the "edit prompt then
  // regenerate" flow): when given, it replaces the stored one (after the usual
  // English translation).
  //
  // Returns null when the chat or the message disappeared in the meantime.
  async regenerateImage(chat: Chat, message: ChatMessage, image: string, promptOverride?: string): Promise<Chat | null> {
    const rawPrompt =
      (promptOverride && promptOverride.trim()) || message.generation?.prompt || message.text.trim() || "image";
    const spoken = await this.imageGeneration.ensureEnglishPrompt(this.resolveChatModel(chat), rawPrompt);
    // The chat's look rides along with the redraw (withChatStyle leaves a
    // prompt that already carries it alone, so a redraw does not stack it).
    const prompt = this.withChatStyle(chat, spoken);
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
    this.chats.writeImageMeta(image, fmsg.text, fmsg.generation);
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
  // The message and the picture's row of the images table are both updated.
  // Returns the saved chat (null — the card is gone).
  editPicture(
    chat: Chat,
    message: ChatMessage,
    patch: {
      description?: string;
      prompt?: string;
      image?: string;
      kind?: "generated" | "file";
      // The pictures the card should be redrawn from, in the order the
      // generator gets them — the "From the chat" button saves them together
      // with the prompt that refers to them.
      refs?: string[];
      // Who the user says is on the picture (cast refs); [] clears the claim.
      depicts?: string[];
    },
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
    const refs = patch.refs?.filter((id) => typeof id === "string" && id);
    let generation: ImageGenerationData | null | undefined;
    if (patch.kind === "file") {
      // The card keeps its picture but stops claiming a generation. The row's
      // generation keys go too, or the prompt would come back on
      // read. A re-pointed card needs nothing: the swap already dropped the
      // block, and the new file's row (which another card may share) is
      // not ours to rewrite.
      generation = repointed ? undefined : null;
    } else if (patch.kind === "generated" || prompt !== undefined || refs !== undefined) {
      generation = {
        ...(fmsg.generation ?? {}),
        // an empty prompt is a real edit — the card then has nothing to redraw
        // from until the user writes one
        ...(prompt !== undefined ? { prompt } : {}),
        ...(refs !== undefined ? { refs: refs.length > 0 ? refs : undefined } : {}),
        source: fmsg.generation?.source ?? ("manual" as const),
      };
    }
    this.chats.editImageCard(fresh, fmsg, {
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.depicts !== undefined ? { depicts: patch.depicts } : {}),
      ...(generation !== undefined ? { generation } : {}),
    });
    return fresh;
  }

  // ---- the LLM helpers of the picture editor ----

  // The prompt for one picture card, planned by the model from the dialogue —
  // the "From the chat" button: what the user wants to show right now, with the
  // card being edited left out of the dialogue and of the picture catalogue (it
  // is what is being planned). The answer is what the generator would be given:
  // the finished prompt AND the reference pictures the plan picked, so the
  // editor saves a pair that belongs together — a prompt talking about "the
  // first reference image" without that reference would redraw something else.
  // Returns null when the chat is gone and when the model cannot produce a
  // readable plan.
  async planPicturePrompt(
    chatId: string,
    messageId?: string,
  ): Promise<{ prompt: string; description: string; refs: string[] } | null> {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    const model = this.resolveImagePromptModel(chat);
    if (!model) return null;
    const maxRefs = this.imageGeneration.maxReferenceCount();
    const material = this.pictureMaterial(chat, messageId, maxRefs);
    const plan = await this.textGeneration.composeImagePrompt(model, {
      scene: this.dialogueForImage(chat, messageId),
      images: material.images,
      cast: material.cast,
      maxRefs,
      ...(chat.stylePrompt ? { style: chat.stylePrompt } : {}),
      sampling: chat.sampling,
    });
    if (!plan) return null;
    const done = this.finishPlan(chat, plan, material);
    return { prompt: done.prompt, description: done.description, refs: done.refs };
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

  // Describes a picture with the chat's vision model — the "Describe the
  // picture" button: an existing picture of the data folder or a data URL of a
  // file the user just picked. Null when the chat is gone (a model error — no
  // vision, no model — propagates to the route).
  async describePicture(
    chatId: string,
    input: { imageId?: string; dataUrl?: string },
  ): Promise<string | null> {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    const model = this.resolveVisionModel(chat);
    if (!model || !model.supportsImages) throw new Error(ReplyService.noVisionMessage(model));
    return (await this.textGeneration.describePicture(model, input, chat.sampling)).trim();
  }

  // The wording of "this chat has nothing to look at pictures with" — shared by
  // the service's own check and the guard of the /describe route so the banner
  // and the 400 cannot drift apart.
  static noVisionMessage(model: Model | null): string {
    return model
      ? `"${model.name}" cannot see pictures — pick a model that can in the header's vision menu`
      : "No model that can see pictures is configured — pick one in the header's vision menu";
  }

  // Writes the caption of an attached picture the user gave no description to
  // (the 📎 flow): the chat's vision model looks at the file and its sentence
  // becomes the card's caption. That caption is not decoration — it is what a
  // chat model without vision is told about the picture in the history, and
  // what the picture planner of the 📷 flow reads in its catalogue — so an
  // unlabelled photo is a lost one for the rest of the conversation.
  //
  // Only an empty caption is filled: what the user wrote in the editor (or in
  // the picture browser) is theirs. Nothing is invented when the chat has no
  // vision model or the model fails — a picture with no caption is a normal
  // state, not an error, and the card keeps its Describe button for a manual
  // try. Returns the fresh chat, or null when it disappeared.
  async captionPicture(chatId: string, messageId: string): Promise<Chat | null> {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    const card = chat.messages.find((m) => m.id === messageId);
    const image = card?.images[0];
    if (!card || !isImageMessage(card) || !image || card.text.trim()) {
      return this.chats.get(chatId);
    }
    const model = this.resolveVisionModel(chat);
    if (!model || !model.supportsImages) return this.chats.get(chatId);
    let description = "";
    try {
      description = (await this.textGeneration.describePicture(model, { imageId: image }, chat.sampling)).trim();
    } catch {
      return this.chats.get(chatId);
    }
    if (!description) return this.chats.get(chatId);
    // The caption is written into the row as it is NOW: the user may have typed
    // one, or deleted the card, while the model was looking.
    const fresh = this.chats.get(chatId);
    const live = fresh?.messages.find((m) => m.id === messageId);
    if (!fresh || !live || !isImageMessage(live)) return null;
    if (live.text.trim()) return fresh;
    this.chats.setMessageText(chatId, messageId, description);
    return this.chats.get(chatId) ?? fresh;
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
    const job: ImageJob = this.imageGeneration.startImageJob({
      id,
      prompt,
      refs,
      // The chat may be deleted while the job waits in the queue. The check is
      // the chat store's — the folder on disk is not the evidence anymore (the
      // chat lives in the database, its folder exists only once it owns a file).
      gone: () => !this.chats.exists(chatId),
      meta,
    });
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
