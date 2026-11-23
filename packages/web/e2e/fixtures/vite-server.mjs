// The child owns the listener. Report its actual port after Vite starts.
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } })
await server.listen()
const { port } = server.httpServer.address()
console.log(`fixture → http://127.0.0.1:${port}`)
