import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Pocket-TTS built-in voice used until the user picks another one.
export const DEFAULT_TTS_VOICE = 'jane'

export interface AISettings {
  generalBaseUrl: string
  generalApiKey: string
  generalModelId: string
  generalUseLocal: boolean
  phoneticBaseUrl: string
  phoneticApiKey: string
  phoneticModelId: string
  phoneticUseLocal: boolean
  voiceEnabled?: boolean
}

function getAISettingsPath(): string {
  return join(app.getPath('userData'), 'ai-settings.json')
}

function readStoredSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(getAISettingsPath(), 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
  } catch {
    // No or malformed settings file; start from an empty object.
  }
  return {}
}

// Reads a single boolean preference stored in ai-settings.json, falling back to
// the supplied default when the key is absent or not a boolean.
function readBooleanSetting(key: string, fallback: boolean): boolean {
  const stored = readStoredSettings()
  return typeof stored[key] === 'boolean' ? (stored[key] as boolean) : fallback
}

// Preserves unrelated keys (such as voiceEnabled) that live in the same file.
function writeSetting(key: string, value: unknown): void {
  writeFileSync(
    getAISettingsPath(),
    `${JSON.stringify({ ...readStoredSettings(), [key]: value }, null, 2)}\n`,
    'utf8'
  )
}

// Screen analysis and classification always run on the bundled Qwen3-VL
// server; only general knowledge questions are user-configurable (Nebius API).
export function getAISettings(): AISettings {
  const defaults: AISettings = {
    generalBaseUrl: process.env.GENERAL_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1/',
    generalApiKey: process.env.GENERAL_API_KEY ?? '',
    generalModelId: process.env.GENERAL_MODEL_ID ?? '',
    generalUseLocal: process.env.GENERAL_USE_LOCAL === 'true',
    phoneticBaseUrl: process.env.PHONETIC_BASE_URL ?? '',
    phoneticApiKey: process.env.PHONETIC_API_KEY ?? '',
    phoneticModelId: process.env.PHONETIC_MODEL_ID ?? '',
    phoneticUseLocal: process.env.PHONETIC_USE_LOCAL === 'true'
  }

  try {
    const stored = JSON.parse(readFileSync(getAISettingsPath(), 'utf8')) as Partial<AISettings>
    return {
      generalBaseUrl:
        typeof stored.generalBaseUrl === 'string' ? stored.generalBaseUrl : defaults.generalBaseUrl,
      generalApiKey:
        typeof stored.generalApiKey === 'string' ? stored.generalApiKey : defaults.generalApiKey,
      generalModelId:
        typeof stored.generalModelId === 'string' ? stored.generalModelId : defaults.generalModelId,
      generalUseLocal:
        typeof stored.generalUseLocal === 'boolean'
          ? stored.generalUseLocal
          : defaults.generalUseLocal,
      phoneticBaseUrl:
        typeof stored.phoneticBaseUrl === 'string'
          ? stored.phoneticBaseUrl
          : defaults.phoneticBaseUrl,
      phoneticApiKey:
        typeof stored.phoneticApiKey === 'string' ? stored.phoneticApiKey : defaults.phoneticApiKey,
      phoneticModelId:
        typeof stored.phoneticModelId === 'string'
          ? stored.phoneticModelId
          : defaults.phoneticModelId,
      phoneticUseLocal:
        typeof stored.phoneticUseLocal === 'boolean'
          ? stored.phoneticUseLocal
          : defaults.phoneticUseLocal
    }
  } catch {
    return defaults
  }
}

export function saveAISettings(settings: AISettings): void {
  writeFileSync(
    getAISettingsPath(),
    `${JSON.stringify({ ...readStoredSettings(), ...settings }, null, 2)}\n`,
    'utf8'
  )
}

// Voice activation (openwakeword + STT) is enabled by default and remembered
// across restarts. Disabling it stops the backend process so the wake word
// detector and speech recognizer stop consuming resources.
export function getVoiceEnabled(): boolean {
  return readBooleanSetting('voiceEnabled', true)
}

export function saveVoiceEnabled(enabled: boolean): void {
  writeSetting('voiceEnabled', enabled)
}

// Whether Bud also writes its spoken answer out on screen as a caption. Off by
// default so the overlay stays quiet; remembered across restarts when enabled.
export function getWriteAnswers(): boolean {
  return readBooleanSetting('writeAnswersEnabled', false)
}

export function saveWriteAnswers(enabled: boolean): void {
  writeSetting('writeAnswersEnabled', enabled)
}

// The Pocket-TTS voice Bud speaks with. Remembered across restarts so the
// choice applies to every spoken answer, not just the settings preview.
export function getTtsVoice(): string {
  const stored = readStoredSettings()
  return typeof stored.ttsVoice === 'string' && stored.ttsVoice.trim().length > 0
    ? stored.ttsVoice
    : DEFAULT_TTS_VOICE
}

export function saveTtsVoice(voice: string): void {
  writeSetting('ttsVoice', voice)
}

// The getting-started guide opens automatically once. Once the user finishes or
// skips it we remember that so it never auto-opens again; the settings panel's
// "?" button can always bring it back.
export function getGuideSeen(): boolean {
  return readBooleanSetting('hasSeenGuide', false)
}

export function saveGuideSeen(seen: boolean): void {
  writeSetting('hasSeenGuide', seen)
}

// Drops settings that are no longer user-configurable now that screen analysis
// and classification always use the bundled Qwen3-VL server.
export function migrateLegacyAISettings(): void {
  const settingsPath = getAISettingsPath()
  if (!existsSync(settingsPath)) return

  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    let changed = false

    for (const key of [
      'baseUrl',
      'apiKey',
      'modelId',
      'classificationBaseUrl',
      'classificationApiKey',
      'classificationModelId'
    ]) {
      if (key in stored) {
        delete stored[key]
        changed = true
      }
    }

    if (changed) {
      writeFileSync(settingsPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
      console.log('Migrated stored AI settings for the bundled Qwen3-VL server')
    }
  } catch (error) {
    console.error('Could not migrate stored AI settings:', error)
  }
}
