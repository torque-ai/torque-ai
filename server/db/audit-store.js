'use strict'

const logger = require('../logger').child({ component: 'audit-store' })
const { v4: uuidv4 } = require('uuid')

let db = null

const VALID_RUN_UPDATE_FIELDS = new Set([
  'status',
  'workflow_id',
  'total_files',
  'files_scanned',
  'files_skipped',
  'total_findings',
  'parse_failures',
  'error',
  'started_at',
  'completed_at'
])

function setDb(dbInstance) {
  db = dbInstance
}

function assertDbInitialized() {
  if (!db) {
    const error = new Error('Database has not been initialized. Call setDb(dbInstance) first.')
    logger.error(error, 'Database not initialized')
    throw error
  }
}

function toInteger(value, name, allowNull = true) {
  if (value === undefined || value === null) {
    if (allowNull) return null
    throw new Error(`Invalid value for ${name}`)
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid integer value for ${name}`)
  }

  return parsed
}

function toBooleanInt(value, name) {
  if (value === undefined || value === null) {
    throw new Error(`Invalid value for ${name}`)
  }

  if (typeof value === 'number') {
    if (value === 0 || value === 1) return value
    throw new Error(`Invalid number value for ${name}`)
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return 1
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return 0
  }

  throw new Error(`Invalid boolean value for ${name}`)
}

function createWhereClause(conditions) {
  if (!conditions.length) {
    return { whereClause: '1 = 1', params: [] }
  }

  return {
    whereClause: conditions.map((cond) => cond.clause).join(' AND '),
    params: conditions.flatMap((cond) => cond.params)
  }
}

function escapeLikePattern(value) {
  return String(value).replace(/[%_]/g, '\\$&')
}

function createAuditRun({ project_path, categories, provider, workflow_id }) {
  assertDbInitialized()

  const id = uuidv4()
  const categoryJson = JSON.stringify(categories ?? [])
  const safeProjectPath = String(project_path)

  try {
    const statement = db.prepare(`
      INSERT INTO audit_runs (
        id,
        project_path,
        categories,
        provider,
        workflow_id
      ) VALUES (
        ?, ?, ?, ?, ?
      )
    `)

    statement.run(
      id,
      safeProjectPath,
      categoryJson,
      provider || null,
      workflow_id || null
    )

    return id
  } catch (error) {
    logger.error({ error, project_path, workflow_id }, 'Failed to create audit run')
    throw error
  }
}

function getAuditRun(id) {
  assertDbInitialized()
  try {
    const statement = db.prepare('SELECT * FROM audit_runs WHERE id = ?')
    return statement.get(id)
  } catch (error) {
    logger.error({ error, id }, 'Failed to get audit run')
    throw error
  }
}

function updateAuditRun(id, fields = {}) {
  assertDbInitialized()
  const updates = []
  const params = []

  Object.keys(fields).forEach((key) => {
    if (!VALID_RUN_UPDATE_FIELDS.has(key)) return
    if (fields[key] === undefined) return

    updates.push(`${key} = ?`)
    params.push(fields[key])
  })

  if (!updates.length) {
    return 0
  }

  params.push(id)

  try {
    const statement = db.prepare(`
      UPDATE audit_runs
      SET ${updates.join(', ')}
      WHERE id = ?
    `)
    return statement.run(...params).changes
  } catch (error) {
    logger.error({ error, id, fields }, 'Failed to update audit run')
    throw error
  }
}

function listAuditRuns({ project_path, status, workflow_id, limit = 10 } = {}) {
  assertDbInitialized()
  const conditions = []

  if (project_path !== undefined) {
    conditions.push({ clause: 'project_path = ?', params: [project_path] })
  }

  if (status !== undefined) {
    conditions.push({ clause: 'status = ?', params: [status] })
  }

  if (workflow_id !== undefined) {
    conditions.push({ clause: 'workflow_id = ?', params: [workflow_id] })
  }

  const { whereClause, params } = createWhereClause(conditions)
  const parsedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 10

  try {
    const statement = db.prepare(`
      SELECT * FROM audit_runs
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `)
    return statement.all(...params, parsedLimit)
  } catch (error) {
    logger.error({ error, project_path, status, limit }, 'Failed to list audit runs')
    throw error
  }
}

function insertFindings(findings = []) {
  assertDbInitialized()
  if (!Array.isArray(findings)) {
    throw new Error('findings must be an array')
  }

  if (!findings.length) {
    return []
  }

  const insertFinding = db.prepare(`
    INSERT INTO audit_findings (
      id,
      audit_run_id,
      file_path,
      line_start,
      line_end,
      category,
      subcategory,
      severity,
      confidence,
      title,
      description,
      suggestion,
      snippet,
      snippet_hash,
      provider,
      model,
      task_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `)

  const inserted = []

  try {
    const transaction = db.transaction((rows) => {
      for (const finding of rows) {
        const id = uuidv4()
        inserted.push(id)
        insertFinding.run(
          id,
          finding.audit_run_id,
          finding.file_path,
          finding.line_start ?? null,
          finding.line_end ?? null,
          finding.category ?? null,
          finding.subcategory ?? null,
          finding.severity ?? null,
          finding.confidence ?? null,
          finding.title ?? null,
          finding.description ?? null,
          finding.suggestion ?? null,
          finding.snippet ?? null,
          finding.snippet_hash ?? null,
          finding.provider ?? null,
          finding.model ?? null,
          finding.task_id ?? null
        )
      }
    })

    transaction(findings)
    return inserted
  } catch (error) {
    logger.error({ error, findingsCount: findings.length }, 'Failed to insert findings')
    throw error
  }
}

function getFindings({
  audit_run_id,
  category,
  severity,
  confidence,
  verified,
  false_positive,
  file_path,
  limit = 50,
  offset = 0
} = {}) {
  assertDbInitialized()

  const conditions = []

  if (audit_run_id !== undefined) {
    conditions.push({ clause: 'audit_run_id = ?', params: [audit_run_id] })
  }
  if (category !== undefined) {
    conditions.push({ clause: 'category = ?', params: [category] })
  }
  if (severity !== undefined) {
    conditions.push({ clause: 'severity = ?', params: [toInteger(severity, 'severity')] })
  }
  if (confidence !== undefined) {
    conditions.push({ clause: 'confidence = ?', params: [toInteger(confidence, 'confidence')] })
  }
  if (verified !== undefined) {
    conditions.push({ clause: 'verified = ?', params: [toBooleanInt(verified, 'verified')] })
  }
  if (false_positive !== undefined) {
    conditions.push({ clause: 'false_positive = ?', params: [toBooleanInt(false_positive, 'false_positive')] })
  }
  if (file_path !== undefined) {
    const escapedFilePath = escapeLikePattern(file_path)
    conditions.push({ clause: "file_path LIKE ? ESCAPE '\\'", params: [`%${escapedFilePath}%`] })
  }

  const { whereClause, params } = createWhereClause(conditions)
  const parsedLimit = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Math.floor(Number(limit)) : 50
  const parsedOffset = Number.isFinite(Number(offset)) && Number(offset) >= 0 ? Math.floor(Number(offset)) : 0

  try {
    const countStatement = db.prepare(`
      SELECT COUNT(*) AS total
      FROM audit_findings
      WHERE ${whereClause}
    `)

    const rowsStatement = db.prepare(`
      SELECT * FROM audit_findings
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)

    const total = countStatement.get(...params).total
    const findings = rowsStatement.all(...params, parsedLimit, parsedOffset)
    return { findings, total }
  } catch (error) {
    logger.error({ error, filters: { audit_run_id, category, severity, confidence, verified, false_positive, file_path } }, 'Failed to get findings')
    throw error
  }
}

