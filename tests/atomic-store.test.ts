import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AtomicStore, Journal } from '../src/main/core/atomic-store'

/**
 * Tests fuer die dauerhafte Zustandsspeicherung:
 * Neustart, unerwarteter Prozessabbruch, Teilzustände.
 */
describe('AtomicStore', () => {
  it('speichert und lädt Zustände', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-store-'))
    try {
      const file = join(dir, 'state.json')
      const store = new AtomicStore<{ value: number }>(file, () => ({ value: 0 }))
      expect(store.load().value).toBe(0)
      await store.save({ value: 42 })
      expect(store.load().value).toBe(42)

      // Neuer Store = Neustart der Anwendung
      const store2 = new AtomicStore<{ value: number }>(file, () => ({ value: 0 }))
      expect(store2.load().value).toBe(42)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('überlebt eine beschädigte Zustandsdatei (Absturz beim Schreiben)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-store-'))
    try {
      const file = join(dir, 'state.json')
      const store = new AtomicStore<{ value: number }>(file, () => ({ value: 0 }))
      await store.save({ value: 1 })
      await store.save({ value: 2 })

      // Die aktuelle Datei wird zerstört (Simulation eines Absturzes)
      writeFileSync(file, '{ "value": 2, abbruch')

      const store2 = new AtomicStore<{ value: number }>(file, () => ({ value: 0 }))
      // Es muss der letzte intakte Stand geladen werden
      expect(store2.load().value).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('legt eine Sicherungskopie der letzten Version an', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-store-'))
    try {
      const file = join(dir, 'state.json')
      const store = new AtomicStore<{ value: number }>(file, () => ({ value: 0 }))
      await store.save({ value: 1 })
      await store.save({ value: 2 })
      expect(existsSync(`${file}.bak`)).toBe(true)
      const backup = JSON.parse(readFileSync(`${file}.bak`, 'utf8')) as { value: number }
      expect(backup.value).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('schreibt atomar (temporäre Dateien werden aufgeräumt)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-store-'))
    try {
      const file = join(dir, 'state.json')
      const store = new AtomicStore<{ value: number }>(file, () => ({ value: 0 }))
      await store.save({ value: 7 })
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
      expect(leftovers).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serialisiert parallele Schreibvorgänge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-store-'))
    try {
      const file = join(dir, 'state.json')
      const store = new AtomicStore<{ n: number }>(file, () => ({ n: 0 }))
      await Promise.all([store.save({ n: 1 }), store.save({ n: 2 }), store.save({ n: 3 })])
      await store.flush()
      const content = JSON.parse(readFileSync(file, 'utf8')) as { n: number }
      expect([1, 2, 3]).toContain(content.n)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('verwendet den Fallback, wenn keine Datei existiert', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-store-'))
    try {
      const store = new AtomicStore<{ value: string }>(join(dir, 'nope.json'), () => ({
        value: 'default'
      }))
      expect(store.load().value).toBe('default')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Journal', () => {
  it('schreibt und liest Einträge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-journal-'))
    try {
      const journal = new Journal(join(dir, 'journal.log'))
      journal.append('test', { a: 1 })
      journal.append('test2', { b: 2 })
      const entries = journal.read()
      expect(entries.length).toBe(2)
      expect(entries[0]?.kind).toBe('test')
      expect(entries[1]?.data['b']).toBe(2)
      journal.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignoriert unvollständige letzte Zeilen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-journal-'))
    try {
      const file = join(dir, 'journal.log')
      const journal = new Journal(file)
      journal.append('vollstaendig', { x: 1 })
      journal.close()
      // Simuliert einen Absturz waehrend des Schreibens
      writeFileSync(file, readFileSync(file, 'utf8') + '{"kind":"abgebroch')
      const journal2 = new Journal(file)
      const entries = journal2.read()
      expect(entries.length).toBe(1)
      expect(entries[0]?.kind).toBe('vollstaendig')
      journal2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gibt bei fehlender Datei eine leere Liste zurück', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmh-journal-'))
    try {
      const journal = new Journal(join(dir, 'gibtsnicht.log'))
      expect(journal.read()).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
