import { logger } from '../src/main/core/logger'

// In Tests wird die Konsolenausgabe unterdrückt, damit die Testausgabe
// lesbar bleibt. Die Log-Einträge werden weiterhin im Ringpuffer gehalten.
logger.setSilent(true)
