'use strict'

const crypto = require('node:crypto')
const logger = require('../logger').child({ component: 'audit-aggregator' })

function parseArrayCandidate(candidate) {
  if (candidate === undefined || candidate === null) {
    return { findings: [], error: 'No candidate JSON was provided' }
  }

  if (typeof candidate !== 'string') {
    return { findings: [], error: 'JSON candidate must be a string' }
  }

  const trimmed = candidate.trim()
  if (!trimmed) {
    return { findings: [], error: 'JSON candidate is empty' }
  }

  if (!trimmed.startsWith('[')) {
    return { findings: [], error: 'JSON candidate does not start with [' }
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      return { findings: [], error: 'Parsed JSON is not an array' }
    }

    return { findings: parsed, error: null }
  } catch (error) {
    return { findings: [], error: error.message || 'Failed to parse JSON array' }
  }
}

function parseTaskOutput(text) {
  const safeText = typeof text === 'string' ? text : ''
  const raw = safeText.trim()
  let lastError = null

  if (!raw) {
    return { findings: [], parseError: 'Task output is empty' }
  }

  if (raw.startsWith('[')) {
    const parsed = parseArrayCandidate(raw)
    if (!parsed.error) {
      return { findings: parsed.findings, parseError: null }
    }

    lastError = parsed.error
  }

  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch && fencedMatch[1] !== undefined) {
    const parsed = parseArrayCandidate(fencedMatch[1])
    if (!parsed.error) {
      return { findings: parsed.findings, parseError: null }
    }

    lastError = parsed.error
  }

  const arrayMatches = [...raw.matchAll(/\[[\s\S]*?\]/g)]
  for (const match of arrayMatches) {
    const parsed = parseArrayCandidate(match[0])
    if (!parsed.error) {
      return { findings: parsed.findings, parseError: null }
    }

    lastError = parsed.error
  }

  const parseError = lastError
    ? `Could not parse findings array from task output: ${lastError}`
    : 'Could not parse findings array from task output'

  logger.warn({ output: safeText.slice(0, 800) }, parseError)

  return { findings: [], parseError }
}

function snippetHash(snippet) {
  if (!snippet) {
    return null
  }

  const normalized = String(snippet)
    .replace(/\s+/g, ' ')
    .trim()

  return crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 16)
}

function deduplicateFindings(findings) {
  if (!Array.isArray(findings)) {
    return []
  }

  const seen = new Set()
  const deduplicated = []

  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') {
      deduplicated.push(finding)
      continue
    }

    const filePath = finding.file_path ?? ''
    const lineStart = finding.line_start ?? ''
    const subcategory = finding.subcategory || finding.category || ''
    const key = `${filePath}:${lineStart}:${subcategory}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduplicated.push(finding)
  }

  return deduplicated
}

function checkFalsePositiveHistory(finding, pastFPs) {
  if (!finding || !pastFPs || !Array.isArray(pastFPs)) {
    return finding
  }

  const snippetHashValue = finding.snippet_hash
  if (!snippetHashValue) {
    return finding
  }

  const filePath = finding.file_path
  const subcategory = finding.subcategory || finding.category

  const isMatch = pastFPs.some((pastFP) => {
    if (!pastFP || typeof pastFP !== 'object') {
      return false
    }

    const pastSubcategory = pastFP.subcategory || pastFP.category
    return pastFP.file_path === filePath
      && pastSubcategory === subcategory
      && pastFP.snippet_hash === snippetHashValue
  })

  if (!isMatch) {
    return finding
  }

  return {
    ...finding,
    confidence: 'low'
  }
}

async function processTaskResult({
  taskId,
  output,
  provider,
  model,
  auditRunId,
  filePaths
}, auditStore) {
  const parseResult = parseTaskOutput(output)

  const getAuditRun = auditStore.getAuditRun ? auditStore.getAuditRun : () => null
  const getFalsePositives = auditStore.getFalsePositives ? auditStore.getFalsePositives : () => []
  const insertFindings = auditStore.insertFindings ? auditStore.insertFindings : () => []
  const incrementCounters = auditStore.incrementAuditRunCounters
    ? auditStore.incrementAuditRunCounters
    : null
  const updateAuditRun = auditStore.updateAuditRun ? auditStore.updateAuditRun : () => 0

  if (parseResult.parseError) {
    if (incrementCounters) {
      await Promise.resolve(incrementCounters(auditRunId, { parse_failures: 1 }))
    } else {
      const currentRun = await Promise.resolve(getAuditRun(auditRunId))
      const currentParseFailures = Number(currentRun?.parse_failures)
      const nextParseFailures = Number.isFinite(currentParseFailures)
        ? currentParseFailures + 1
        : 1
      await Promise.resolve(updateAuditRun(auditRunId, { parse_failures: nextParseFailures }))
    }

    return { inserted: 0, parseError: parseResult.parseError }
  }

  const parsedFindings = Array.isArray(parseResult.findings)
    ? parseResult.findings
    : []

  const enrichedFindings = parsedFindings
    .filter((finding) => finding && typeof finding === 'object')
    .map((finding) => ({
      ...finding,
      file_path: finding.file_path || (Array.isArray(filePaths) && filePaths[0]) || 'unknown',
      audit_run_id: auditRunId,
      provider,
      model,
      task_id: taskId,
      snippet_hash: snippetHash(finding.snippet)
    }))

  const deduplicated = deduplicateFindings(enrichedFindings)

  const currentRunForFP = await Promise.resolve(getAuditRun(auditRunId))
  const projectPath = currentRunForFP?.project_path || null

  const pastFalsePositives = projectPath
    ? await Promise.resolve(getFalsePositives(projectPath))
    : []

  const reviewedFindings = deduplicated.map((finding) =>
    checkFalsePositiveHistory(
      finding,
      Array.isArray(pastFalsePositives) ? pastFalsePositives : []
    )
  )

  const insertedFindingIds = await Promise.resolve(insertFindings(reviewedFindings))
  const inserted = Array.isArray(insertedFindingIds)
    ? insertedFindingIds.length
    : 0

  if (inserted > 0) {
    if (incrementCounters) {
      await Promise.resolve(incrementCounters(auditRunId, { total_findings: inserted }))
    } else {
      const currentRun = await Promise.resolve(getAuditRun(auditRunId))
      const existingTotal = Number(currentRun?.total_findings)
      const nextTotalFindings = Number.isFinite(existingTotal)
        ? existingTotal + inserted
        : inserted
      await Promise.resolve(updateAuditRun(auditRunId, { total_findings: nextTotalFindings }))
    }
  }

  logger.info({
    taskId,
    auditRunId,
    provider,
    model,
    inserted,
    filePaths
  }, 'Processed audit task result')

  return { inserted, parseError: null }
}

module.exports = {
  parseTaskOutput,
  snippetHash,
  deduplicateFindings,
  checkFalsePositiveHistory,
  processTaskResult
}
