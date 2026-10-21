import { HubNode } from './hub/hub-node'
import { logger } from './core/logger'

/**
 * Gebündelter Einstiegspunkt für den Koordinations-Hub.
 *
 * Wird über `electron-vite build` als `out/main/hub.js` erzeugt und kann
 * mit `node out/main/hub.js` gestartet werden.
 */
async function main(): Promise<void> {
  logger.init()
  const port = Number(process.env['MMH_HUB_PORT'] ?? 4001)
  const token = process.env['MMH_HUB_TOKEN'] ?? null
  const dataFile = process.env['MMH_HUB_DATA'] ?? './hub-state.json'
  const listen = process.env['MMH_HUB_LISTEN'] ?? `/ip4/0.0.0.0/tcp/${port}`

  const hub = new HubNode({ listen: [listen], token, dataFile })
  await hub.start()

  console.log(`Multi-Mine Host Hub läuft`)
  console.log(`  Peer-ID : ${hub.peerId}`)
  console.log(`  Adressen: ${hub.addresses.join(', ')}`)
  console.log(`  Token   : ${token ? 'gesetzt' : 'nicht gesetzt'}`)
}

main().catch((err) => {
  console.error('Hub konnte nicht gestartet werden:', err)
  process.exit(1)
})
