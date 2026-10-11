import { useState } from 'react'
import './Indicator.css'

export interface IndicatorProps {
  /** [xmin, ymin, xmax, ymax] on the 1000x1000 viewport grid. */
  bbox: [number, number, number, number]
  label?: string
  /** Raw text extracted from the bounding box to copy to clipboard. */
  copy?: string
  /** Extra padding around the box, in 1000x1000 grid units. */
  padding?: number
}

function Indicator({
  bbox,
  label = 'Object',
  copy,
  padding = 0
}: IndicatorProps): React.JSX.Element {
  const [xmin, ymin, xmax, ymax] = bbox
  const [copied, setCopied] = useState(false)

  const left = Math.min(1000, Math.max(0, xmin - padding)) / 10
  const top = Math.min(1000, Math.max(0, ymin - padding)) / 10
  const right = Math.min(1000, Math.max(xmin, xmax + padding)) / 10
  const bottom = Math.min(1000, Math.max(ymin, ymax + padding)) / 10

  const handleCopy = async (e: React.MouseEvent): Promise<void> => {
    if (!copy) return
    e.stopPropagation()

    try {
      await navigator.clipboard.writeText(copy)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy text: ', err)
    }
  }

  return (
    <div
      className={`indicator ${copy ? 'indicator--copyable' : ''}`}
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${right - left}%`,
        height: `${bottom - top}%`
      }}
      aria-label={`${label} detected`}
      title={label}
    >
      <span className="indicator__pulse" />
      <span className="indicator__label">
        {label}
        {copy && (
          <button
            type="button"
            className="indicator__copy-btn"
            onClick={handleCopy}
            aria-label="Copy text"
            title={`Copy "${copy}"`}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </span>
    </div>
  )
}

export default Indicator
