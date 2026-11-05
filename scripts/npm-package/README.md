# sillytalk

A web chat app for talking to **AI characters**, with first-class image support. A user chats
with a configured AI persona; the model can receive images (vision) and generate images — from
text, or from reference images (the character's "starter" photo set, or images already in the
chat). The Node.js/Express backend serves both the API and the built Angular frontend on a
single port.

## Run

Requires Node.js >= 24.

```bash
npx --yes sillytalk@latest
```

Open http://127.0.0.1:3210.

## Configuration

- Config, characters, personas and chats: `~/.config/sillytalk/` (created automatically on the
  first run, with examples). Edit the file directly or use the in-app **Settings** dialog.
- Listen address: `listen` in `config.json` (default `0.0.0.0:3210`).
- Models: any OpenAI-compatible endpoint — `baseUrl` + `apiKey` (or `envKey`) per model entry.
- Image generation: ComfyUI (the app ships the `qwen-image-2.1` and `qwen-image-2512` workflows)
  and/or an SD API (Stable Diffusion WebUI) — every enabled generator whose URL answers is used,
  the jobs of one server are queued and different servers run in parallel. Set a generator up in
  the **Settings** dialog. A ComfyUI workflow is a plain JSON file: your own
  `~/.config/sillytalk/comfyui/<model>.json` replaces the shipped workflow of that name or adds a
  model, with no rebuild.

Environment overrides: `SILLYTALK_DATA_DIR` moves the whole data root elsewhere;
`SILLYTALK_CHATS_DIR` / `SILLYTALK_CHARACTERS_DIR` / `SILLYTALK_USERS_DIR` override the
individual folders; `SILLYTALK_LISTEN` overrides the listen address.

See https://github.com/yar3333/sillytalk for the full documentation.
