import { createPhoneticClient } from './ai'
import { ensureLocalVlmReady } from './localVlm'
import { phoneticFormattingSystemPrompt } from './prompts'
import { getAISettings } from './settings'

function sanitizeForTTS(text: string): string {
  const preserveContractions = true
  const normalizeWhitespace = true

  if (!text || typeof text !== 'string') {
    return ''
  }

  let cleaned = text

  // 1. Remove Markdown syntax: headers (#), bold/italic (*, _), strikethrough (~), code blocks (`)
  cleaned = cleaned.replace(/[*_~#`]/g, '')

  // 2. Remove URLs and domain names
  cleaned = cleaned.replace(/https?:\/\/\S+|www\.\S+/gi, '')

  // 3. Remove standalone special symbols and bracket characters
  cleaned = cleaned.replace(/[\[\](){}<>@\/\^|\\]/g, ' ')

  // 4. Strip emojis and non-standard Unicode symbols
  // Uses Unicode property escapes (\p{Extended_Pictographic})
  cleaned = cleaned.replace(/\p{Extended_Pictographic}/gu, '')

  // 5. Remove any character that is NOT a letter, number, white-space, or speech punctuation
  // Preserved punctuation: . , ! ? - and conditionally '
  const allowedCharsRegex = preserveContractions
    ? /[^a-zA-Target-zA-Z0-9\s.,!?'\-]/g
    : /[^a-zA-Target-zA-Z0-9\s.,!?\-]/g

  cleaned = cleaned.replace(allowedCharsRegex, '')

  // 6. Fix orphaned hyphens or repetitive punctuation
  cleaned = cleaned.replace(/(?<!\w)-(?!\w)/g, ' ') // remove floating dashes
  cleaned = cleaned.replace(/[-]{2,}/g, ' ') // collapse multiple dashes

  // 7. Normalize whitespaces and trim leading/trailing spaces
  if (normalizeWhitespace) {
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
  }

  return cleaned
}

// Converts a finished answer into TTS-friendly spoken text using the separately
// configured phonetic formatting model. Falls back to the regex cleanup when
// that model is not configured or the request fails, so speech is never blocked.
export async function formatTextForSpeech(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ''

  const settings = getAISettings()
  const useLocal = settings.phoneticUseLocal

  if (
    !useLocal &&
    (!settings.phoneticBaseUrl || !settings.phoneticApiKey || !settings.phoneticModelId)
  ) {
    return sanitizeForTTS(trimmed)
  }

  try {
    if (useLocal) await ensureLocalVlmReady()
    const { client, model } = createPhoneticClient(settings)
    const response = await client.chat.completions.create({
      model,
      temperature: 0.0,
      ...(useLocal ? {} : { reasoning_effort: 'none' as const }),
      messages: [
        { role: 'system', content: phoneticFormattingSystemPrompt },
        { role: 'user', content: trimmed }
      ]
    })

    const content = response.choices[0]?.message.content
    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new Error('The phonetic model returned an empty response')
    }

    return sanitizeForTTS(content.trim())
  } catch (error) {
    console.error('Phonetic formatting failed; falling back to text cleanup:', error)
    return sanitizeForTTS(trimmed)
  }
}
