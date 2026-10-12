import { createServer } from 'node:net'

/**
 * Asks the OS for an available TCP port on the loopback interface and returns
 * it. The probe socket is closed immediately, so the port is only reserved at
 * the moment of the call; there is a small race window before the caller binds
 * it. This keeps bundled backends from clashing with each other or other apps.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        server.close(() => reject(new Error('Could not determine a free port')))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}
