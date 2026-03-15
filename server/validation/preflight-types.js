'use strict';

/**
 * Pre-Flight Type Validation for hashline-ollama
 *
 * Parses the IMPORTED TYPE SIGNATURES string from buildImportContext()
 * into structured data, cross-checks the task description against them,
 * and generates correction hints for the LLM prompt.
 *
 * Warn, don't reject — the task always proceeds.
 */

// ─── parseTypeSignatures ────────────────────────────────────────────────

/**
 * Parse the raw "### IMPORTED TYPE SIGNATURES" block into structured data.
 *
 * Input: the string returned by buildImportContext() (max ~4KB).
 * Output: { enums: [...], interfaces: [...], types: [...] }
 *
 * @param {string} signatureString — raw import context block
 * @returns {{ enums: Array, interfaces: Array, types: Array }}
 */
function parseTypeSignatures(signatureString) {
  const result = { enums: [], interfaces: [], types: [], classes: [] };
  if (!signatureString || typeof signatureString !== 'string') return result;

  // Split into per-file sections by "// filepath" comment lines
  const sections = [];
  let currentFile = '';
  let currentLines = [];

  for (const line of signatureString.split('\n')) {
    const fileMatch = line.match(/^\/\/\s+(.+)/);
    if (fileMatch) {
      if (currentFile && currentLines.length > 0) {
        sections.push({ file: currentFile, body: currentLines.join('\n') });
      }
      currentFile = fileMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentFile && currentLines.length > 0) {
    sections.push({ file: currentFile, body: currentLines.join('\n') });
  }

  for (const section of sections) {
    // Extract enum blocks
    const enumRegex = /export\s+enum\s+(\w+)\s*\{([^}]*)}/g;
    let m;
    while ((m = enumRegex.exec(section.body)) !== null) {
      const name = m[1];
      const body = m[2];
      // Members: "  Weekly = 'weekly'," or "  Value = 0,"
      const members = [];
      for (const memberLine of body.split('\n')) {
        const memberMatch = memberLine.trim().match(/^(\w+)\s*(?:=|,|$)/);
        if (memberMatch && memberMatch[1]) {
          members.push(memberMatch[1]);
        }
      }
      result.enums.push({ name, file: section.file, members });
    }

    // Extract interface blocks
    const ifaceRegex = /export\s+(?:interface|abstract\s+class)\s+(\w+)(?:\s+extends\s+\w+)?\s*\{([^}]*)}/g;
    while ((m = ifaceRegex.exec(section.body)) !== null) {
      const name = m[1];
      const body = m[2];
      const fields = [];
      for (const fieldLine of body.split('\n')) {
        const fieldMatch = fieldLine.trim().match(/^(\w+)\s*[?:]/)
        if (fieldMatch && fieldMatch[1]) {
          fields.push(fieldMatch[1]);
        }
      }
      result.interfaces.push({ name, file: section.file, fields });
    }

    // Extract type aliases: export type Foo = 'a' | 'b' | ...;
    const typeRegex = /export\s+type\s+(\w+)\s*=\s*(.+?)(?:;|$)/gm;
    while ((m = typeRegex.exec(section.body)) !== null) {
      const name = m[1];
      const definition = m[2].trim();
      result.types.push({ name, file: section.file, definition });
    }

    // Extract class blocks (export class / export abstract class)
    const classRegex = /export\s+(?:abstract\s+)?class\s+(\w+)(?:\s+(?:extends|implements)\s+[\w,\s]+)?\s*\{([^}]*)}/g;
    while ((m = classRegex.exec(section.body)) !== null) {
      const name = m[1];
      const body = m[2];
      const methods = [];
      const fields = [];
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        // Methods: public/private/protected/abstract method(...): Type
        // Also matches: get prop(): Type, set prop(v: Type)
        const methodMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/);
        if (methodMatch && methodMatch[1] !== 'constructor') {
          methods.push(methodMatch[1]);
        }
        // Fields: public/private/protected name: Type or name?: Type
        const fieldMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:readonly\s+)?(?:static\s+)?(\w+)\s*[?:]/);
        if (fieldMatch && fieldMatch[1] && !trimmed.includes('(')) {
          fields.push(fieldMatch[1]);
        }
      }
      result.classes.push({ name, file: section.file, methods, fields });
    }
  }

  return result;
}

