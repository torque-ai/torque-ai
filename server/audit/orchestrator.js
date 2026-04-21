'use strict'

const { inventoryFiles } = require('./inventory')
const { generatePreamble } = require('./preamble')
const { createReviewUnits } = require('./chunking')
const { buildReviewPrompt } = require('./prompt-builder')
const { filterCategories, getRelevantCategories, AUDIT_CATEGORIES } = require('./categories')
const logger = require('../logger').child({ component: 'audit-orchestrator' })
const { readFile } = require('node:fs/promises')
const path = require('node:path')

let _auditStore = null
let _createWorkflow = null
let _runWorkflow = null
let _scanProject = null

const TIER_WEIGHTS = {
  small: 1,
  medium: 3,
  large: 5,
}

const normalizeArrayInput = (value, keepEmptyAsUndefined = false) => {
  if (!value) {
    if (keepEmptyAsUndefined) {
      return undefined
    }
    return []
  }
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string')
  }
  if (typeof value === 'string') {
    return [value]
  }
  return []
}

const toStringList = (value) => normalizeArrayInput(value).filter((item) => item.trim().length > 0)
const toOptionalStringList = (value) => {
  const normalized = normalizeArrayInput(value, true)
  if (!Array.isArray(normalized)) {
    return undefined
  }
  return normalized.filter((item) => typeof item === 'string' && item.trim().length > 0)
}

const ensureText = (value) => {
  if (typeof value !== 'string') {
    return ''
  }
  return value
}

const extractToolText = (toolResult) => {
  if (typeof toolResult === 'string') {
    return ensureText(toolResult)
  }
  if (toolResult && Array.isArray(toolResult.content)) {
    const textChunk = toolResult.content.find((chunk) => (
      chunk &&
      chunk.type === 'text' &&
      typeof chunk.text === 'string'
    ))
    return ensureText(textChunk?.text)
  }
  return ''
}

const parseWorkflowId = (workflowResult) => {
  const text = extractToolText(workflowResult).trim()

  if (!text) {
    return null
  }

  const candidates = [
    /\*\*ID:\*\*\s*([a-f0-9][a-f0-9-]{7,})/i,
    /workflow_id(?:\s*[:=]\s*| id:\s*)([a-f0-9][a-f0-9-]{7,})/i,
    /created workflow:\s*([a-f0-9][a-f0-9-]{7,})/i,
  ]

  for (const pattern of candidates) {
    const match = text.match(pattern)
    if (match && match[1]) {
      return match[1]
    }
  }

  return null
}

const readFileContents = async (files) => {
  const contentByRelativePath = {}

  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.relativePath !== 'string') {
      continue
    }
    try {
      contentByRelativePath[file.relativePath] = await readFile(file.path, 'utf8')
    } catch (error) {
      logger.info(`Failed to read file for review unit: ${file.path}`, error.message)
      throw new Error(`Failed to read file: ${file.path}`)
    }
  }

  return contentByRelativePath
}

const getFilesByTier = (files) => {
  const counts = {
    small: 0,
    medium: 0,
    large: 0,
  }

  for (const file of files) {
    const tier = typeof file.tier === 'string' ? file.tier.toLowerCase() : 'large'
    if (counts[tier] === undefined) {
      counts.large += 1
      continue
    }
    counts[tier] += 1
  }

  return counts
}

const estimateDuration = (filesByTier) => ({
  estimated_duration: filesByTier.small * TIER_WEIGHTS.small
    + filesByTier.medium * TIER_WEIGHTS.medium
    + filesByTier.large * TIER_WEIGHTS.large,
})

const createWorkflowError = (text) => ({ error: text })

const assertRequiredDeps = (isDryRun) => {
  if (!_auditStore || !_auditStore.createAuditRun || !_auditStore.updateAuditRun) {
    return 'audit store dependency is not initialized'
  }
  if (typeof _createWorkflow !== 'function' && !isDryRun) {
    return 'createWorkflow dependency is not initialized'
  }
  return null
}

const init = ({ auditStore, createWorkflow, runWorkflow, scanProject }) => {
  _auditStore = auditStore || null
  _createWorkflow = createWorkflow || null
  _runWorkflow = runWorkflow || null
  _scanProject = scanProject || null
}

