import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import Toggle from './Toggle'
import './PromptsSection.css'

interface PromptsSectionProps {
  onError: (message: string | null) => void
  onPromptsChange: (prompts: CustomPrompt[]) => void
}

type LabelDraftMode = 'none' | LabelMode

interface Draft {
  id: string | null
  name: string
  trigger: string
  prefill: string
  systemPrompt: string
  schemaText: string
  useScreen: boolean
  speechMode: SpeechMode
  speechValue: string
  copy: string
  labelMode: LabelDraftMode
  labelValue: string
}

const DEFAULT_SCHEMA = `{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "text": {
      "type": "string",
      "description": "A concise spoken answer."
    }
  },
  "required": ["text"]
}`

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// Top-level property names of the draft schema, used to populate the mapping
// suggestions. Returns [] until the schema is valid JSON.
function parsePropertyNames(schemaText: string): string[] {
  try {
    const parsed = JSON.parse(schemaText) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
    const properties = (parsed as Record<string, unknown>).properties
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      return []
    }
    return Object.keys(properties as Record<string, unknown>)
  } catch {
    return []
  }
}

function emptyDraft(): Draft {
  return {
    id: null,
    name: '',
    trigger: '',
    prefill: '',
    systemPrompt: '',
    schemaText: DEFAULT_SCHEMA,
    useScreen: true,
    speechMode: 'field',
    speechValue: '',
    copy: '',
    labelMode: 'none',
    labelValue: ''
  }
}

function toDraft(prompt: CustomPrompt): Draft {
  return {
    id: prompt.id,
    name: prompt.name,
    trigger: prompt.trigger ?? '',
    prefill: prompt.prefill ?? '',
    systemPrompt: prompt.systemPrompt,
    schemaText: JSON.stringify(prompt.schema, null, 2),
    useScreen: prompt.useScreen,
    speechMode: prompt.fields.speech.mode,
    speechValue: prompt.fields.speech.value,
    copy: prompt.fields.copy ?? '',
    labelMode: prompt.fields.label?.mode ?? 'none',
    labelValue: prompt.fields.label?.value ?? ''
  }
}

