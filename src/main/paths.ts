import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'

// Where the packaged Python speech backends (TTS, STT) are staged inside the
// installed app's resources directory.
export const packagedBackendDirectory = join(process.resourcesPath, 'python')

// Speech models (Pocket-TTS, Moonshine) are downloaded on first launch into a
// writable user-data cache rather than being bundled with the app, so a slim
// installer can stay small at the cost of a one-time download with internet.
export function ensureSpeechModelCacheDirectory(): string {
  const directory = join(app.getPath('userData'), 'model-cache')
  mkdirSync(directory, { recursive: true })
  return directory
}
