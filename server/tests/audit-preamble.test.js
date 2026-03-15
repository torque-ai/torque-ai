'use strict'


const {
  PREAMBLE_TOKEN_BUDGET,
  estimateTokens,
  generatePreamble,
  trimToTokenBudget,
} = require("../audit/preamble")

describe("audit preamble token helpers", () => {
  it("estimateTokens('hello world') returns 3", () => {
    expect(estimateTokens("hello world")).toBe(3)
  })

  it("estimateTokens handles null and non-string inputs", () => {
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
    expect(estimateTokens(12345)).toBe(2)
  })

  it("trimToTokenBudget truncates long text to the requested budget", () => {
    const longText = "x".repeat(4000)
    const trimmed = trimToTokenBudget(longText, 100)

    expect(trimmed.length).toBe(400)
    expect(trimmed).toBe(longText.slice(0, 400))
  })

  it("trimToTokenBudget preserves short text when within budget", () => {
    const shortText = "Short scan data."
    expect(trimToTokenBudget(shortText, 100)).toBe(shortText)
  })

  it("generatePreamble includes project path and file count and stays under 600 tokens", () => {
    const scanText = "x".repeat(5000)
    const result = generatePreamble(scanText, { fileCount: 42, projectPath: "/tmp/my-project" })

    expect(result).toContain("Project path: /tmp/my-project")
    expect(result).toContain("File count: 42")
    expect(estimateTokens(result)).toBeLessThanOrEqual(600)
  })

  it("generatePreamble returns fallback copy when no scan text is provided", () => {
    const result = generatePreamble("", { fileCount: 1, projectPath: "/tmp/empty" })
    const fallback = "No scan data available. Review the code based on its contents alone."

    expect(result).toContain("Project path: /tmp/empty")
    expect(result).toContain("File count: 1")
    expect(result).toContain(fallback)
  })

  it("generatePreamble truncates very large scan text to token budget", () => {
    const hugeText = Array.from({ length: 5001 }, () => "word").join(" ")
    const projectPath = "/tmp/huge-scan"
    const fileCount = 12
    const header = `Project path: ${projectPath}\nFile count: ${fileCount}\n`
    const expectedBudget = PREAMBLE_TOKEN_BUDGET - estimateTokens(header)
    const result = generatePreamble(hugeText, { fileCount, projectPath })
    const body = result.slice(header.length)

    expect(estimateTokens(result)).toBeLessThanOrEqual(PREAMBLE_TOKEN_BUDGET)
    expect(body.length).toBeLessThanOrEqual(expectedBudget * 4)
    expect(body.length).toBeLessThan(hugeText.length)
  })
})
