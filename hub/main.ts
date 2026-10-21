import { HubNode } from '../src/main/hub/hub-node'
import { logger } from '../src/main/core/logger'

/**
 * Standalone-Koordinations-Hub.
 *
 * Der Hub kann auf einem dauerhaft verfuegbaren Rechner (z.B. Raspberry Pi,
 * kleiner Heimserver oder VPS) laufen. Er ist die einzige Instanz, die
 * Host-Leases und Epochen verwaltet - deshalb muss er erreichbar sein,
 * damit ein Host-Wechsel ueberhaupt stattfinden kann.
 *
 * Aufruf:
 *   MMH_HUB_PORT=4001 MMH_HUB_TOKEN=geheim npm run hub
 */
async function main(): Promise<void> {
  logger.init()

  const port = Number(process.env['MMH_HUB_PORT'] ?? 4001)
  const token = process.env['MMH_HUB_TOKEN'] ?? null
  const dataFile = process.env['MMH_HUB_DATA'] ?? './hub-state.json'
  const listen = process.env['MMH_HUB_LISTEN'] ?? `/ip4/0.0.0.0/tcp/${port}`

  const hub = new HubNode({
    listen: [listen],
    token,
    dataFile
  })

  await hub.start()

  console.log('--------------------------------------------------------------')
  console.log(' Multi-Mine Host - Koordinations-Hub')
  console.log('--------------------------------------------------------------')
  console.log(` Peer-ID : ${hub.peerId}`)
  console.log(` Adressen: ${hub.addresses.join('\n           ')}`)
  console.log(` Token   : ${token ? 'gesetzt' : 'NICHT gesetzt (jeder kann Gruppen eroeffnen)'}`)
  console.log(` Daten   : ${dataFile}`)
  console.log('--------------------------------------------------------------')
  console.log(' Beenden mit Strg+C')
  console.log('--------------------------------------------------------------')

  const shutdown = async (): Promise<void> => {
    console.log('\nHub wird beendet...')
    await hub.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((err) => {
  console.error('Hub konnte nicht gestartet werden:', err)
  process.exit(1)
})
