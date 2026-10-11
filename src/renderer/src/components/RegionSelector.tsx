import { useEffect, useRef, useState } from 'react'
import './RegionSelector.css'

interface RegionSelectorProps {
  /** Called with the normalized 0-1000 region once a valid drag completes. */
  onComplete: (region: Region) => void
  /** Called when the user presses Escape to abort the selection. */
  onCancel: () => void
}

interface Point {
  x: number
  y: number
}

interface DragRect {
  left: number
  top: number
  width: number
  height: number
}

/** Smallest drag, in CSS pixels, treated as an intentional selection. */
const MIN_SELECTION_PX = 8

function RegionSelector({ onComplete, onCancel }: RegionSelectorProps): React.JSX.Element {
  const [start, setStart] = useState<Point | null>(null)
  const [current, setCurrent] = useState<Point | null>(null)
  const dragStartRef = useRef<Point | null>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const toPoint = (event: React.MouseEvent): Point => ({ x: event.clientX, y: event.clientY })

  const handleMouseDown = (event: React.MouseEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const point = toPoint(event)
    dragStartRef.current = point
    setStart(point)
    setCurrent(point)
  }

  const handleMouseMove = (event: React.MouseEvent): void => {
    if (!dragStartRef.current) return
    setCurrent(toPoint(event))
  }

  const handleMouseUp = (event: React.MouseEvent): void => {
    const origin = dragStartRef.current
    dragStartRef.current = null
    setStart(null)
    setCurrent(null)

    if (!origin) return

    const end = toPoint(event)
    const width = Math.abs(end.x - origin.x)
    const height = Math.abs(end.y - origin.y)
    if (width < MIN_SELECTION_PX || height < MIN_SELECTION_PX) return

    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const x = Math.max(
      0,
      Math.min(1000, Math.round((Math.min(origin.x, end.x) / viewportWidth) * 1000))
    )
    const y = Math.max(
      0,
      Math.min(1000, Math.round((Math.min(origin.y, end.y) / viewportHeight) * 1000))
    )
    const normalizedWidth = Math.max(
      1,
      Math.min(1000 - x, Math.round((width / viewportWidth) * 1000))
    )
    const normalizedHeight = Math.max(
      1,
      Math.min(1000 - y, Math.round((height / viewportHeight) * 1000))
    )

    onComplete({ x, y, width: normalizedWidth, height: normalizedHeight })
  }

  const dragRect: DragRect | null =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y)
        }
      : null

  return (
    <div
      className="region-selector"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <p className="region-selector__hint">Drag to select an area · Esc to cancel</p>
      {dragRect && <div className="region-selector__rect" style={dragRect} />}
    </div>
  )
}

export default RegionSelector
