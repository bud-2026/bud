# bud

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Local Qwen3-VL server

Screen and classification answers are served by a bundled [llama.cpp](https://github.com/ggml-org/llama.cpp)
`llama-server` process (CUDA build) that the app starts on `127.0.0.1:8766` at launch — no LM Studio
required. General knowledge questions still go to the Nebius API.

- On first launch the app automatically downloads everything it needs into `app.getPath('userData')`:
  the llama.cpp runtime archive (~615 MB) plus `Qwen3VL-4B-Instruct-Q4_K_M.gguf` (2.5 GB) and
  `mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf` (454 MB) from `Qwen/Qwen3-VL-4B-Instruct-GGUF`. Progress
  shows in the debug panel (Ctrl+Shift+Space).
- Installers produced by `npm run build:win` already bundle the llama.cpp runtime, so packaged apps
  only download the model weights.
- `npm run prepare:vl` is optional: it pre-stages the runtime into `build/vl` (archives cached in
  `build/vl-download`) for offline development or installer bundling.
- Settings that still point at `http://127.0.0.1:1234/v1/` (LM Studio) are migrated automatically.

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
