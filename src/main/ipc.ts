import { app, BrowserWindow, ipcMain } from 'electron'
import {
  askAI,
  askAboutScreen,
  askQuestion,
  parseRegion,
  type ScreenConversationMessage
} from './ai'
import { getVlStatus } from './localVlm'
import { getDisplayForWindow, isOverlayWindow, registerOverlayIpc, setVoiceWindow } from './overlay'
import {
  getAISettings,
  getGuideSeen,
  getTtsVoice,
  getVoiceEnabled,
  getWriteAnswers,
  saveAISettings,
  saveGuideSeen,
  saveTtsVoice,
  saveVoiceEnabled,
  saveWriteAnswers
} from './settings'
import { formatTextForSpeech } from './speechText'
import { getSttStatus, getTtsStatus, markSttOff } from './status'
import { streamTTS } from './tts'
import { setVoiceListenMode, startVoiceBackend, stopVoiceBackend, stopVoiceSession } from './voice'

interface PromptRequest {
  prompt: string
  fields: Record<string, unknown>
}

// Validates the shared `{ prompt }` envelope used by the AI IPC channels.
function requirePrompt(request: unknown, label: string): PromptRequest {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('prompt' in request) ||
    typeof request.prompt !== 'string' ||
    request.prompt.trim().length === 0
  ) {
    throw new Error(`${label} prompt must be a non-empty string`)
  }
  return { prompt: request.prompt, fields: request as Record<string, unknown> }
}

// Validates an optional conversation history array on the AI IPC channels.
function requireHistory(
  fields: Record<string, unknown>,
  label: string
): ScreenConversationMessage[] | undefined {
  const history = 'history' in fields ? fields.history : undefined
  if (
    history !== undefined &&
    (!Array.isArray(history) ||
      history.some(
        (message) =>
          typeof message !== 'object' ||
          message === null ||
          !('role' in message) ||
          (message.role !== 'user' && message.role !== 'assistant') ||
          !('content' in message) ||
          typeof message.content !== 'string'
      ))
  ) {
    throw new Error(`${label} history must contain valid messages`)
  }
  return history as ScreenConversationMessage[] | undefined
}

// Speaks a finished answer: normalizes it for speech, then streams the audio
// without blocking the IPC reply. Playback failures are surfaced as an event.
async function speakResult(text: string, sender: Electron.WebContents): Promise<void> {
  const spoken = await formatTextForSpeech(text)
  void streamTTS(spoken, sender, undefined, text).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'TTS playback failed'
    console.error(message)
    sender.send('tts:error', { message })
  })
}

