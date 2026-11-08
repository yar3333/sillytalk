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

With an argument the command is the CLI instead of the app:

```bash
npx --yes sillytalk@latest test-comfyui http://127.0.0.1:8188
```

`test-comfyui <url>` tests a ComfyUI server before you configure it: it checks the server and its
GPUs, every workflow the app can draw with, the converter custom node, the node classes and model
files the server actually has, and then draws one real picture per template (text, 1 reference,
2 references) into `~/.config/sillytalk/comfyui-test/`, naming the reason and the fix for anything
that did not work. It reads and changes nothing of your config. `--size 768x768`, `--device cuda:1`,
`--model <name>`, `--no-refs`, `--no-draw` and `--out <dir>` steer it; `sillytalk help` lists them.

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
