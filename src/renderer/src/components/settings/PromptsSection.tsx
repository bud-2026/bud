import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildScreenSystemPromptPreview } from '../../lib/promptPreview'

interface PromptsSectionProps {
  onError: (message: string | null) => void
}

// Draft mirrors a preset being edited. `id` is empty for an unsaved new preset,
// and `builtin` marks the read-only default shipped with the app.
interface Draft extends PromptPresetFields {
  id: string
  name: string
  description: string
  builtin: boolean
}

function toDraft(preset: PromptPreset): Draft {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    builtin: preset.builtin,
    intro: preset.intro,
    textRules: preset.textRules,
    boxesRules: preset.boxesRules,
    closingRules: preset.closingRules,
    textDescription: preset.textDescription,
    boxesDescription: preset.boxesDescription,
    labelDescription: preset.labelDescription,
    copyDescription: preset.copyDescription,
    bboxDescription: preset.bboxDescription,
    examples: preset.examples.map((example) => ({ ...example }))
  }
}

function toInput(draft: Draft): PromptPresetInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name,
    description: draft.description,
    intro: draft.intro,
    textRules: draft.textRules,
    boxesRules: draft.boxesRules,
    closingRules: draft.closingRules,
    textDescription: draft.textDescription,
    boxesDescription: draft.boxesDescription,
    labelDescription: draft.labelDescription,
    copyDescription: draft.copyDescription,
    bboxDescription: draft.bboxDescription,
    examples: draft.examples
  }
}

function isDraftDirty(draft: Draft, saved: Draft | null): boolean {
  if (!saved) return true // an unsaved new preset always needs saving
  return JSON.stringify(draft) !== JSON.stringify(saved)
}

