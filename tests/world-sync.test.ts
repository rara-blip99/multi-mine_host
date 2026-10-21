import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { asStream, createStreamPair, MockStream } from './helpers/mock-stream'
import { buildManifest } from '../src/main/sync/manifest'
import {
  activateWorld,
  hasFreeSpace,
  receiveWorld,
  sendWorld
} from '../src/main/sync/world-sync'
import { verifyWorld } from '../src/main/sync/manifest'

/**
 * Tests fuer die Weltuebertragung:
 * vollstaendig, unterbrochen (Resume), beschaedigte Pruefsumme,
 * Path Traversal und Platzmangel.
 */
function makeWorld(dir: string): void {
  mkdirSync(join(dir, 'region'), { recursive: true })
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(join(dir, 'level.dat'), 'LEVELDAT')
  writeFileSync(join(dir, 'region', 'r.0.0.mca'), 'CHUNK-DATEN')
  writeFileSync(join(dir, 'data', 'player.dat'), 'SPIELER')
}

describe('Weltübertragung', () => {
  it('überträgt eine Welt vollständig und prüft sie', async () => {
    const source = mkdtempSync(join(tmpdir(), 'mmh-src-'))
    const target = mkdtempSync(join(tmpdir(), 'mmh-dst-'))
    try {
      makeWorld(source)
      const manifest = await buildManifest({
        worldPath: source,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      const { a, b } = createStreamPair()
      const sendPromise = sendWorld(asStream(a), source, manifest)
      const receivePromise = receiveWorld(asStream(b), {
        targetPath: target,
        manifest
      })

      const [sendResult, receiveResult] = await Promise.all([sendPromise, receivePromise])

      expect(sendResult.ok).toBe(true)
      expect(receiveResult.ok).toBe(true)
      expect(receiveResult.versionId).toBe(manifest.versionId)
      expect(existsSync(join(target, 'level.dat'))).toBe(true)
      expect(readFileSync(join(target, 'region', 'r.0.0.mca'), 'utf8')).toBe('CHUNK-DATEN')

      const verification = await verifyWorld(target, manifest)
      expect(verification.ok).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('überträgt nur die fehlenden Dateien (inkrementell)', async () => {
    const source = mkdtempSync(join(tmpdir(), 'mmh-src-'))
    const target = mkdtempSync(join(tmpdir(), 'mmh-dst-'))
    try {
      makeWorld(source)
      const manifest = await buildManifest({
        worldPath: source,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      // Eine Datei ist schon da
      writeFileSync(join(target, 'level.dat'), 'LEVELDAT')

      const { a, b } = createStreamPair()
      const sendPromise = sendWorld(asStream(a), source, manifest, {
        skip: new Set(['level.dat'])
      })
      const receivePromise = receiveWorld(asStream(b), { targetPath: target, manifest })

      const [, receiveResult] = await Promise.all([sendPromise, receivePromise])
      expect(receiveResult.ok).toBe(true)
      // Die uebersprungene Datei muss weiterhin vorhanden sein
      expect(existsSync(join(target, 'level.dat'))).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('erkennt eine beschädigte Prüfsumme beim Empfang', async () => {
    const source = mkdtempSync(join(tmpdir(), 'mmh-src-'))
    const target = mkdtempSync(join(tmpdir(), 'mmh-dst-'))
    try {
      makeWorld(source)
      const manifest = await buildManifest({
        worldPath: source,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      const { a, b } = createStreamPair()
      // Der Sender meldet eine falsche Pruefsumme
      const brokenManifest = {
        ...manifest,
        entries: manifest.entries.map((e) =>
          e.path === 'level.dat' ? { ...e, sha256: 'f'.repeat(64) } : e
        )
      }

      const sendPromise = sendWorld(asStream(a), source, brokenManifest)
      const receivePromise = receiveWorld(asStream(b), {
        targetPath: target,
        manifest: brokenManifest
      })

      const [, receiveResult] = await Promise.all([sendPromise, receivePromise])
      expect(receiveResult.ok).toBe(false)
      expect(receiveResult.error).toContain('Prüfsumme')
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('setzt eine unterbrochene Übertragung fort (Resume)', async () => {
    const source = mkdtempSync(join(tmpdir(), 'mmh-src-'))
    const target = mkdtempSync(join(tmpdir(), 'mmh-dst-'))
    try {
      makeWorld(source)
      const manifest = await buildManifest({
        worldPath: source,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      // Erster Versuch: die Verbindung bricht mitten in der Übertragung ab
      const receiver = new MockStream('receiver')
      const sender = new MockStream('sender', receiver)
      sender.failAfterBytes = 100

      const sendAttempt = sendWorld(asStream(sender), source, manifest)
      const receiveAttempt = receiveWorld(asStream(receiver), { targetPath: target, manifest })
      const [, firstResult] = await Promise.all([sendAttempt, receiveAttempt])

      expect(firstResult.ok).toBe(false)
      expect(firstResult.error).toContain('unvollständig')

      // Zweiter Versuch: die Verbindung steht wieder
      const { a, b } = createStreamPair()
      const sendPromise = sendWorld(asStream(a), source, manifest)
      const receivePromise = receiveWorld(asStream(b), { targetPath: target, manifest })
      const [sendResult, receiveResult] = await Promise.all([sendPromise, receivePromise])

      expect(sendResult.ok).toBe(true)
      expect(receiveResult.ok).toBe(true)
      const verification = await verifyWorld(target, manifest)
      expect(verification.ok).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('nimmt eine bereits teilweise empfangene Datei wieder auf', async () => {
    const source = mkdtempSync(join(tmpdir(), 'mmh-src-'))
    const target = mkdtempSync(join(tmpdir(), 'mmh-dst-'))
    try {
      makeWorld(source)
      const manifest = await buildManifest({
        worldPath: source,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      // Simulate einen früheren, abgebrochenen Empfang: die Hälfte der
      // level.dat liegt bereits als .part vor.
      const entry = manifest.entries.find((e) => e.path === 'level.dat')
      expect(entry).toBeDefined()
      const content = Buffer.from('LEVELDAT', 'utf8')
      const half = content.subarray(0, 4)
      writeFileSync(join(target, 'level.dat.part'), half)

      const resume = [
        {
          path: 'level.dat',
          size: entry!.size,
          sha256: entry!.sha256,
          received: half.length
        }
      ]

      const { a, b } = createStreamPair()
      const sendPromise = sendWorld(asStream(a), source, manifest, {
        resume: new Map([['level.dat', half.length]])
      })
      const receivePromise = receiveWorld(asStream(b), { targetPath: target, manifest, resume })
      const [, receiveResult] = await Promise.all([sendPromise, receivePromise])

      expect(receiveResult.ok).toBe(true)
      expect(receiveResult.resumed).toBe(true)
      expect(readFileSync(join(target, 'level.dat'), 'utf8')).toBe('LEVELDAT')
      const verification = await verifyWorld(target, manifest)
      expect(verification.ok).toBe(true)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('lehnt Pfade mit Traversal ab', async () => {
    const source = mkdtempSync(join(tmpdir(), 'mmh-src-'))
    const target = mkdtempSync(join(tmpdir(), 'mmh-dst-'))
    try {
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'level.dat'), 'LEVEL')
      const manifest = await buildManifest({
        worldPath: source,
        worldName: 'test',
        mcVersion: '1.20.4',
        dataVersion: 3700
      })

      // Manipulation: ein Pfad zeigt aus dem Zielverzeichnis heraus
      const evil = {
        ...manifest,
        entries: [
          {
            path: '../evil.txt',
            size: 4,
            mtimeMs: 0,
            sha256: 'a'.repeat(64)
          }
        ]
      }

      const { a, b } = createStreamPair()
      const sendPromise = sendWorld(asStream(a), source, evil)
      const receivePromise = receiveWorld(asStream(b), { targetPath: target, manifest: evil })

      const [, receiveResult] = await Promise.all([sendPromise, receivePromise])
      expect(receiveResult.ok).toBe(false)
      expect(existsSync(join(target, '..', 'evil.txt'))).toBe(false)
    } finally {
      rmSync(source, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('prüft den verfügbaren Speicherplatz', () => {
    const dir = tmpdir()
    // 1 Byte benötigt -> passt auf jedem Laufwerk
    expect(hasFreeSpace(dir, 1)).toBe(true)
    // 100 TB benötigt -> passt nicht
    expect(hasFreeSpace(dir, 100 * 1024 * 1024 * 1024 * 1024)).toBe(false)
  })

  it('aktiviert eine empfangene Welt atomar und quarantänisiert die alte', () => {
    const root = mkdtempSync(join(tmpdir(), 'mmh-activate-'))
    try {
      const staging = join(root, 'staging')
      const active = join(root, 'active')
      const quarantine = join(root, 'quarantine')
      mkdirSync(staging, { recursive: true })
      mkdirSync(active, { recursive: true })
      writeFileSync(join(staging, 'level.dat'), 'NEU')
      writeFileSync(join(active, 'level.dat'), 'ALT')

      activateWorld(staging, active, quarantine)

      expect(readFileSync(join(active, 'level.dat'), 'utf8')).toBe('NEU')
      expect(existsSync(join(quarantine))).toBe(true)
      // Die alte Welt ist nicht verloren
      const quarantined = require('node:fs').readdirSync(quarantine) as string[]
      expect(quarantined.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
