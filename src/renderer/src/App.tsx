import { FormEvent, useEffect, useState } from 'react'
import Indicator from './components/Indicator'
import { askScreen } from './lib/ai'

function App(): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<ScreenAIResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isOverlayFocused, setIsOverlayFocused] = useState(true)

  useEffect(() => window.api.overlay.onFocusChanged(setIsOverlayFocused), [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const prompt = question.trim()

    if (!prompt || isLoading) return

    setIsLoading(true)
    setError(null)
    try {
      setResult(await askScreen(prompt))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Screen analysis failed')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className="overlay" aria-label="Screen overlay">
      <form className="question-panel" onSubmit={handleSubmit}>
        <label htmlFor="screen-question">
          Ask about your screen
          <span className="question-panel__shortcut">
            Ctrl+Shift+Space to {isOverlayFocused ? 'unfocus' : 'focus'}
          </span>
        </label>
        <div className="question-panel__controls">
          <input
            id="screen-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What is on my screen?"
            disabled={isLoading}
          />
          <button type="submit" disabled={isLoading || !question.trim()}>
            {isLoading ? 'Analyzing...' : 'Ask'}
          </button>
        </div>
        {result && <p className="question-panel__response">{result.text}</p>}
        {error && <p className="question-panel__error">{error}</p>}
      </form>
      <Indicator
          key={`122`}
          topLeft={{x: 576, y: 378}}
          bottomRight={{x: 892, y: 531}}
          label="Test"
      />
      {result?.boxes.map((box, index) => (
        <Indicator
          key={`${box.topLeft.x}-${box.topLeft.y}-${index}`}
          topLeft={box.topLeft}
          bottomRight={box.bottomRight}
          label={box.label}
        />
      ))}
    </main>
  )
}

export default App