function PromptsSection({ onError, onPromptsChange }: PromptsSectionProps): React.JSX.Element {
  const [prompts, setPrompts] = useState<CustomPrompt[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    let disposed = false
    void window.api.prompts
      .list()
      .then((list) => {
        if (disposed) return
        setPrompts(list)
        onPromptsChange(list)
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : 'Could not load custom prompts')
      })
    return () => {
      disposed = true
    }
  }, [onError, onPromptsChange])

  const updateDraft = (partial: Partial<Draft>): void => {
    setDraft((current) => (current ? { ...current, ...partial } : current))
  }

  const handleSave = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!draft || isSaving) return
    onError(null)

    if (!isValidJson(draft.schemaText)) {
      onError('Schema must be valid JSON')
      return
    }

    const payload: CustomPrompt = {
      id: draft.id ?? '',
      name: draft.name.trim(),
      systemPrompt: draft.systemPrompt,
      schema: JSON.parse(draft.schemaText) as Record<string, unknown>,
      useScreen: draft.useScreen,
      fields: {
        speech: { mode: draft.speechMode, value: draft.speechValue.trim() },
        ...(draft.copy.trim() ? { copy: draft.copy.trim() } : {}),
        ...(draft.labelMode !== 'none' && draft.labelValue.trim()
          ? { label: { mode: draft.labelMode, value: draft.labelValue.trim() } }
          : {})
      },
      ...(draft.trigger.trim() ? { trigger: draft.trigger.trim() } : {}),
      ...(draft.prefill.trim() ? { prefill: draft.prefill.trim() } : {})
    }

    setIsSaving(true)
    try {
      const list = await window.api.prompts.save(payload)
      setPrompts(list)
      onPromptsChange(list)
      const saved =
        (draft.id ? list.find((prompt) => prompt.id === draft.id) : undefined) ??
        list[list.length - 1]
      setDraft(saved ? toDraft(saved) : null)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not save the custom prompt')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!draft?.id || isSaving) return
    onError(null)
    setIsSaving(true)
    try {
      const list = await window.api.prompts.remove(draft.id)
      setPrompts(list)
      onPromptsChange(list)
      setDraft(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not delete the custom prompt')
    } finally {
      setIsSaving(false)
    }
  }

  if (draft === null) {
    return (
      <div className="question-panel">
        <div className="settings-group">
          <div className="settings-group__head">
            <span className="settings-heading">Custom prompts</span>
            <button type="button" onClick={() => setDraft(emptyDraft())}>
              New prompt
            </button>
          </div>
          {prompts.length === 0 ? (
            <p className="settings-hint">
              Create a prompt to replace the built-in instructions and output for a specific task,
              like translating a selected area.
            </p>
          ) : (
            <ul className="prompt-list">
              {prompts.map((prompt) => (
                <li key={prompt.id}>
                  <button
                    type="button"
                    className="prompt-list__item"
                    onClick={() => setDraft(toDraft(prompt))}
                  >
                    <span className="prompt-list__name">{prompt.name}</span>
                    <span className="prompt-list__meta">
                      {prompt.useScreen ? 'Screen' : 'General'}
                      {prompt.trigger ? ` · /${prompt.trigger}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )
  }

  const propertyNames = parsePropertyNames(draft.schemaText)
  const schemaError = isValidJson(draft.schemaText) ? null : 'Schema is not valid JSON'
  const listId = 'prompt-field-options'

  return (
    <form className="question-panel" onSubmit={handleSave}>
      <datalist id={listId}>
        {propertyNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="settings-group">
        <span className="settings-heading">Basics</span>
        <input
          value={draft.name}
          onChange={(event) => updateDraft({ name: event.target.value })}
          placeholder="Prompt name (e.g. Translator)"
          disabled={isSaving}
        />
        <div className="prompt-row">
          <input
            value={draft.trigger}
            onChange={(event) => updateDraft({ trigger: event.target.value })}
            placeholder="Trigger prefix (optional, e.g. translate)"
            disabled={isSaving}
          />
          <input
            value={draft.prefill}
            onChange={(event) => updateDraft({ prefill: event.target.value })}
            placeholder="Prefilled question (optional)"
            disabled={isSaving}
          />
        </div>
        <Toggle
          checked={draft.useScreen}
          onChange={(checked) => updateDraft({ useScreen: checked })}
          label="Send the screen (vision model)"
          disabled={isSaving}
        />
        <p className="settings-hint">
          Turn off to answer from the general model without a screenshot.
        </p>
      </div>

      <div className="settings-group">
        <span className="settings-heading">System prompt</span>
        <textarea
          className="prompt-textarea"
          value={draft.systemPrompt}
          onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
          placeholder="Write the instructions the model must follow…"
          rows={5}
          disabled={isSaving}
        />
      </div>

      <div className="settings-group">
        <span className="settings-heading">JSON schema</span>
        <textarea
          className="prompt-textarea prompt-textarea--code"
          value={draft.schemaText}
          onChange={(event) => updateDraft({ schemaText: event.target.value })}
          rows={10}
          spellCheck={false}
          disabled={isSaving}
        />
        <p className={`settings-hint${schemaError ? ' prompt-hint--error' : ''}`}>
          {schemaError ??
            'Include "additionalProperties": false and list every property in "required". Field names below come from this schema.'}
        </p>
      </div>

      <div className="settings-group">
        <span className="settings-heading">Spoken answer</span>
        <div className="prompt-radios">
          {(['field', 'fixed', 'template'] as SpeechMode[]).map((mode) => (
            <label key={mode} className="prompt-radio">
              <input
                type="radio"
                name="speech-mode"
                checked={draft.speechMode === mode}
                onChange={() => updateDraft({ speechMode: mode })}
                disabled={isSaving}
              />
              <span>
                {mode === 'field'
                  ? 'Field'
                  : mode === 'fixed'
                    ? 'Fixed text'
                    : 'Template'}
              </span>
            </label>
          ))}
        </div>
        <input
          list={draft.speechMode === 'field' ? listId : undefined}
          value={draft.speechValue}
          onChange={(event) => updateDraft({ speechValue: event.target.value })}
          placeholder={
            draft.speechMode === 'field'
              ? 'Schema field to speak'
              : draft.speechMode === 'fixed'
                ? 'Sentence to always speak'
                : 'Spoken template, e.g. Translated from {language}'
          }
          disabled={isSaving}
        />
      </div>

      <div className="settings-group">
        <span className="settings-heading">Copy value</span>
        <input
          list={listId}
          value={draft.copy}
          onChange={(event) => updateDraft({ copy: event.target.value })}
          placeholder="Schema field whose value can be copied (optional)"
          disabled={isSaving}
        />
      </div>

      <div className="settings-group">
        <span className="settings-heading">Indicator label</span>
        <select
          className="prompt-select"
          value={draft.labelMode}
          onChange={(event) => updateDraft({ labelMode: event.target.value as LabelDraftMode })}
          disabled={isSaving}
        >
          <option value="none">None</option>
          <option value="fixed">Fixed text</option>
          <option value="template">Template</option>
        </select>
        {draft.labelMode !== 'none' && (
          <input
            list={draft.labelMode === 'template' ? listId : undefined}
            value={draft.labelValue}
            onChange={(event) => updateDraft({ labelValue: event.target.value })}
            placeholder={
              draft.labelMode === 'fixed' ? 'Label text' : 'Label template, e.g. {language}'
            }
            disabled={isSaving}
          />
        )}
      </div>

      <div className="question-panel__controls">
        <button type="submit" disabled={isSaving || !draft.name.trim()}>
          Save
        </button>
        <button
          type="button"
          className="settings-button--danger"
          onClick={handleDelete}
          disabled={isSaving || !draft.id}
        >
          Delete
        </button>
        <button type="button" onClick={() => setDraft(null)} disabled={isSaving}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export default PromptsSection