const runAudit = async ({
  path: projectPath,
  categories = null,
  subcategories = null,
  provider = null,
  model = null,
  source_dirs: sourceDirs,
  ignore_dirs: ignoreDirs,
  ignore_patterns: ignorePatterns,
  dry_run = false,
}) => {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return createWorkflowError('projectPath must be a non-empty string')
  }

  if (!Object.keys(AUDIT_CATEGORIES).length) {
    return createWorkflowError('No audit categories are configured')
  }

  const dependencyError = assertRequiredDeps(dry_run)
  if (dependencyError) {
    return createWorkflowError(dependencyError)
  }

  const safeProjectPath = path.resolve(projectPath)
  const files = await inventoryFiles(safeProjectPath, {
    sourceDirs: toOptionalStringList(sourceDirs),
    ignoreDirs: toStringList(ignoreDirs),
    ignorePatterns: toStringList(ignorePatterns),
  })

  if (files.length === 0) {
    return createWorkflowError(`No files found for project: ${safeProjectPath}`)
  }

  const categorySelections = [
    ...toStringList(categories),
    ...toStringList(subcategories),
  ]

  const selectedCategories = categorySelections.length > 0
    ? filterCategories(categorySelections)
    : getRelevantCategories(files.map((file) => file.ext))

  const preamble = (() => {
    if (typeof _scanProject !== 'function') {
      return generatePreamble('', { fileCount: files.length, projectPath: safeProjectPath })
    }

    return Promise.resolve(_scanProject({ path: safeProjectPath, checks: ['summary'] }))
      .then((scanResult) => {
        const scanText = extractToolText(scanResult)
        return generatePreamble(scanText, { fileCount: files.length, projectPath: safeProjectPath })
      })
      .catch((error) => {
        logger.info(`scanProject failed while building preamble for ${safeProjectPath}`, error.message)
        return generatePreamble('', { fileCount: files.length, projectPath: safeProjectPath })
      })
  })()

  const reviewUnits = await createReviewUnits(files)
  const filesByTier = getFilesByTier(files)
  const { estimated_duration } = estimateDuration(filesByTier)
  const categoryKeys = Object.keys(selectedCategories)

  const resolvedPreamble = await preamble

  if (dry_run) {
    return {
      dry_run: true,
      total_files: files.length,
      task_count: reviewUnits.length,
      files_by_tier: filesByTier,
      categories: categoryKeys,
      estimated_duration,
    }
  }

  const runRecord = _auditStore.createAuditRun({
    project_path: safeProjectPath,
    categories: categoryKeys,
    provider,
  })
  const auditRunId = typeof runRecord === 'string'
    ? runRecord
    : runRecord?.id

  if (!auditRunId) {
    return createWorkflowError('Failed to create audit run')
  }

  const fileContents = await readFileContents(files)

  const workflowTasks = reviewUnits.map((unit) => {
    const tags = [
      `audit:${auditRunId}`,
      `unit:${unit.id}`,
    ]
    const taskDescription = buildReviewPrompt({
      unit,
      preamble: resolvedPreamble,
      categories: selectedCategories,
      fileContents,
    })
    const taskPayload = {
      node_id: `audit-unit-${unit.id}`,
      task_description: taskDescription,
      tags,
    }

    if (provider) {
      taskPayload.provider = provider
    }
    if (model) {
      taskPayload.model = model
    }

    return taskPayload
  })

  const workflowName = `audit-${String(auditRunId).slice(0, 8)}`
  const workflowDescription = `Audit run for ${safeProjectPath} (${files.length} files, ${reviewUnits.length} tasks)`
  const workflowResult = await _createWorkflow({
    name: workflowName,
    description: workflowDescription,
    working_directory: safeProjectPath,
    tasks: workflowTasks,
  })
  const workflowId = parseWorkflowId(workflowResult)
    || runRecord?.workflow_id
    || String(auditRunId)

  _auditStore.updateAuditRun(auditRunId, {
    status: 'running',
    workflow_id: workflowId,
    total_files: files.length,
  })

  if (typeof _runWorkflow === 'function') {
    await _runWorkflow({ workflow_id: workflowId })
  }

  return {
    audit_run_id: auditRunId,
    workflow_id: workflowId,
    task_count: reviewUnits.length,
    total_files: files.length,
    categories: categoryKeys,
    estimated_duration,
    status: 'running',
  }
}

module.exports = {
  init,
  runAudit,
}
