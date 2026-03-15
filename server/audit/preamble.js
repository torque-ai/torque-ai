'use strict'

const PREAMBLE_TOKEN_BUDGET = 500
const CHARS_PER_TOKEN = 4

const toText = (value) => {
  if (value === undefined || value === null) {
    return ''
  }

  return typeof value === 'string' ? value : String(value)
}

const normalizeBudget = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0
  }

  return Math.floor(value)
}

const normalizeFileCount = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }

  const normalized = Math.floor(value)
  return normalized < 0 ? 0 : normalized
}

const normalizeProjectPath = (value) => (typeof value === 'string' ? value : '')

const estimateTokens = (text) => {
  return Math.ceil(toText(text).length / CHARS_PER_TOKEN)
}

const trimToTokenBudget = (text, budget) => {
  const normalizedText = toText(text)
  const normalizedBudget = normalizeBudget(budget)
  const maxChars = normalizedBudget * CHARS_PER_TOKEN

  if (normalizedText.length <= maxChars) {
    return normalizedText
  }

  return normalizedText.slice(0, maxChars)
}

const generatePreamble = (scanReportText, { fileCount = 0, projectPath = '' } = {}) => {
  const safeProjectPath = normalizeProjectPath(projectPath)
  const safeFileCount = normalizeFileCount(fileCount)
  const scanText = toText(scanReportText)
  const header = `Project path: ${safeProjectPath}\nFile count: ${safeFileCount}\n`
  const availableBudget = Math.max(PREAMBLE_TOKEN_BUDGET - estimateTokens(header), 0)
  const noScanMessage = 'No scan data available. Review the code based on its contents alone.'

  const body = scanText
    ? trimToTokenBudget(scanText, availableBudget)
    : trimToTokenBudget(noScanMessage, availableBudget)

  return `${header}${body}`
}

module.exports = {
  PREAMBLE_TOKEN_BUDGET,
  estimateTokens,
  trimToTokenBudget,
  generatePreamble,
}
