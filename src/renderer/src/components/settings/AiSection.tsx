import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

interface AiSectionProps {
  onError: (message: string | null) => void
}

function AiSection({ onError }: AiSectionProps): React.JSX.Element {
  const [aiSettings, setAiSettings] = useState<AISettings>({
    generalBaseUrl: '',
    generalApiKey: '',
    generalModelId: '',
    phoneticBaseUrl: '',
    phoneticApiKey: '',
    phoneticModelId: ''
  })
  const [isSavingSettings, setIsSavingSettings] = useState(false)

  useEffect(() => {
    let disposed = false
    void window.api.settings
      .getAI()
      .then((settings) => {
        if (!disposed) setAiSettings(settings)
      })
      .catch((requestError: unknown) => {
        onError(requestError instanceof Error ? requestError.message : 'Could not load AI settings')
      })
    return () => {
      disposed = true
    }
  }, [onError])

  const handleSettingsSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setIsSavingSettings(true)
    onError(null)
    try {
      setAiSettings(await window.api.settings.saveAI(aiSettings))
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : 'Could not save AI settings')
    } finally {
      setIsSavingSettings(false)
    }
  }

  return (
    <form className="question-panel" onSubmit={handleSettingsSubmit}>
      <div className="ai-settings__group">
        <strong>General responses</strong>
        <input
          value={aiSettings.generalBaseUrl}
          onChange={(event) => setAiSettings({ ...aiSettings, generalBaseUrl: event.target.value })}
          placeholder="General base URL"
          disabled={isSavingSettings}
        />
        <input
          type="password"
          value={aiSettings.generalApiKey}
          onChange={(event) => setAiSettings({ ...aiSettings, generalApiKey: event.target.value })}
          placeholder="General API key"
          disabled={isSavingSettings}
        />
        <input
          value={aiSettings.generalModelId}
          onChange={(event) => setAiSettings({ ...aiSettings, generalModelId: event.target.value })}
          placeholder="General model ID"
          disabled={isSavingSettings}
        />
      </div>
      <div className="ai-settings__group">
        <strong>Phonetic formatting</strong>
        <input
          value={aiSettings.phoneticBaseUrl}
          onChange={(event) =>
            setAiSettings({ ...aiSettings, phoneticBaseUrl: event.target.value })
          }
          placeholder="Phonetic base URL"
          disabled={isSavingSettings}
        />
        <input
          type="password"
          value={aiSettings.phoneticApiKey}
          onChange={(event) => setAiSettings({ ...aiSettings, phoneticApiKey: event.target.value })}
          placeholder="Phonetic API key"
          disabled={isSavingSettings}
        />
        <input
          value={aiSettings.phoneticModelId}
          onChange={(event) =>
            setAiSettings({ ...aiSettings, phoneticModelId: event.target.value })
          }
          placeholder="Phonetic model ID"
          disabled={isSavingSettings}
        />
      </div>
      <div className="question-panel__controls">
        <button type="submit" disabled={isSavingSettings}>
          Save
        </button>
      </div>
    </form>
  )
}

export default AiSection
