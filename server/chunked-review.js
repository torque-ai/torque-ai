/**
 * Chunked Review System
 *
 * Handles reviewing large files by splitting them into manageable chunks
 * using a hybrid approach: function boundaries when possible, line-based fallback.
 */

const fs = require('fs');
const path = require('path');

// Token estimation: ~4 chars per token on average for code
const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_LIMIT = 32000; // 32k tokens
const CHUNK_OVERLAP_LINES = 50; // Lines of overlap between chunks for context
const _MIN_CHUNK_TOKENS = 2000; // Minimum chunk size to avoid too many tiny chunks

/**
 * Estimate token count from text
 * @param {string} text - The text content to estimate tokens for
 * @returns {number} - Estimated token count
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Extract function/class boundaries from JavaScript/TypeScript code
 * @param {string} content - The JavaScript/TypeScript code content
 * @returns {Array<{name: string, startLine: number, endLine: number, type: string}>} - Array of function/class boundaries
 */
function extractJSFunctions(content) {
  const lines = content.split('\n');
  const functions = [];

  // Track brace depth to find function boundaries
  let braceDepth = 0;
  let currentFunc = null;

  // Patterns for function detection
  const patterns = [
    // Named function: function name(
    /^\s*(?:async\s+)?function\s+(\w+)\s*\(/,
    // Method: name( or async name(
    /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
    // Arrow assigned: const name = (...) => or const name = async (...) =>
    /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
    // Arrow assigned single param: const name = param =>
    /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\w+\s*=>/,
    // Class declaration
    /^\s*class\s+(\w+)/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1; // 1-indexed
    const stripped = line.replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, '');

    // Count braces
    const openBraces = (stripped.match(/\{/g) || []).length;
    const closeBraces = (stripped.match(/\}/g) || []).length;

    // Check if this line starts a new function (only when not inside another)
    if (!currentFunc || braceDepth === 0) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          // End previous function if exists
          if (currentFunc && braceDepth === 0) {
            currentFunc.endLine = lineNum - 1;
            if (currentFunc.endLine >= currentFunc.startLine) {
              functions.push(currentFunc);
            }
          }

          currentFunc = {
            name: match[1],
            startLine: lineNum,
            endLine: null,
            type: line.includes('class ') ? 'class' : 'function'
          };
          break;
        }
      }
    }

    // Update brace depth
    braceDepth += openBraces - closeBraces;

    // Check if current function ended
    if (currentFunc && braceDepth === 0 && closeBraces > 0) {
      currentFunc.endLine = lineNum;
      functions.push(currentFunc);
      currentFunc = null;
    }
  }

  // Handle unclosed function at end of file
  if (currentFunc) {
    currentFunc.endLine = lines.length;
    functions.push(currentFunc);
  }

  return functions;
}

/**
 * Extract function boundaries based on file type
 * @param {string} content - The file content
 * @param {string} filePath - The file path
 * @returns {Array<{name: string, startLine: number, endLine: number, type: string}>} - Array of function boundaries
 */
function extractFunctions(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.js':
    case '.ts':
    case '.tsx':
    case '.jsx':
    case '.mjs':
      return extractJSFunctions(content);

    case '.py':
      return extractPythonFunctions(content);

    case '.cs':
      return extractCSharpFunctions(content);

    default:
      // No parser available, return empty
      return [];
  }
}

/**
 * Extract Python function/class boundaries
 * @param {string} content - The Python file content
 * @returns {Array<{name: string, startLine: number, endLine: number, type: string}>} - Array of function/class boundaries
 */
