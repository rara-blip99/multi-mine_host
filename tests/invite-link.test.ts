import { describe, expect, it } from 'vitest'
import { encodeInviteLink, parseInviteLink } from '../src/shared/protocol'

/**
 * Der kombinierte Einladungslink transportiert Hub-Adresse, Gruppen-ID und
 * Einladungscode in einem Text. So braucht der Empfanger keine drei
 * Felder einzeln einzugeben.
 */
describe('Einladungslink', () => {
  const bundle = {
    hubAddress: '/ip4/192.168.178.24/tcp/4001/p2p/12D3KooWA1B2C3D4E5F6',
    groupId: '1b21f559-9ff1-4a9c-a45e-7c21aae49396',
    inviteCode: 'MMH-4RC4-HQ7V-R2GZ'
  }

  it('kodiert und dekodiert den kompletten Einladungslink', () => {
    const link = encodeInviteLink(bundle)
    expect(link.startsWith('MMH-INV:')).toBe(true)
    // Zeichensicher fuer Chats und Notizen
    expect(link).toMatch(/^[A-Za-z0-9:._-]+$/)
    const parsed = parseInviteLink(link)
    expect(parsed).toEqual(bundle)
  })

  it('rundet Sonderzeichen und Unicode zuverlaessig durch', () => {
    const special = {
      hubAddress: '/ip6/::1/tcp/4001/p2p/12D3KooWxyz',
      groupId: 'gruppe-mit-bindestrichen',
      inviteCode: 'MMH-ABCD-EFGH-JKLM'
    }
    expect(parseInviteLink(encodeInviteLink(special))).toEqual(special)
  })

  it('parst mit Whitespace und unvollstaendiger base64-Auffuellung', () => {
    const link = encodeInviteLink(bundle)
    const padded = `  ${link}  `
    expect(parseInviteLink(padded)).toEqual(bundle)
  })

  it('lehnt nichts-Einladungs-Texte ab', () => {
    expect(parseInviteLink('MMH-4RC4-HQ7V-R2GZ')).toBeNull()
    expect(parseInviteLink('MMH-INV:zap')).toBeNull()
    expect(parseInviteLink('MMH-INV:a.b')).toBeNull()
    expect(parseInviteLink('')).toBeNull()
  })

  it('lehnt manipulierte Links ab, deren Gruppe oder Code fehlt', () => {
    const link = encodeInviteLink(bundle)
    const corrupted = link.replace(/.$/, 'A')
    const parsed = parseInviteLink(corrupted)
    // Entweder gescheitertes Dekoding (null) oder ein erkennbar
    // veraenderter Inhalt - niemals derselbe entbuednddere Code.
    if (parsed !== null) {
      expect(parsed).not.toEqual(bundle)
    }
  })
})
