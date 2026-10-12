import { useState } from 'react'
import type { FormEvent } from 'react'

interface VoiceSectionProps {
  isVoiceEnabled: boolean
  onToggleVoice: () => void
  onError: (message: string | null) => void
}

function VoiceSection({
  isVoiceEnabled,
  onToggleVoice,
  onError
}: VoiceSectionProps): React.JSX.Element {
  const [ttsText, setTtsText] = useState('')
  const [isTtsLoading, setIsTtsLoading] = useState(false)

  const handleTtsSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = ttsText.trim()

    if (!text || isTtsLoading) return

    setIsTtsLoading(true)
    onError(null)
    try {
      await window.api.tts.speak(text)
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : 'TTS request failed')
    } finally {
      setIsTtsLoading(false)
    }
  }

  return (
    <div className="settings-section">
      <div className="question-panel">
        <label className="voice-toggle">
          <input type="checkbox" checked={isVoiceEnabled} onChange={onToggleVoice} />
          <span>Enable voice activation (wake word &amp; speech-to-text)</span>
        </label>
        <p className="question-panel__voice-status">
          {isVoiceEnabled
            ? 'Wake word detection and speech-to-text are running.'
            : 'Voice is off · openwakeword and STT are stopped.'}
        </p>
      </div>

      <form className="question-panel" onSubmit={handleTtsSubmit}>
        <label htmlFor="tts-text">Test text-to-speech</label>
        <div className="question-panel__controls">
          <input
            id="tts-text"
            value={ttsText}
            onChange={(event) => setTtsText(event.target.value)}
            placeholder="Type text to speak..."
            disabled={isTtsLoading}
          />
          <button type="submit" disabled={isTtsLoading || !ttsText.trim()}>
            Speak
          </button>
        </div>
      </form>
    </div>
  )
}

export default VoiceSection
