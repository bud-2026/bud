interface ApplicationSectionProps {
  onQuit: () => void
}

function ApplicationSection({ onQuit }: ApplicationSectionProps): React.JSX.Element {
  return (
    <div className="question-panel">
      <div className="question-panel__controls">
        <button
          type="button"
          className="settings-button--danger"
          onClick={onQuit}
          title="Close Bud"
        >
          Quit Bud
        </button>
      </div>
    </div>
  )
}

export default ApplicationSection
