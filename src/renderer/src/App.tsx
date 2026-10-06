import Indicator from './components/Indicator'

function App(): React.JSX.Element {
  return (
    <main className="overlay" aria-label="Screen overlay">
      <div className="overlay-status">Overlay active</div>
      <Indicator topLeft={{ x: 640, y: 200 }} bottomRight={{ x: 860, y: 500 }} />
    </main>
  )
}

export default App
