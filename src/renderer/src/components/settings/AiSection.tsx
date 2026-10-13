import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import Toggle from './Toggle'

interface AiSectionProps {
  onError: (message: string | null) => void
}

const EMPTY_SETTINGS: AISettings = {
  generalBaseUrl: '',
  generalApiKey: '',
  generalModelId: '',
  generalUseLocal: false,
  phoneticBaseUrl: '',
  phoneticApiKey: '',
  phoneticModelId: '',
  phoneticUseLocal: false
}

function areSettingsEqual(a: AISettings, b: AISettings): boolean {
  return (
    a.generalBaseUrl === b.generalBaseUrl &&
    a.generalApiKey === b.generalApiKey &&
    a.generalModelId === b.generalModelId &&
    a.generalUseLocal === b.generalUseLocal &&
    a.phoneticBaseUrl === b.phoneticBaseUrl &&
    a.phoneticApiKey === b.phoneticApiKey &&
    a.phoneticModelId === b.phoneticModelId &&
    a.phoneticUseLocal === b.phoneticUseLocal
  )
}

function AiSection({ onError }: AiSectionProps): React.JSX.Element {
  const [aiSettings, setAiSettings] = useState<AISettings>(EMPTY_SETTINGS)
  const [savedSnapshot, setSavedSnapshot] = useState<AISettings | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    let disposed = false
    void window.api.settings
      .getAI()
      .then((settings) => {
        if (disposed) return
        setAiSettings(settings)
        setSavedSnapshot(settings)
        setIsLoaded(true)
      })
      .catch((requestError: unknown) => {
        onError(requestError instanceof Error ? requestError.message : 'Could not load AI settings')
      })
    return () => {
      disposed = true
    }
  }, [onError])

  const isDirty = isLoaded && savedSnapshot !== null && !areSettingsEqual(aiSettings, savedSnapshot)
  const canSave = isDirty && !isSavingSettings

  const updateSettings = (partial: Partial<AISettings>): void => {
    setJustSaved(false)
    setAiSettings((current) => ({ ...current, ...partial }))
  }

  const handleSettingsSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSave) return
    setIsSavingSettings(true)
    onError(null)
    try {
      const saved = await window.api.settings.saveAI(aiSettings)
      setAiSettings(saved)
      setSavedSnapshot(saved)
      setJustSaved(true)
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : 'Could not save AI settings')
    } finally {
      setIsSavingSettings(false)
    }
  }

  const saveStatus = isSavingSettings
    ? 'Saving…'
    : isDirty
      ? 'Unsaved changes'
      : justSaved
        ? 'Saved'
        : ''

  return (
    <form className="question-panel" onSubmit={handleSettingsSubmit}>
      <div className="settings-group">
        <div className="settings-group__head">
          <span className="settings-heading">General responses</span>
          <Toggle
            checked={aiSettings.generalUseLocal}
            onChange={(checked) => updateSettings({ generalUseLocal: checked })}
            label="Local model"
            disabled={isSavingSettings}
          />
        </div>
        <input
          value={aiSettings.generalBaseUrl}
          onChange={(event) => updateSettings({ generalBaseUrl: event.target.value })}
          placeholder="General base URL"
          disabled={isSavingSettings || aiSettings.generalUseLocal}
        />
        <input
          type="password"
          value={aiSettings.generalApiKey}
          onChange={(event) => updateSettings({ generalApiKey: event.target.value })}
          placeholder="General API key"
          disabled={isSavingSettings || aiSettings.generalUseLocal}
        />
        <input
          value={aiSettings.generalModelId}
          onChange={(event) => updateSettings({ generalModelId: event.target.value })}
          placeholder="General model ID"
          disabled={isSavingSettings || aiSettings.generalUseLocal}
        />
      </div>
      <div className="settings-group">
        <div className="settings-group__head">
          <span className="settings-heading">Phonetic formatting</span>
          <Toggle
            checked={aiSettings.phoneticUseLocal}
            onChange={(checked) => updateSettings({ phoneticUseLocal: checked })}
            label="Local model"
            disabled={isSavingSettings}
          />
        </div>
        <input
          value={aiSettings.phoneticBaseUrl}
          onChange={(event) => updateSettings({ phoneticBaseUrl: event.target.value })}
          placeholder="Phonetic base URL"
          disabled={isSavingSettings || aiSettings.phoneticUseLocal}
        />
        <input
          type="password"
          value={aiSettings.phoneticApiKey}
          onChange={(event) => updateSettings({ phoneticApiKey: event.target.value })}
          placeholder="Phonetic API key"
          disabled={isSavingSettings || aiSettings.phoneticUseLocal}
        />
        <input
          value={aiSettings.phoneticModelId}
          onChange={(event) => updateSettings({ phoneticModelId: event.target.value })}
          placeholder="Phonetic model ID"
          disabled={isSavingSettings || aiSettings.phoneticUseLocal}
        />
      </div>
      <div className="question-panel__controls">
        <button type="submit" disabled={!canSave}>
          Save
        </button>
        {saveStatus && (
          <span
            className={`settings-hint${
              justSaved && !isDirty && !isSavingSettings ? ' settings-hint--saved' : ''
            }`}
            aria-live="polite"
          >
            {saveStatus}
          </span>
        )}
      </div>
    </form>
  )
}

export default AiSection
