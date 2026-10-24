import { useEffect, useState } from 'react'
import { useApp } from '../state'
import { Empty, Field, Modal, Notice, Switch } from '../components/ui'
import type { WorldCreateInfo, WorldDifficulty, WorldGameMode } from '@shared/types'

/**
 * Dialog zum direkten Erstellen einer neuen Minecraft-Welt in der
 * Anwendung: Name, Version, Spielmodus, Schwierigkeit, optionaler Seed
 * und Cheats. Die Generierung uebernimmt der Main-Prozess mit einem
 * echten Paper-Server; der Fortschritt kommt ueber state.sync.
 */
export function CreateWorldModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  /** Wird nach erfolgreichem Anlegen aufgerufen (Start ggf. mit Fehler). */
  onCreated: (info: WorldCreateInfo, startError?: string) => void
}): React.JSX.Element {
  const { state, api } = useApp()
  const [name, setName] = useState('')
  const [version, setVersion] = useState(state.settings.mcVersion)
  const [gameMode, setGameMode] = useState<WorldGameMode>('survival')
  const [difficulty, setDifficulty] = useState<WorldDifficulty>('normal')
  const [seed, setSeed] = useState('')
  const [cheats, setCheats] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const versions = [...new Set([version, '1.20.4', '1.20.6', '1.21', '1.21.1', '1.21.4'])]
  const difficultyLabels: Record<WorldDifficulty, string> = {
    peaceful: 'Friedlich',
    easy: 'Einfach',
    normal: 'Normal',
    hard: 'Schwer'
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Bitte trage einen Namen für die Welt ein.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.createWorld({
        name: trimmed,
        mcVersion: version,
        gameMode,
        difficulty,
        seed: seed.trim() ? seed.trim() : undefined,
        cheats
      })
      if (result.ok && result.info) {
        onCreated(result.info, result.startError)
      } else {
        setError(result.error ?? result.startError ?? 'Die Welt konnte nicht erstellt werden.')
      }    } finally {
      setBusy(false)
    }
  }

  const closable = !busy
  const handleClose = (): void => {
    if (closable) onClose()
  }
  const progress =
    busy && state.sync.phase === 'preparing' ? state.sync.message : 'Minecraft generiert die Welt …'

  return (
    <Modal
      title="Neue Welt erstellen"
      description="Die Welt wird von einem echten Minecraft-Server generiert und anschließend automatisch gestartet. Der erste Start kann einige Minuten dauern."
      onClose={handleClose}
    >
      <div className="col" style={{ gap: 10 }}>
        {busy && <Notice kind="info">{progress}</Notice>}
        {error && !busy && <Notice kind="danger">{error}</Notice>}

        <Field label="Weltname" help="Erlaubt sind Buchstaben, Zahlen, Leerzeichen sowie _ - . Der Name wird auch zum Ordnernamen der Welt.">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Meine Welt"
            autoFocus
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </Field>

        <Field label="Minecraft-Version" help="Für diese Version wird die Welt generiert. Sie sollte zur Version der Mitspieler passen.">
          <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy}>
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Spielmodus" help="Betrifft Spieler, die in dieser Welt neu dazukommen.">
          <select
            value={gameMode}
            onChange={(e) => setGameMode(e.target.value as WorldGameMode)}
            disabled={busy}
          >
            <option value="survival">Überleben</option>
            <option value="creative">Kreativ</option>
          </select>
        </Field>

        <Field label="Schwierigkeitsgrad">
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as WorldDifficulty)}
            disabled={busy}
          >
            {(Object.keys(difficultyLabels) as WorldDifficulty[]).map((d) => (
              <option key={d} value={d}>
                {difficultyLabels[d]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Welt-Seed (optional)" help="Leer lassen, damit Minecraft einen zufälligen Seed würfelt.">
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="z. B. 123456789"
            disabled={busy}
          />
        </Field>

        <Switch
          checked={cheats}
          onChange={setCheats}
          label="Cheats erlauben"
          description="Trägt dich als Operator ein (Kommandos wie /tp, /give). Bestehende Operator-Liste wird nicht gelöscht."
        />

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={handleClose} disabled={busy}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '⏳ Welt wird erstellt …' : '✨ Erstellen und starten'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Auswahl einer bereits vorhandenen Welt aus dem Anwendung-eigenen
 * Weltspeicher (alternative zum Neuerstellen).
 */
export function SelectWorldModal({
  onClose,
  onSelected
}: {
  onClose: () => void
  /** Wird nach der erfolgreichen Auswahl aufgerufen. */
  onSelected: (name: string) => void
}): React.JSX.Element {
  const { api, notify } = useApp()
  const [worlds, setWorlds] = useState<Array<{ path: string; name: string; dataVersion: number }>>([])
  const [busyName, setBusyName] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void api
      .listWorlds()
      .then((w) => {
        if (alive) {
          setWorlds(w)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (alive) {
          setError('Die Welten konnten nicht geladen werden.')
          setLoaded(true)
        }
      })
    return () => {
      alive = false
    }
  }, [api])

  const pick = async (name: string): Promise<void> => {
    setBusyName(name)
    setError(null)
    try {
      const result = await api.selectWorld(name)
      if (result.ok) onSelected(name)
      else setError(result.error ?? 'Die Welt konnte nicht ausgewählt werden.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyName(null)
    }
  }

  return (
    <Modal
      title="Vorhandene Welt auswählen"
      description="Wähle eine Welt aus dem Speicher dieser Anwendung. Sie wird geprüft und als aktive Welt dieser Gruppe eingerichtet."
      onClose={onClose}
    >
      <div className="col" style={{ gap: 10 }}>
        {error && <Notice kind="danger">{error}</Notice>}
        {!loaded && <div className="small dim">Wird geladen …</div>}
        {loaded && worlds.length === 0 && (
          <Empty>Keine Welten im Speicher. Erstelle eine neue Welt oder importiere eine bestehende Welt.</Empty>
        )}
        {loaded && worlds.length > 0 && (
          <div className="col" style={{ gap: 8 }}>
            {worlds.map((w) => (
              <button
                key={w.path}
                className="btn"
                style={{ justifyContent: 'space-between' }}
                disabled={busyName !== null}
                onClick={() => void pick(w.name)}
              >
                <span>📂 {w.name}</span>
                <span className="small dim mono">DataVersion {w.dataVersion}</span>
              </button>
            ))}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busyName !== null}>
            Abbrechen
          </button>
        </div>
      </div>
    </Modal>
  )
}

/** Erfolgsmeldung fuer die Welt-Erstellung (Toast-Text). */
export function worldCreatedNotice(info: WorldCreateInfo | undefined, startError?: string): {
  message: string
  kind: 'ok' | 'warn' | 'error'
} {
  if (startError) {
    return {
      message: `Welt "${info?.worldName ?? ''}" wurde erstellt, aber der Start schlug fehl: ${startError}`,
      kind: 'warn'
    }
  }
  return {
    message: `Welt "${info?.worldName ?? ''}" erstellt und gestartet`,
    kind: 'ok'
  }
}