function extractPythonFunctions(content) {
  const lines = content.split('\n');
  const functions = [];

  const funcPattern = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
  const classPattern = /^(\s*)class\s+(\w+)/;

  let currentFunc = null;
  let currentIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check for function/class start
    let match = line.match(funcPattern);
    let type = 'function';
    if (!match) {
      match = line.match(classPattern);
      type = 'class';
    }

    if (match) {
      const indent = match[1].length;

      // End previous function if this is at same or lower indent
      if (currentFunc && indent <= currentIndent) {
        currentFunc.endLine = lineNum - 1;
        functions.push(currentFunc);
      }

      currentFunc = {
        name: match[2],
        startLine: lineNum,
        endLine: null,
        type: type
      };
      currentIndent = indent;
    }
  }

  // Close last function
  if (currentFunc) {
    currentFunc.endLine = lines.length;
    functions.push(currentFunc);
  }

  return functions;
}

/**
 * Extract C# method/class boundaries
 * @param {string} content - The C# file content
 * @returns {Array<{name: string, startLine: number, endLine: number, type: string}>} - Array of method/class boundaries
 */
function extractCSharpFunctions(content) {
  const lines = content.split('\n');
  const functions = [];

  // Simplified C# parsing - looks for method and class declarations
  const methodPattern = /^\s*(?:public|private|protected|internal|static|async|override|virtual|\s)+\s+\w+\s+(\w+)\s*\(/;
  const classPattern = /^\s*(?:public|private|protected|internal|static|partial|\s)*\s*class\s+(\w+)/;

  let braceDepth = 0;
  let currentFunc = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Check for new function/class
    if (!currentFunc || braceDepth <= 1) {
      let match = line.match(classPattern);
      let type = 'class';
      if (!match) {
        match = line.match(methodPattern);
        type = 'method';
      }

      if (match) {
        if (currentFunc) {
          currentFunc.endLine = lineNum - 1;
          functions.push(currentFunc);
        }

        currentFunc = {
          name: match[1],
          startLine: lineNum,
          endLine: null,
          type: type
        };
      }
    }

    braceDepth += openBraces - closeBraces;

    if (currentFunc && braceDepth === 0 && closeBraces > 0) {
      currentFunc.endLine = lineNum;
      functions.push(currentFunc);
      currentFunc = null;
    }
  }

  if (currentFunc) {
    currentFunc.endLine = lines.length;
    functions.push(currentFunc);
  }

  return functions;
}

/**
 * Group functions into chunks that fit within token limit
 * @param {Array<{name: string, startLine: number, endLine: number, type: string}>} functions - Array of function/class boundaries
 * @param {string[]} lines - Array of file lines
 * @param {number} tokenLimit - Model's context limit in tokens
 * @returns {Array<{functions: Array<string>, startLine: number, endLine: number, tokens: number, description: string}>} - Array of chunks with function names and line ranges
 */