function assertHttpUrl(value: string, errorMessage: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
  } catch {
    throw new Error(errorMessage)
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle('ai:ask', async (_event, request: unknown) => {
    const { prompt, fields } = requirePrompt(request, 'AI')

    const imageUrl = 'imageUrl' in fields ? fields.imageUrl : undefined
    if (imageUrl !== undefined && typeof imageUrl !== 'string') {
      throw new Error('AI imageUrl must be a string')
    }

    if (
      imageUrl !== undefined &&
      !imageUrl.startsWith('data:image/') &&
      !imageUrl.startsWith('https://')
    ) {
      throw new Error('AI imageUrl must be an image data URL or an HTTPS URL')
    }

    const response = await askAI({ prompt, imageUrl })
    await speakResult(response, _event.sender)
    return response
  })

  ipcMain.handle('ai:ask-screen', async (_event, request: unknown) => {
    const { prompt, fields } = requirePrompt(request, 'Screen analysis')
    const history = requireHistory(fields, 'Screen analysis')

    const result = await askAboutScreen(
      prompt,
      history,
      parseRegion('region' in fields ? fields.region : undefined),
      getDisplayForWindow(BrowserWindow.fromWebContents(_event.sender))
    )
    await speakResult(result.text, _event.sender)
    return result
  })

  ipcMain.handle('ai:ask-question', async (_event, request: unknown) => {
    const { prompt, fields } = requirePrompt(request, 'Question')
    const history = requireHistory(fields, 'Question')

    const result = await askQuestion(
      prompt,
      history,
      parseRegion('region' in fields ? fields.region : undefined),
      getDisplayForWindow(BrowserWindow.fromWebContents(_event.sender))
    )
    await speakResult(result.text, _event.sender)
    return result
  })

  ipcMain.handle('tts:speak', async (_event, text: unknown, voice: unknown) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('TTS text must be a non-empty string')
    }

    if (voice !== undefined && (typeof voice !== 'string' || voice.trim().length === 0)) {
      throw new Error('TTS voice must be a non-empty string')
    }

    void streamTTS(
      text.trim(),
      _event.sender,
      typeof voice === 'string' ? voice.trim() : undefined,
      text.trim()
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'TTS playback failed'
      console.error(message)
      _event.sender.send('tts:error', { message })
    })
  })

  ipcMain.handle('tts:get-voice', () => getTtsVoice())

  ipcMain.handle('tts:set-voice', (_event, voice: unknown) => {
    if (typeof voice !== 'string' || voice.trim().length === 0) {
      throw new Error('TTS voice must be a non-empty string')
    }

    const trimmed = voice.trim()
    saveTtsVoice(trimmed)
    return trimmed
  })

  ipcMain.handle('voice:stop-session', () => {
    stopVoiceSession()
    setVoiceWindow(undefined)
  })

  ipcMain.handle('voice:get-enabled', () => getVoiceEnabled())

  ipcMain.handle('voice:set-enabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Voice enabled must be a boolean')
    }

    saveVoiceEnabled(enabled)

    if (enabled) {
      startVoiceBackend()
    } else {
      stopVoiceSession()
      stopVoiceBackend()
      markSttOff()
    }

    return enabled
  })

  ipcMain.handle('voice:set-listen-mode', (event, continuous: unknown) => {
    if (typeof continuous !== 'boolean') {
      throw new Error('Voice listen mode must be a boolean')
    }
    if (continuous) {
      // Anchor auto-listening to the overlay that started it so a drifting
      // cursor cannot move the conversation to a different display.
      const win = BrowserWindow.fromWebContents(event.sender)
      if (isOverlayWindow(win)) setVoiceWindow(win)
    }
    setVoiceListenMode(continuous)
  })

  ipcMain.handle('answers:get-write', () => getWriteAnswers())

  ipcMain.handle('answers:set-write', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('Write answers flag must be a boolean')
    }

    saveWriteAnswers(enabled)
    return enabled
  })

  ipcMain.handle('settings:get-ai', () => getAISettings())

  ipcMain.handle('guide:get-seen', () => getGuideSeen())

  ipcMain.handle('guide:set-seen', (_event, seen: unknown) => {
    if (typeof seen !== 'boolean') {
      throw new Error('Guide seen flag must be a boolean')
    }

    saveGuideSeen(seen)
    return seen
  })

  ipcMain.handle('vl:get-status', () => getVlStatus())

  ipcMain.handle('stt:get-status', () => getSttStatus())

  ipcMain.handle('tts:get-status', () => getTtsStatus())

  ipcMain.handle('app:quit', () => {
    app.quit()
  })

  ipcMain.handle('settings:save-ai', (_event, settings: unknown) => {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('AI settings must be an object')
    }

    const trim = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

    const generalUseLocal = 'generalUseLocal' in settings ? settings.generalUseLocal : undefined
    if (generalUseLocal !== undefined && typeof generalUseLocal !== 'boolean') {
      throw new Error('General use-local flag must be a boolean')
    }
    const phoneticUseLocal = 'phoneticUseLocal' in settings ? settings.phoneticUseLocal : undefined
    if (phoneticUseLocal !== undefined && typeof phoneticUseLocal !== 'boolean') {
      throw new Error('Phonetic use-local flag must be a boolean')
    }
    const useLocalForGeneral = generalUseLocal === true
    const useLocalForPhonetic = phoneticUseLocal === true

    // The external endpoint is only required when the service is not set to
    // run on the bundled local model.
    if (
      !useLocalForGeneral &&
      (!('generalBaseUrl' in settings) ||
        typeof settings.generalBaseUrl !== 'string' ||
        !settings.generalBaseUrl.trim() ||
        !('generalApiKey' in settings) ||
        typeof settings.generalApiKey !== 'string' ||
        !settings.generalApiKey.trim() ||
        !('generalModelId' in settings) ||
        typeof settings.generalModelId !== 'string' ||
        !settings.generalModelId.trim())
    ) {
      throw new Error('AI settings require a base URL, API key, and model ID')
    }

    const trimmedGeneralBaseUrl = trim('generalBaseUrl' in settings ? settings.generalBaseUrl : '')
    if (!useLocalForGeneral) {
      assertHttpUrl(trimmedGeneralBaseUrl, 'AI base URLs must be valid HTTP or HTTPS URLs')
    }

    const phoneticBaseUrl = 'phoneticBaseUrl' in settings ? settings.phoneticBaseUrl : undefined
    if (phoneticBaseUrl !== undefined && typeof phoneticBaseUrl !== 'string') {
      throw new Error('Phonetic base URL must be a string')
    }
    const phoneticApiKey = 'phoneticApiKey' in settings ? settings.phoneticApiKey : undefined
    if (phoneticApiKey !== undefined && typeof phoneticApiKey !== 'string') {
      throw new Error('Phonetic API key must be a string')
    }
    const phoneticModelId = 'phoneticModelId' in settings ? settings.phoneticModelId : undefined
    if (phoneticModelId !== undefined && typeof phoneticModelId !== 'string') {
      throw new Error('Phonetic model ID must be a string')
    }

    const trimmedPhoneticBaseUrl = typeof phoneticBaseUrl === 'string' ? phoneticBaseUrl.trim() : ''
    if (trimmedPhoneticBaseUrl) {
      assertHttpUrl(trimmedPhoneticBaseUrl, 'Phonetic base URL must be a valid HTTP or HTTPS URL')
    }

    const savedSettings = {
      generalBaseUrl: trimmedGeneralBaseUrl,
      generalApiKey: trim('generalApiKey' in settings ? settings.generalApiKey : ''),
      generalModelId: trim('generalModelId' in settings ? settings.generalModelId : ''),
      generalUseLocal: useLocalForGeneral,
      phoneticBaseUrl: trimmedPhoneticBaseUrl,
      phoneticApiKey: typeof phoneticApiKey === 'string' ? phoneticApiKey.trim() : '',
      phoneticModelId: typeof phoneticModelId === 'string' ? phoneticModelId.trim() : '',
      phoneticUseLocal: useLocalForPhonetic
    }
    saveAISettings(savedSettings)
    return savedSettings
  })

  registerOverlayIpc()
}