// ─── validateTaskAgainstTypes ───────────────────────────────────────────

/**
 * Cross-check a task description against parsed type signatures.
 * Returns hints for mismatches (wrong enum values, wrong field names, etc.).
 *
 * @param {string} taskDescription
 * @param {{ enums: Array, interfaces: Array, types: Array }} parsedTypes
 * @returns {{ hints: string[], warnings: number }}
 */
function validateTaskAgainstTypes(taskDescription, parsedTypes) {
  const hints = [];
  if (!taskDescription || !parsedTypes) return { hints, warnings: 0 };

  // Extract value-like tokens from task description
  // PascalCase, camelCase, UPPER_CASE, quoted strings
  const tokens = new Set();
  // PascalCase/camelCase words
  const wordMatches = taskDescription.match(/\b[A-Za-z_]\w*\b/g) || [];
  for (const w of wordMatches) tokens.add(w);
  // Quoted strings
  const quotedMatches = taskDescription.match(/['"]([^'"]+)['"]/g) || [];
  for (const q of quotedMatches) tokens.add(q.replace(/['"]/g, ''));

  // Check enums
  for (const enumDef of parsedTypes.enums) {
    if (!taskDescription.includes(enumDef.name)) continue;

    // Look for dotted references: EnumName.Value
    const dotPattern = new RegExp(`${enumDef.name}\\.([A-Za-z_]\\w*)`, 'g');
    let dotMatch;
    while ((dotMatch = dotPattern.exec(taskDescription)) !== null) {
      const referencedValue = dotMatch[1];
      if (!enumDef.members.some(m => m.toLowerCase() === referencedValue.toLowerCase())) {
        // Try fuzzy suggestion
        const suggestion = _fuzzyMatch(referencedValue, enumDef.members);
        const suggestionText = suggestion ? ` Did you mean "${enumDef.name}.${suggestion}"?` : '';
        hints.push(
          `${enumDef.name} has values: ${enumDef.members.join(', ')}. ` +
          `There is no "${referencedValue}" value.${suggestionText}`
        );
      }
    }
  }

  // Check interfaces
  for (const ifaceDef of parsedTypes.interfaces) {
    if (!taskDescription.includes(ifaceDef.name)) continue;

    // Look for field-like references near the interface name
    // Check all camelCase tokens that look like field names
    for (const token of tokens) {
      // Skip the interface name itself, common words, and short tokens
      if (token === ifaceDef.name || token.length < 3) continue;
      // Only check tokens that look like field names (camelCase or snake_case)
      if (!/^[a-z][a-zA-Z0-9_]*$/.test(token)) continue;
      // Skip common programming words that aren't field names
      if (['the', 'and', 'for', 'with', 'from', 'this', 'that', 'use', 'add', 'new', 'set', 'get',
           'has', 'not', 'but', 'all', 'each', 'into', 'file', 'type', 'name', 'value', 'should',
           'using', 'return', 'function', 'method', 'class', 'enum', 'interface', 'export',
           'import', 'const', 'template', 'task', 'edit', 'code', 'test', 'create', 'update',
           'delete', 'remove', 'modify', 'change'].includes(token)) continue;

      // Check if this looks like it could be referencing a field on this interface
      // Only flag if the token appears near the interface name (within ~100 chars)
      const ifaceIdx = taskDescription.indexOf(ifaceDef.name);
      const tokenIdx = taskDescription.indexOf(token);
      if (ifaceIdx === -1 || tokenIdx === -1) continue;
      if (Math.abs(ifaceIdx - tokenIdx) > 150) continue;

      // If the token doesn't match any field, and looks like a plausible field reference
      if (!ifaceDef.fields.some(f => f.toLowerCase() === token.toLowerCase())) {
        const suggestion = _fuzzyMatch(token, ifaceDef.fields);
        if (suggestion) {
          hints.push(
            `${ifaceDef.name} fields: ${ifaceDef.fields.join(', ')}. ` +
            `No "${token}" field exists. Did you mean "${suggestion}"?`
          );
        }
      }
    }
  }

  // Check classes (methods + fields)
  for (const classDef of (parsedTypes.classes || [])) {
    if (!taskDescription.includes(classDef.name)) continue;

    // Check method references: ClassName.method() or "call method on ClassName"
    const allMembers = [...classDef.methods, ...classDef.fields];
    for (const token of tokens) {
      if (token === classDef.name || token.length < 3) continue;
      if (!/^[a-z][a-zA-Z0-9_]*$/.test(token)) continue;
      if (['the', 'and', 'for', 'with', 'from', 'this', 'that', 'use', 'add', 'new', 'set', 'get',
           'has', 'not', 'but', 'all', 'each', 'into', 'file', 'type', 'name', 'value', 'should',
           'using', 'return', 'function', 'method', 'class', 'enum', 'interface', 'export',
           'import', 'const', 'template', 'task', 'edit', 'code', 'test', 'create', 'update',
           'delete', 'remove', 'modify', 'change'].includes(token)) continue;

      const classIdx = taskDescription.indexOf(classDef.name);
      const tokenIdx = taskDescription.indexOf(token);
      if (classIdx === -1 || tokenIdx === -1) continue;
      if (Math.abs(classIdx - tokenIdx) > 150) continue;

      if (!allMembers.some(m => m.toLowerCase() === token.toLowerCase())) {
        const suggestion = _fuzzyMatch(token, allMembers);
        if (suggestion) {
          const memberKind = classDef.methods.includes(suggestion) ? 'method' : 'field';
          hints.push(
            `${classDef.name} members: ${allMembers.join(', ')}. ` +
            `No "${token}" ${memberKind} exists. Did you mean "${suggestion}"?`
          );
        }
      }
    }
  }

  // Type collision: if task says "add a Foo" and Foo already exists as a type/enum/interface/class
  const addPattern = /\badd\s+(?:a\s+)?(?:new\s+)?(\w+)/gi;
  let addMatch;
  while ((addMatch = addPattern.exec(taskDescription)) !== null) {
    const name = addMatch[1];
    const existingEnum = parsedTypes.enums.find(e => e.name.toLowerCase() === name.toLowerCase());
    const existingIface = parsedTypes.interfaces.find(i => i.name.toLowerCase() === name.toLowerCase());
    const existingType = parsedTypes.types.find(t => t.name.toLowerCase() === name.toLowerCase());
    const existingClass = (parsedTypes.classes || []).find(c => c.name.toLowerCase() === name.toLowerCase());
    if (existingEnum || existingIface || existingType || existingClass) {
      const kind = existingEnum ? 'enum' : existingIface ? 'interface' : existingClass ? 'class' : 'type';
      hints.push(`"${name}" already exists as a ${kind}. Make sure you're extending it, not duplicating it.`);
    }
  }

  return { hints, warnings: hints.length };
}

/**
 * Simple fuzzy match: find the closest member by Levenshtein-like similarity.
 * Returns the best match if similarity > 0.5, else null.
 */
function _fuzzyMatch(query, candidates) {
  if (!candidates || candidates.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  const queryLower = query.toLowerCase();

  for (const candidate of candidates) {
    const candLower = candidate.toLowerCase();

    // Exact substring match
    if (candLower.includes(queryLower) || queryLower.includes(candLower)) {
      return candidate;
    }

    // Simple character overlap score
    let matches = 0;
    const shorter = queryLower.length < candLower.length ? queryLower : candLower;
    const longer = queryLower.length < candLower.length ? candLower : queryLower;
    for (const ch of shorter) {
      if (longer.includes(ch)) matches++;
    }
    const score = matches / Math.max(queryLower.length, candLower.length);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestScore > 0.5 ? bestMatch : null;
}

// ─── buildPreflightHints ────────────────────────────────────────────────

/**
 * Format validation hints into a prompt injection block.
 *
 * @param {string[]} hints — array of correction hint strings
 * @returns {string} Formatted block to inject before file context, or empty string
 */
function buildPreflightHints(hints) {
  if (!hints || hints.length === 0) return '';

  return '\n\n### TYPE VALIDATION NOTES\n' +
    'The following corrections are based on the actual type definitions:\n' +
    hints.map(h => `- ${h}`).join('\n') +
    '\nIMPORTANT: Use only the types and fields listed above.';
}

module.exports = {
  parseTypeSignatures,
  validateTaskAgainstTypes,
  buildPreflightHints,
  // Exported for testing
  _fuzzyMatch,
};