function groupFunctionsIntoChunks(functions, lines, tokenLimit) {
  const chunks = [];
  let currentChunk = {
    functions: [],
    startLine: null,
    endLine: null,
    tokens: 0
  };

  // Add prompt overhead estimate
  const promptOverhead = 2000; // Tokens for instructions, etc.
  const effectiveLimit = tokenLimit - promptOverhead;

  for (const func of functions) {
    const funcLines = lines.slice(func.startLine - 1, func.endLine);
    const funcText = funcLines.join('\n');
    const funcTokens = estimateTokens(funcText);

    // If single function exceeds limit, it needs to be split separately
    if (funcTokens > effectiveLimit) {
      // Save current chunk if not empty
      if (currentChunk.functions.length > 0) {
        chunks.push(currentChunk);
      }

      // Mark this function as needing line-based split
      chunks.push({
        functions: [func],
        startLine: func.startLine,
        endLine: func.endLine,
        tokens: funcTokens,
        needsLineSplit: true
      });

      currentChunk = {
        functions: [],
        startLine: null,
        endLine: null,
        tokens: 0
      };
      continue;
    }

    // Check if adding this function would exceed limit
    if (currentChunk.tokens + funcTokens > effectiveLimit && currentChunk.functions.length > 0) {
      // Save current chunk and start new one
      chunks.push(currentChunk);
      currentChunk = {
        functions: [],
        startLine: null,
        endLine: null,
        tokens: 0
      };
    }

    // Add function to current chunk
    currentChunk.functions.push(func);
    currentChunk.tokens += funcTokens;

    if (currentChunk.startLine === null) {
      currentChunk.startLine = func.startLine;
    }
    currentChunk.endLine = func.endLine;
  }

  // Don't forget last chunk
  if (currentChunk.functions.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Create line-based chunks when function parsing fails or functions are too large
 * @param {string} content - The file content
 * @param {number} tokenLimit - Model's context limit in tokens
 * @returns {Array<{startLine: number, endLine: number, tokens: number, isLineBased: boolean}>} - Array of line-based chunks with line ranges and token counts
 */
function createLineBasedChunks(content, tokenLimit) {
  const lines = content.split('\n');
  const totalTokens = estimateTokens(content);

  // Add prompt overhead, ensuring effectiveLimit is always positive
  const promptOverhead = 2000;
  const effectiveLimit = Math.max(tokenLimit - promptOverhead, 500);

  // Calculate how many chunks we need
  const numChunks = Math.max(1, Math.ceil(totalTokens / effectiveLimit));
  const linesPerChunk = Math.ceil(lines.length / numChunks);

  const chunks = [];

  for (let i = 0; i < numChunks; i++) {
    const startLine = Math.max(1, i * linesPerChunk - CHUNK_OVERLAP_LINES + 1);
    const endLine = Math.min(lines.length, (i + 1) * linesPerChunk + CHUNK_OVERLAP_LINES);

    const chunkLines = lines.slice(startLine - 1, endLine);
    const chunkText = chunkLines.join('\n');

    chunks.push({
      startLine,
      endLine,
      tokens: estimateTokens(chunkText),
      isLineBased: true
    });
  }

  return chunks;
}

/**
 * Main function: Generate review chunks for a file
 *
 * @param {string} filePath - Path to the file
 * @param {number} tokenLimit - Model's context limit in tokens
 * @returns {Object} - { chunks, strategy, totalTokens, needsChunking }
 */
function generateReviewChunks(filePath, tokenLimit = DEFAULT_CONTEXT_LIMIT) {
  // Read file
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { error: `Cannot read file: ${err.message}` };
  }

  const lines = content.split('\n');
  const totalTokens = estimateTokens(content);

  // Check if chunking is needed
  const promptOverhead = 2000;
  if (totalTokens + promptOverhead <= tokenLimit) {
    return {
      needsChunking: false,
      totalTokens,
      totalLines: lines.length,
      chunks: [{
        startLine: 1,
        endLine: lines.length,
        tokens: totalTokens,
        description: 'Full file'
      }]
    };
  }

  // Try function-based chunking first
  const functions = extractFunctions(content, filePath);

  let chunks;
  let strategy;

  if (functions.length > 0) {
    // Group functions into chunks
    const functionChunks = groupFunctionsIntoChunks(functions, lines, tokenLimit);

    // Check if any chunks need line-based splitting
    const needsLineSplit = functionChunks.some(c => c.needsLineSplit);

    if (needsLineSplit) {
      // Some functions too large - use hybrid approach
      strategy = 'hybrid';
      chunks = [];

      for (const chunk of functionChunks) {
        if (chunk.needsLineSplit) {
          // Split this large function by lines
          const funcContent = lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
          const lineChunks = createLineBasedChunks(funcContent, tokenLimit);

          // Adjust line numbers to be relative to original file
          for (const lc of lineChunks) {
            chunks.push({
              startLine: chunk.startLine + lc.startLine - 1,
              endLine: chunk.startLine + lc.endLine - 1,
              tokens: lc.tokens,
              description: `Lines ${chunk.startLine + lc.startLine - 1}-${chunk.startLine + lc.endLine - 1} (large function split)`
            });
          }
        } else {
          // Function-based chunk
          const funcNames = chunk.functions.map(f => f.name).join(', ');
          chunks.push({
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            tokens: chunk.tokens,
            functions: chunk.functions.map(f => f.name),
            description: `Functions: ${funcNames.slice(0, 100)}${funcNames.length > 100 ? '...' : ''}`
          });
        }
      }
    } else {
      // Pure function-based chunking worked
      strategy = 'function-based';
      chunks = functionChunks.map(chunk => {
        const funcNames = chunk.functions.map(f => f.name).join(', ');
        return {
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          tokens: chunk.tokens,
          functions: chunk.functions.map(f => f.name),
          description: `Functions: ${funcNames.slice(0, 100)}${funcNames.length > 100 ? '...' : ''}`
        };
      });
    }
  } else {
    // No functions found - use line-based chunking
    strategy = 'line-based';
    chunks = createLineBasedChunks(content, tokenLimit);

    // Add descriptions
    chunks = chunks.map((c) => ({
      ...c,
      description: `Lines ${c.startLine}-${c.endLine}`
    }));
  }

  return {
    needsChunking: true,
    strategy,
    totalTokens,
    totalLines: lines.length,
    tokenLimit,
    chunks
  };
}

/**
 * Generate review task descriptions for each chunk
 * @param {string} filePath - Path to the file
 * @param {string} baseTask - Base task description
 * @param {Object} chunkInfo - Chunking information object
 * @param {Array} chunkInfo.chunks - Array of chunk objects
 * @param {boolean} chunkInfo.needsChunking - Whether chunking is needed
 * @param {number} chunkInfo.totalTokens - Total token count
 * @param {number} chunkInfo.totalLines - Total line count
 * @param {number} chunkInfo.tokenLimit - Token limit
 * @returns {Array} - Array of task objects
 */
function generateChunkTasks(filePath, baseTask, chunkInfo) {
  if (!chunkInfo.needsChunking) {
    return [{
      task: baseTask,
      chunk: null
    }];
  }

  const fileName = path.basename(filePath);
  const tasks = [];

  for (let i = 0; i < chunkInfo.chunks.length; i++) {
    const chunk = chunkInfo.chunks[i];
    const chunkNum = i + 1;
    const totalChunks = chunkInfo.chunks.length;

    // Build chunk-specific task description
    let taskDesc = baseTask.replace(fileName, `${fileName} (Part ${chunkNum}/${totalChunks})`);
    taskDesc += `\n\n**IMPORTANT: Review ONLY lines ${chunk.startLine}-${chunk.endLine}**`;

    if (chunk.functions && chunk.functions.length > 0) {
      taskDesc += `\nFunctions in this section: ${chunk.functions.join(', ')}`;
    }

    taskDesc += `\n\nThis is part of a chunked review. Focus only on this section.`;

    tasks.push({
      task: taskDesc,
      chunk: {
        number: chunkNum,
        total: totalChunks,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        description: chunk.description
      }
    });
  }

  return tasks;
}

/**
 * Create an aggregation task to combine chunk review results
 * @param {string} filePath - Path to the file
 * @param {number} chunkCount - Number of chunks to aggregate
 * @param {Array<string>} chunkTaskIds - Array of chunk task IDs to aggregate
 * @returns {Object} - Aggregation task object
 */
function generateAggregationTask(filePath, chunkCount, chunkTaskIds) {
  const fileName = path.basename(filePath);

  return {
    task: `Aggregate and summarize the ${chunkCount} chunk reviews for ${fileName}.

Combine the findings from all chunk reviews into a single comprehensive report:
1. Group similar issues together
2. Identify any cross-chunk patterns or issues
3. Prioritize by severity (Critical, High, Medium, Low)
4. Remove any duplicates from chunk overlaps
5. Provide a final summary with total issue count

Chunk task IDs to aggregate: ${chunkTaskIds.join(', ')}`,
    isAggregation: true,
    chunkTaskIds
  };
}

module.exports = {
  estimateTokens,
  extractFunctions,
  extractJSFunctions,
  generateReviewChunks,
  generateChunkTasks,
  generateAggregationTask,
  DEFAULT_CONTEXT_LIMIT,
  CHARS_PER_TOKEN
};