function updateFinding(id, updates = {}) {
  assertDbInitialized()

  const fields = []
  const params = []

  if (updates.verified !== undefined) {
    fields.push('verified = ?')
    params.push(toBooleanInt(updates.verified, 'verified'))
  }

  if (updates.false_positive !== undefined) {
    fields.push('false_positive = ?')
    params.push(toBooleanInt(updates.false_positive, 'false_positive'))
  }

  if (!fields.length) {
    return null
  }

  params.push(id)

  try {
    const updateStatement = db.prepare(`
      UPDATE audit_findings
      SET ${fields.join(', ')}
      WHERE id = ?
    `)

    const result = updateStatement.run(...params)
    if (result.changes === 0) return null

    const findStatement = db.prepare('SELECT * FROM audit_findings WHERE id = ?')
    return findStatement.get(id)
  } catch (error) {
    logger.error({ error, id, updates }, 'Failed to update finding')
    throw error
  }
}

function getAuditSummary(runId) {
  assertDbInitialized()

  try {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified
      FROM audit_findings
      WHERE audit_run_id = ?
    `).get(runId)

    const byCategoryRows = db.prepare(`
      SELECT category, COUNT(*) AS count
      FROM audit_findings
      WHERE audit_run_id = ?
      GROUP BY category
    `).all(runId)

    const bySeverityRows = db.prepare(`
      SELECT severity, COUNT(*) AS count
      FROM audit_findings
      WHERE audit_run_id = ?
      GROUP BY severity
    `).all(runId)

    const byConfidenceRows = db.prepare(`
      SELECT confidence, COUNT(*) AS count
      FROM audit_findings
      WHERE audit_run_id = ?
      GROUP BY confidence
    `).all(runId)

    const fileHotspotRows = db.prepare(`
      SELECT file_path, COUNT(*) AS count
      FROM audit_findings
      WHERE audit_run_id = ?
      GROUP BY file_path
      ORDER BY count DESC
      LIMIT 10
    `).all(runId)

    const by_category = {}
    const by_severity = {}
    const by_confidence = {}

    for (const row of byCategoryRows) {
      by_category[row.category] = row.count
    }

    for (const row of bySeverityRows) {
      by_severity[String(row.severity)] = row.count
    }

    for (const row of byConfidenceRows) {
      by_confidence[String(row.confidence)] = row.count
    }

    const total = counts.total || 0
    const verified = counts.verified || 0

    return {
      total,
      verified,
      unverified: total - verified,
      by_category,
      by_severity,
      by_confidence,
      file_hotspots: fileHotspotRows
    }
  } catch (error) {
    logger.error({ error, runId }, 'Failed to get audit summary')
    throw error
  }
}

function incrementAuditRunCounters(id, { total_findings = 0, parse_failures = 0 } = {}) {
  assertDbInitialized()

  const updates = []
  const params = []

  if (total_findings > 0) {
    updates.push('total_findings = COALESCE(total_findings, 0) + ?')
    params.push(total_findings)
  }
  if (parse_failures > 0) {
    updates.push('parse_failures = COALESCE(parse_failures, 0) + ?')
    params.push(parse_failures)
  }

  if (!updates.length) {
    return 0
  }

  params.push(id)

  try {
    const statement = db.prepare(`
      UPDATE audit_runs
      SET ${updates.join(', ')}
      WHERE id = ?
    `)
    return statement.run(...params).changes
  } catch (error) {
    logger.error({ error, id }, 'Failed to increment audit run counters')
    throw error
  }
}

function getFalsePositives(projectPath) {
  assertDbInitialized()

  try {
    const statement = db.prepare(`
      SELECT af.*
      FROM audit_findings af
      INNER JOIN audit_runs ar ON ar.id = af.audit_run_id
      WHERE ar.project_path = ? AND af.false_positive = 1
      ORDER BY af.created_at DESC
    `)
    return statement.all(projectPath)
  } catch (error) {
    logger.error({ error, projectPath }, 'Failed to get false positives')
    throw error
  }
}

module.exports = {
  setDb,
  VALID_RUN_UPDATE_FIELDS,
  createAuditRun,
  getAuditRun,
  updateAuditRun,
  listAuditRuns,
  insertFindings,
  getFindings,
  updateFinding,
  getAuditSummary,
  incrementAuditRunCounters,
  getFalsePositives
}