function PromptsSection({ onError }: PromptsSectionProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<PromptStoreSnapshot | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const applySnapshot = useCallback((next: PromptStoreSnapshot, selectId?: string): void => {
    setSnapshot(next)
    const targetId = selectId ?? next.activePresetId
    const preset = next.presets.find((candidate) => candidate.id === targetId) ?? next.presets[0]
    setDraft(preset ? toDraft(preset) : null)
    setSavedDraft(preset ? toDraft(preset) : null)
    setConfirmDelete(false)
  }, [])

  useEffect(() => {
    let disposed = false
    void window.api.prompts
      .get()
      .then((next) => {
        if (!disposed) applySnapshot(next)
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : 'Could not load prompt presets')
      })
    return () => {
      disposed = true
    }
  }, [applySnapshot, onError])

  const selectPreset = (id: string): void => {
    if (!snapshot) return
    const preset = snapshot.presets.find((candidate) => candidate.id === id)
    if (!preset) return
    const next = toDraft(preset)
    setDraft(next)
    setSavedDraft(next)
    setJustSaved(false)
    setConfirmDelete(false)
  }

  const updateField = (partial: Partial<Draft>): void => {
    setJustSaved(false)
    setDraft((current) => (current ? { ...current, ...partial } : current))
  }

  const updateExample = (index: number, partial: Partial<PromptExample>): void => {
    setJustSaved(false)
    setDraft((current) => {
      if (!current) return current
      const examples = current.examples.map((example, position) =>
        position === index ? { ...example, ...partial } : example
      )
      return { ...current, examples }
    })
  }

  const addExample = (): void => {
    setJustSaved(false)
    setDraft((current) =>
      current ? { ...current, examples: [...current.examples, { name: '', body: '' }] } : current
    )
  }

  const removeExample = (index: number): void => {
    setJustSaved(false)
    setDraft((current) =>
      current
        ? { ...current, examples: current.examples.filter((_, position) => position !== index) }
        : current
    )
  }

  const isBuiltin = draft?.builtin ?? false
  const isDirty = draft ? isDraftDirty(draft, savedDraft) : false
  const canSave = Boolean(draft) && !isBuiltin && isDirty && !isSaving
  const disabled = isSaving || isBuiltin

  // Saves the current draft and returns the id it was stored under (null on
  // failure) so callers such as "Set as active" can chain off it.
  const persist = async (): Promise<string | null> => {
    if (!draft) return null
    if (draft.name.trim().length === 0) {
      onError('Give the preset a name before saving')
      return null
    }
    setIsSaving(true)
    onError(null)
    try {
      const result = await window.api.prompts.save(toInput(draft))
      applySnapshot(result, result.savedPresetId)
      setJustSaved(true)
      return result.savedPresetId
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not save the prompt preset')
      return null
    } finally {
      setIsSaving(false)
    }
  }

  const handleSetActive = async (): Promise<void> => {
    if (!draft) return
    let id = draft.id
    if (!isBuiltin && (!id || isDirty)) {
      const savedId = await persist()
      if (!savedId) return
      id = savedId
    }
    try {
      const result = await window.api.prompts.setActive(id)
      applySnapshot(result, id)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not activate the prompt preset')
    }
  }

  const handleNew = (): void => {
    if (!snapshot || snapshot.presets.length === 0) return
    // Seed a fresh preset from the built-in default so it starts from a known
    // good template.
    const next: Draft = {
      ...toDraft(snapshot.presets[0]),
      id: '',
      name: 'New preset',
      description: '',
      builtin: false
    }
    setDraft(next)
    setSavedDraft(null)
    setJustSaved(false)
    setConfirmDelete(false)
  }

  const handleDuplicate = (): void => {
    if (!draft) return
    setDraft({ ...draft, id: '', name: `${draft.name} copy`, builtin: false })
    setSavedDraft(null)
    setJustSaved(false)
    setConfirmDelete(false)
  }

  const handleDelete = async (): Promise<void> => {
    if (!draft || draft.builtin || !draft.id) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setIsSaving(true)
    onError(null)
    try {
      const result = await window.api.prompts.delete(draft.id)
      applySnapshot(result)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not delete the prompt preset')
    } finally {
      setIsSaving(false)
    }
  }

  const preview = useMemo(() => (draft ? buildScreenSystemPromptPreview(draft) : ''), [draft])

  if (!snapshot || !draft) {
    return (
      <div className="question-panel">
        <p className="settings-hint">Loading prompt presets…</p>
      </div>
    )
  }

  const isActive = draft.id !== '' && draft.id === snapshot.activePresetId
  const saveStatus = isSaving ? 'Saving…' : isDirty ? 'Unsaved changes' : justSaved ? 'Saved' : ''

  return (
    <div className="question-panel">
      <div className="settings-group">
        <div className="settings-group__head">
          <span className="settings-heading">Presets</span>
          <button
            type="button"
            className="settings-button--ghost"
            onClick={handleNew}
            disabled={isSaving}
          >
            New preset
          </button>
        </div>
        <ul className="prompt-list">
          {snapshot.presets.map((preset) => {
            const selected = preset.id === draft.id
            const active = preset.id === snapshot.activePresetId
            return (
              <li key={preset.id}>
                <button
                  type="button"
                  className={`prompt-option${selected ? ' prompt-option--selected' : ''}`}
                  onClick={() => selectPreset(preset.id)}
                  aria-pressed={selected}
                >
                  <span className="prompt-option__body">
                    <span className="prompt-option__name">
                      {preset.name}
                      {preset.builtin ? <span className="prompt-option__tag">Built-in</span> : null}
                    </span>
                    {preset.description ? (
                      <span className="prompt-option__desc">{preset.description}</span>
                    ) : null}
                  </span>
                  {active ? <span className="prompt-option__badge">Active</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="settings-group">
        <span className="settings-heading">Preset details</span>
        {isBuiltin ? (
          <p className="settings-hint">
            This is the built-in preset. Duplicate it to make changes; your copy is fully editable.
          </p>
        ) : null}
        <label className="prompt-field">
          <span className="prompt-field__label">Name</span>
          <input
            value={draft.name}
            onChange={(event) => updateField({ name: event.target.value })}
            placeholder="Preset name"
            disabled={disabled}
          />
        </label>
        <label className="prompt-field">
          <span className="prompt-field__label">Description</span>
          <input
            value={draft.description}
            onChange={(event) => updateField({ description: event.target.value })}
            placeholder="What this preset is tuned for"
            disabled={disabled}
          />
        </label>
      </div>

      <div className="settings-group">
        <span className="settings-heading">Persona &amp; voice (text field)</span>
        <p className="settings-hint">
          Shapes the spoken answer returned in the JSON &quot;text&quot; value.
        </p>
        <label className="prompt-field">
          <span className="prompt-field__label">Intro line</span>
          <textarea
            rows={2}
            value={draft.intro}
            onChange={(event) => updateField({ intro: event.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="prompt-field">
          <span className="prompt-field__label">Voice &amp; personality rules</span>
          <textarea
            rows={6}
            value={draft.textRules}
            onChange={(event) => updateField({ textRules: event.target.value })}
            disabled={disabled}
          />
        </label>
      </div>

      <div className="settings-group">
        <span className="settings-heading">Visual grounding (boxes field)</span>
        <p className="settings-hint">Controls how Bud highlights elements and extracts text.</p>
        <label className="prompt-field">
          <span className="prompt-field__label">Grounding rules</span>
          <textarea
            rows={7}
            value={draft.boxesRules}
            onChange={(event) => updateField({ boxesRules: event.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="prompt-field">
          <span className="prompt-field__label">Closing rule</span>
          <textarea
            rows={3}
            value={draft.closingRules}
            onChange={(event) => updateField({ closingRules: event.target.value })}
            disabled={disabled}
          />
        </label>
      </div>

      <div className="settings-group">
        <span className="settings-heading">Response schema</span>
        <p className="settings-hint">
          Descriptions for the JSON fields the model returns. The response shape stays fixed so
          answers keep working.
        </p>
        <label className="prompt-field">
          <span className="prompt-field__label">text property description</span>
          <input
            value={draft.textDescription}
            onChange={(event) => updateField({ textDescription: event.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="prompt-field">
          <span className="prompt-field__label">boxes property description</span>
          <input
            value={draft.boxesDescription}
            onChange={(event) => updateField({ boxesDescription: event.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="prompt-field">
          <span className="prompt-field__label">box label description</span>
          <input
            value={draft.labelDescription}
            onChange={(event) => updateField({ labelDescription: event.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="prompt-field">
          <span className="prompt-field__label">box copy description</span>
          <input
            value={draft.copyDescription}
            onChange={(event) => updateField({ copyDescription: event.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="prompt-field">
          <span className="prompt-field__label">box bbox description</span>
          <input
            value={draft.bboxDescription}
            onChange={(event) => updateField({ bboxDescription: event.target.value })}
            disabled={disabled}
          />
        </label>
      </div>

      <div className="settings-group">
        <div className="settings-group__head">
          <span className="settings-heading">Examples</span>
          <button
            type="button"
            className="settings-button--ghost"
            onClick={addExample}
            disabled={disabled}
          >
            Add example
          </button>
        </div>
        {draft.examples.length === 0 ? (
          <p className="settings-hint">
            No examples yet. Examples strongly steer the response format.
          </p>
        ) : null}
        {draft.examples.map((example, index) => (
          <div className="prompt-example" key={index}>
            <div className="prompt-example__head">
              <input
                value={example.name}
                onChange={(event) => updateExample(index, { name: event.target.value })}
                placeholder="Example name"
                disabled={disabled}
              />
              <button
                type="button"
                className="settings-button--ghost"
                onClick={() => removeExample(index)}
                disabled={disabled}
              >
                Remove
              </button>
            </div>
            <textarea
              rows={6}
              value={example.body}
              onChange={(event) => updateExample(index, { body: event.target.value })}
              placeholder='{ "boxes": [], "text": "..." }'
              disabled={disabled}
            />
          </div>
        ))}
      </div>

      <div className="settings-group">
        <span className="settings-heading">Preview</span>
        <p className="settings-hint">Exactly what is sent to the vision model.</p>
        <pre className="prompt-preview">{preview}</pre>
      </div>

      <div className="question-panel__controls">
        {isBuiltin ? (
          <button type="button" onClick={handleDuplicate} disabled={isSaving}>
            Duplicate to edit
          </button>
        ) : (
          <button type="button" onClick={() => void persist()} disabled={!canSave}>
            Save
          </button>
        )}
        <button
          type="button"
          className="settings-button--ghost"
          onClick={() => void handleSetActive()}
          disabled={isSaving || (isActive && !isDirty)}
        >
          {isActive && !isDirty ? 'Active' : 'Set as active'}
        </button>
        {!isBuiltin ? (
          <button
            type="button"
            className="settings-button--danger"
            onClick={() => void handleDelete()}
            disabled={isSaving || !draft.id}
          >
            {confirmDelete ? 'Confirm delete' : 'Delete'}
          </button>
        ) : null}
        {saveStatus ? (
          <span
            className={`settings-hint${
              justSaved && !isDirty && !isSaving ? ' settings-hint--saved' : ''
            }`}
            aria-live="polite"
          >
            {saveStatus}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default PromptsSection
