import { createRequire } from 'node:module'

/**
 * CJS-`require` fuer ESM-Module.
 *
 * Wird nur an Stellen gebraucht, an denen ein CommonJS-Modul optional
 * geladen werden muss (z. B. die Electron-APIs, wenn die Anwendung auch
 * ausserhalb von Electron laufen soll).
 */
export const cjsRequire = createRequire(import.meta.url)
