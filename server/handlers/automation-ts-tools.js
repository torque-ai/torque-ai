/**
 * TypeScript structural tools and Headwaters convenience wrappers.
 * Extracted from automation-handlers.js — Part 2 decomposition.
 *
 * Contains:
 * - Universal TS tools: add_ts_interface_members, inject_class_dependency, etc.
 * - Semantic TS tools: add_ts_method_to_class, replace_ts_method_body, add_import_statement
 * - Validation/audit: validate_event_consistency, audit_class_completeness, normalize_interface_formatting
 * - Headwaters wrappers: wire_system_to_gamescene, wire_events_to_eventsystem, wire_notifications_to_bridge
 */

const path = require('path');
const fs = require('fs');
const { ErrorCodes, makeError, isPathTraversalSafe } = require('./shared');
const logger = require('../logger').child({ component: 'automation-ts-tools' });

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Universal Tools ────────────────────────────────────────────────────────

/**
 * UNIVERSAL: Add members to any TypeScript interface in any file.
 * Works for any project. Validates no duplicates. Consistent indentation.
 */
function handleAddTsInterfaceMembers(args) {
  const filePath = args.file_path;
  const interfaceName = args.interface_name;
  const members = args.members; // Array of { name: string, type_definition: string } OR { name, payload: {field: type} }
  const indent = args.indent || '  ';

  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath || !interfaceName || !members || !Array.isArray(members) || members.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path, interface_name, and members array are required');
  }
  if (!members.every((m) => m && typeof m === 'object' && typeof m.name === 'string')) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Each member must include a string name');
  }
  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');

  // Check for duplicates
  const duplicates = [];
  for (const m of members) {
    const name = m.name;
    const keyPattern = new RegExp(`^\\s*${escapeRegex(name)}\\s*:`, 'm');
    if (keyPattern.test(content)) duplicates.push(name);
  }
  if (duplicates.length > 0) {
    return makeError(ErrorCodes.CONFLICT, `Duplicate members already exist in ${interfaceName}: ${duplicates.join(', ')}`);
  }

  // Find the interface by name (supports 'export interface X {' and 'interface X {')
  const interfacePattern = new RegExp(`(?:export\\s+)?interface\\s+${escapeRegex(interfaceName)}\\s*(?:extends[^{]*)?\\{`);
  const ifaceMatch = interfacePattern.exec(content);
  if (!ifaceMatch) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Could not find interface ${interfaceName} in ${filePath}`);
  }

  // Find closing brace by counting braces
  let braceDepth = 0;
  let closingBraceIndex = -1;
  for (let i = content.indexOf('{', ifaceMatch.index); i < content.length; i++) {
    if (content[i] === '{') braceDepth++;
    if (content[i] === '}') {
      braceDepth--;
      if (braceDepth === 0) { closingBraceIndex = i; break; }
    }
  }
  if (closingBraceIndex === -1) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Could not find closing brace of ${interfaceName}`);
  }

  // Build entries
  let newEntries = '';
  for (const m of members) {
    // Support both { name, type_definition } and { name, payload } formats
    if (m.type_definition) {
      newEntries += `${indent}${m.name}: ${m.type_definition};\n`;
    } else if (m.payload) {
      const fields = Object.entries(m.payload);
      if (fields.length <= 3) {
        const fieldStr = fields.map(([k, v]) => `${k}: ${v}`).join('; ');
        newEntries += `${indent}${m.name}: { ${fieldStr} };\n`;
      } else {
        newEntries += `${indent}${m.name}: {\n`;
        for (const [k, v] of fields) {
          newEntries += `${indent}${indent}${k}: ${v};\n`;
        }
        newEntries += `${indent}};\n`;
      }
    }
  }

  content = content.slice(0, closingBraceIndex) + newEntries + content.slice(closingBraceIndex);
  fs.writeFileSync(filePath, content, 'utf8');

  return {
    content: [{
      type: 'text',
      text: `## Added ${members.length} members to ${interfaceName}\n\n` +
        `**File:** ${filePath}\n\n` +
        members.map(m => `- \`${m.name}\``).join('\n') + '\n'
    }],
  };
}

/**
 * UNIVERSAL: Inject a class dependency into any TypeScript class file.
 * Inserts: import, field, initialization line, and optional getter.
 * Uses configurable anchor patterns with sensible defaults.
 */
function handleInjectClassDependency(args) {
  const filePath = args.file_path;
  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  }
  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  const importStatement = args.import_statement;   // e.g., 'import { FooService } from "./FooService";'
  const fieldDeclaration = args.field_declaration;   // e.g., 'private fooService!: FooService;'
  const initCode = args.initialization;              // e.g., 'this.fooService = new FooService();'
  const getterCode = args.getter;                    // optional multi-line getter string
  const skipDuplicate = args.skip_if_exists !== false;

  if (!importStatement || !fieldDeclaration || !initCode) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'import_statement, field_declaration, and initialization are required');
  }

  // Configurable anchors with sensible defaults
  const anchors = args.anchors || {};
  const importAfter = anchors.import_after || null;      // regex string: insert import after last line matching this
  const fieldBefore = anchors.field_before || null;       // regex string: insert field before first line matching this
  const initAfter = anchors.init_after || null;           // regex string: insert init after last line matching this
  const getterBefore = anchors.getter_before || null;     // regex string: insert getter before first line matching this

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Check if already present
  if (skipDuplicate) {
    // Extract class name from import statement
    const classMatch = importStatement.match(/import\s*\{\s*(\w+)/);
    if (classMatch && content.includes(`import { ${classMatch[1]} }`)) {
      return { content: [{ type: 'text', text: `${classMatch[1]} is already imported in ${path.basename(filePath)} — skipping.` }] };
    }
  }

  const results = [];

  // 1. Insert import
  let importIdx = -1;
  if (importAfter) {
    const re = new RegExp(escapeRegex(importAfter));
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) importIdx = i;
    }
  }
  if (importIdx === -1) {
    // Default: after last import line
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('import ')) importIdx = i;
    }
  }
  if (importIdx === -1) {
    return makeError(ErrorCodes.OPERATION_FAILED, 'Could not find import insertion point');
  }
  lines.splice(importIdx + 1, 0, importStatement);
  results.push(`Import: \`${importStatement}\``);

  // 2. Insert field
  let fieldIdx = -1;
  if (fieldBefore) {
    const re = new RegExp(escapeRegex(fieldBefore));
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { fieldIdx = i; break; }
    }
  }
  if (fieldIdx === -1) {
    // Default: before constructor
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*constructor\s*\(/.test(lines[i])) { fieldIdx = i; break; }
    }
  }
  if (fieldIdx === -1) {
    // Fallback: before first method
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(public|private|protected)\s+\w+\s*\(/.test(lines[i])) { fieldIdx = i; break; }
    }
  }
  if (fieldIdx !== -1) {
    // Detect indentation from surrounding lines
    const existingIndent = lines[fieldIdx].match(/^(\s*)/)?.[1] || '  ';
    const indentedField = fieldDeclaration.startsWith(' ') ? fieldDeclaration : `${existingIndent}${fieldDeclaration}`;
    lines.splice(fieldIdx, 0, indentedField);
    results.push(`Field: \`${fieldDeclaration.trim()}\``);
  }

  // 3. Insert initialization
  let initIdx = -1;
  if (initAfter) {
    const re = new RegExp(escapeRegex(initAfter));
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) initIdx = i;
    }
  }
  if (initIdx === -1) {
    // Default: find last `this.xxx = new` line
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*this\.\w+\s*=\s*new\s+/.test(lines[i])) initIdx = i;
    }
  }
  if (initIdx !== -1) {
    const existingIndent = lines[initIdx].match(/^(\s*)/)?.[1] || '    ';
    const indentedInit = initCode.startsWith(' ') ? initCode : `${existingIndent}${initCode}`;
    lines.splice(initIdx + 1, 0, indentedInit);
    results.push(`Init: \`${initCode.trim()}\``);
  }

  // 4. Insert getter (optional)
  if (getterCode) {
    let getterIdx = -1;
    if (getterBefore) {
      const re = new RegExp(escapeRegex(getterBefore));
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { getterIdx = i; break; }
      }
    }
    if (getterIdx === -1) {
      // Default: before first private method
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*private\s+\w+\s*\(/.test(lines[i])) { getterIdx = i; break; }
      }
    }
    if (getterIdx !== -1) {
      const getterLines = getterCode.split('\n');
      lines.splice(getterIdx, 0, '', ...getterLines);
      results.push(`Getter added`);
    }
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  return {
    content: [{
      type: 'text',
      text: `## Injected dependency into ${path.basename(filePath)}\n\n` +
        results.map(r => `- ✓ ${r}`).join('\n') + '\n'
    }],
  };
}

/**
 * UNIVERSAL: Add members to any TypeScript union type in any file.
 * Validates no duplicates.
 */
function handleAddTsUnionMembers(args) {
  const filePath = args.file_path;
  const typeName = args.type_name;
  const members = args.members; // Array of strings or objects with `name` field

  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath || !typeName || !members || !Array.isArray(members) || members.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path, type_name, and members array are required');
  }
  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  const normalizedMembers = members.map((member) => (typeof member === 'string' ? member : member?.name));
  if (!normalizedMembers.every((member) => typeof member === 'string' && member.length > 0)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Each union member must be an object with a name string');
  }

  let content = fs.readFileSync(filePath, 'utf8');

  // Check for duplicates
  const duplicates = normalizedMembers.filter(m => content.includes(`"${m}"`));
  if (duplicates.length > 0) {
    return makeError(ErrorCodes.CONFLICT, `Duplicate members already exist in ${typeName}: ${duplicates.join(', ')}`);
  }

  // Find the target union type declaration, then its last `| "xxx"` entry
  const typeStartPattern = new RegExp(`(?:export\\s+)?type\\s+${escapeRegex(typeName)}\\s*=`);
  const typeStartMatch = typeStartPattern.exec(content);
  if (!typeStartMatch) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Could not find type '${typeName}' in ${filePath}`);
  }

  // Search for union entries only within this type (up to the terminating semicolon)
  const afterType = content.slice(typeStartMatch.index);
  const semiIdx = afterType.indexOf(';', typeStartMatch[0].length);
  if (semiIdx < 0) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Could not find union type ending pattern for '${typeName}' in ${filePath}`);
  }
  const unionBody = afterType.slice(0, semiIdx);
  const entryPattern = /(\s*\| "[^"]+")/g;
  let lastUnionMatch = null;
  let entryMatch;
  while ((entryMatch = entryPattern.exec(unionBody)) !== null) {
    lastUnionMatch = entryMatch;
  }

  if (!lastUnionMatch) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Could not find union type ending pattern for '${typeName}' in ${filePath}`);
  }

  const absolutePos = typeStartMatch.index + lastUnionMatch.index + lastUnionMatch[1].length;
  const newEntries = normalizedMembers.map(m => `\n  | "${m}"`).join('');
  content = content.slice(0, absolutePos) + newEntries + content.slice(absolutePos);

  fs.writeFileSync(filePath, content, 'utf8');

  return {
    content: [{
      type: 'text',
      text: `## Added ${members.length} members to ${typeName}\n\n` +
        `**File:** ${filePath}\n\n` +
        members.map(m => `- \`"${m}"\``).join('\n') + '\n'
    }],
  };
}

/**
 * UNIVERSAL: Insert code into a method body before a marker line.
 * Works for any file, any method. Pure string insertion.
 */
function handleInjectMethodCalls(args) {
  const filePath = args.file_path;
  const marker = args.before_marker;  // String to find, e.g., "this.connected = true;"
  const code = args.code;             // Code block to insert (string, can be multi-line)

  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath || !marker || !code) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path, before_marker, and code are required');
  }
  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');
  const markerPos = content.indexOf(marker);
  if (markerPos === -1) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Marker "${marker}" not found in ${filePath}`);
  }

  // Collapse excessive blank lines before the marker to at most one
  const before = content.slice(0, markerPos).replace(/\n{3,}$/, '\n\n');
  // Only add trailing newline if code doesn't already end with one
  const separator = code.endsWith('\n') ? '' : '\n';
  content = before + code + separator + content.slice(markerPos);
  fs.writeFileSync(filePath, content, 'utf8');

  const lineCount = code.split('\n').length;
  return {
    content: [{
      type: 'text',
      text: `## Injected ${lineCount} lines into ${path.basename(filePath)}\n\nInserted before: \`${marker.trim()}\`\n`
    }],
  };
}

/**
 * UNIVERSAL: Add members to any TypeScript enum in any file.
 * Supports string enums (Foo = "foo") and numeric enums (Foo = 1).
 * Validates no duplicates.
 */
function handleAddTsEnumMembers(args) {
  const filePath = args.file_path;
  const enumName = args.enum_name;
  const members = args.members; // Array of { name: string, value: string|number }

  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath || !enumName || !members || !Array.isArray(members) || members.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path, enum_name, and members array are required');
  }
  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');

  // Check for duplicates
  const duplicates = members.filter(m => {
    const pattern = new RegExp(`\\b${escapeRegex(m.name)}\\s*=`);
    return pattern.test(content);
  });
  if (duplicates.length > 0) {
    return makeError(ErrorCodes.CONFLICT, `Duplicate enum members already exist: ${duplicates.map(d => d.name).join(', ')}`);
  }

  // Find the enum
  const enumPattern = new RegExp(`(?:export\\s+)?enum\\s+${escapeRegex(enumName)}\\s*\\{`);
  const enumMatch = enumPattern.exec(content);
  if (!enumMatch) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Could not find enum ${enumName} in ${filePath}`);
  }

  // Find closing brace
  let braceDepth = 0;
  let closingBraceIndex = -1;
  for (let i = content.indexOf('{', enumMatch.index); i < content.length; i++) {
    if (content[i] === '{') braceDepth++;
    if (content[i] === '}') {
      braceDepth--;
      if (braceDepth === 0) { closingBraceIndex = i; break; }
    }
  }
  if (closingBraceIndex === -1) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Could not find closing brace of enum ${enumName}`);
  }

  // Build new entries
  let newEntries = '';
  for (const m of members) {
    const valueStr = typeof m.value === 'string' ? `"${m.value}"` : String(m.value);
    newEntries += `  ${m.name} = ${valueStr},\n`;
  }

  content = content.slice(0, closingBraceIndex) + newEntries + content.slice(closingBraceIndex);
  fs.writeFileSync(filePath, content, 'utf8');

  return {
    content: [{
      type: 'text',
      text: `## Added ${members.length} members to enum ${enumName}\n\n` +
        `**File:** ${filePath}\n\n` +
        members.map(m => `- \`${m.name} = ${typeof m.value === 'string' ? '"' + m.value + '"' : m.value}\``).join('\n') + '\n'
    }],
  };
}

// ─── Validation & Audit ─────────────────────────────────────────────────────

/**
 * Static analysis: cross-check emit() calls against GameEvents interface
 * and NotificationEvent union. Zero LLM cost.
 */
function handleValidateEventConsistency(args) {
  const workDir = args.working_directory;
  if (!workDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const eventSystemPath = args.event_system_path || path.join(workDir, 'src', 'systems', 'EventSystem.ts');
  const bridgePath = args.bridge_path || path.join(workDir, 'src', 'systems', 'NotificationBridge.ts');
  const srcDir = args.source_dir || path.join(workDir, 'src');
  if (args.event_system_path && !isPathTraversalSafe(args.event_system_path)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'event_system_path contains path traversal');
  }
  if (args.bridge_path && !isPathTraversalSafe(args.bridge_path)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'bridge_path contains path traversal');
  }
  if (args.source_dir && !isPathTraversalSafe(args.source_dir)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'source_dir contains path traversal');
  }

  const layout = {
    event_system_path: eventSystemPath,
    event_system_exists: fs.existsSync(eventSystemPath),
    bridge_path: bridgePath,
    bridge_exists: fs.existsSync(bridgePath),
    source_dir: srcDir,
    source_dir_exists: fs.existsSync(srcDir),
  };
  const usedDefaultContractPaths = !args.event_system_path && !args.bridge_path;

  let output = '## Event Consistency Validation\n\n';
  const issues = [];
  let status = 'ok';

  if (!layout.event_system_exists) {
    status = usedDefaultContractPaths && !layout.bridge_exists
      ? 'unsupported_layout'
      : 'missing_event_contract';
    issues.push({
      severity: 'warning',
      code: status,
      message: usedDefaultContractPaths && !layout.bridge_exists
        ? `Canonical TypeScript event contract files were not found at ${eventSystemPath} and ${bridgePath}.`
        : `Event contract file not found: ${eventSystemPath}.`,
    });
  }

  if (!layout.source_dir_exists) {
    if (status === 'ok') {
      status = 'missing_source_dir';
    }
    issues.push({
      severity: 'warning',
      code: 'missing_source_dir',
      message: `Source directory not found: ${srcDir}.`,
    });
  }

  output += `**Status:** ${status}\n`;
  output += `**Event contract path:** ${eventSystemPath} (${layout.event_system_exists ? 'found' : 'missing'})\n`;
  output += `**Notification bridge path:** ${bridgePath} (${layout.bridge_exists ? 'found' : 'missing'})\n`;
  output += `**Source directory:** ${srcDir} (${layout.source_dir_exists ? 'found' : 'missing'})\n\n`;

  // 1. Parse GameEvents interface keys
  const declaredEvents = new Set();
  if (layout.event_system_exists) {
    const esContent = fs.readFileSync(eventSystemPath, 'utf8');
    // Only match keys inside the GameEvents interface
    const ifaceStart = esContent.indexOf('export interface GameEvents {');
    if (ifaceStart !== -1) {
      let braceDepth = 0;
      let inInterface = false;
      const lines = esContent.split('\n');
      for (const line of lines) {
        if (!inInterface && line.includes('export interface GameEvents {')) {
          inInterface = true;
          braceDepth = 1;
          continue;
        }
        if (inInterface) {
          for (const ch of line) {
            if (ch === '{') braceDepth++;
            if (ch === '}') braceDepth--;
          }
          if (braceDepth <= 0) break;
          const keyMatch = line.match(/^\s*(\w+)\s*:/);
          if (keyMatch) declaredEvents.add(keyMatch[1]);
        }
      }
    }
    output += `**Declared events in GameEvents:** ${declaredEvents.size}\n`;
  } else {
    output += `**Declared events in GameEvents:** unavailable\n`;
  }

  // 2. Scan all .ts files for emit() calls
  const emittedEvents = new Map(); // event_name -> [file, ...]
  function scanForEmits(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__tests__' || entry.name === 'dist') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanForEmits(fullPath);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const emitPattern = /\.emit\(\s*["'](\w+)["']/g;
          let match;
          while ((match = emitPattern.exec(content)) !== null) {
            const eventName = match[1];
            if (!emittedEvents.has(eventName)) emittedEvents.set(eventName, []);
            const relPath = path.relative(workDir, fullPath).replace(/\\/g, '/');
            if (!emittedEvents.get(eventName).includes(relPath)) {
              emittedEvents.get(eventName).push(relPath);
            }
          }
        } catch (err) {
          logger.debug('[automation-ts-tools] non-critical error scanning unreadable source file:', err.message || err);
        }
      }
    }
  }
  if (layout.source_dir_exists) {
    scanForEmits(srcDir);
    output += `**Events emitted in source:** ${emittedEvents.size}\n`;
  } else {
    output += `**Events emitted in source:** unavailable\n`;
  }

  // 3. Parse NotificationEvent union type
  const notificationEvents = new Set();
  if (layout.bridge_exists) {
    const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
    const unionPattern = /"\s*(\w+)\s*"/g;
    const typeStart = bridgeContent.indexOf('type NotificationEvent');
    if (typeStart !== -1) {
      const typeEnd = bridgeContent.indexOf(';', typeStart);
      const typeBlock = bridgeContent.substring(typeStart, typeEnd);
      let match;
      while ((match = unionPattern.exec(typeBlock)) !== null) {
        notificationEvents.add(match[1]);
      }
    }
    output += `**NotificationEvent members:** ${notificationEvents.size}\n\n`;
  } else {
    output += `**NotificationEvent members:** unavailable\n\n`;
  }

  // 4. Cross-check: emitted but not declared
  output += '### Issues\n\n';
  if (!layout.event_system_exists || !layout.source_dir_exists) {
    for (const issue of issues) {
      output += `- **${issue.severity.toUpperCase()}:** ${issue.message}\n`;
    }
  } else {
    for (const [eventName, files] of emittedEvents) {
      if (!declaredEvents.has(eventName)) {
        issues.push({ severity: 'error', message: `"${eventName}" is emitted but NOT declared in GameEvents`, files });
        output += `- **ERROR:** \`${eventName}\` emitted in ${files.join(', ')} but missing from GameEvents interface\n`;
      }
    }

    // 5. Cross-check: declared but never emitted
    for (const eventName of declaredEvents) {
      if (!emittedEvents.has(eventName)) {
        issues.push({ severity: 'warning', message: `"${eventName}" is declared in GameEvents but never emitted` });
        output += `- **WARN:** \`${eventName}\` declared in GameEvents but never emitted by any source file\n`;
      }
    }

    // 6. Cross-check: NotificationEvent members not in GameEvents
    for (const eventName of notificationEvents) {
      if (!declaredEvents.has(eventName)) {
        issues.push({ severity: 'error', message: `"${eventName}" in NotificationEvent but NOT in GameEvents` });
        output += `- **ERROR:** \`${eventName}\` in NotificationEvent union but missing from GameEvents interface\n`;
      }
    }
  }

  if (issues.length === 0 && status === 'ok') {
    output += '**All clear!** No inconsistencies found.\n';
  } else if (status !== 'ok' && issues.length > 0) {
    output += `**Layout status:** ${status}. Consistency checks are limited until the missing contract files are supplied.\n`;
  }

  output += `\n### Summary: ${issues.filter(i => i.severity === 'error').length} errors, ${issues.filter(i => i.severity === 'warning').length} warnings\n`;

  return {
    content: [{ type: 'text', text: output }],
    _issues: issues,
    _status: status,
    _layout: layout,
    _stats: { declared: declaredEvents.size, emitted: emittedEvents.size, notifications: notificationEvents.size },
  };
}

/**
 * Normalize indentation in a TypeScript interface. Fixes accumulated drift
 * from multiple batch edits. Idempotent.
 */
function handleNormalizeInterfaceFormatting(args) {
  const filePath = args.file_path;
  const interfaceName = args.interface_name;
  const targetIndent = args.indent || '  ';

  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath || !interfaceName) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path and interface_name are required');
  }
  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Find interface boundaries
  let inInterface = false;
  let braceDepth = 0;
  let startLine = -1;
  let _endLine = -1;
  const reformattedLines = [];
  let fixCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!inInterface && lines[i].includes(`interface ${interfaceName}`) && lines[i].includes('{')) {
      inInterface = true;
      braceDepth = 1;
      reformattedLines.push(lines[i]);
      startLine = i;
      continue;
    }

    if (inInterface) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }

      if (braceDepth <= 0) {
        reformattedLines.push('}');
        _endLine = i;
        inInterface = false;
        continue;
      }

      const trimmed = line.trim();
      if (trimmed === '') {
        reformattedLines.push('');
        continue;
      }

      const properIndent = targetIndent.repeat(braceDepth);
      const normalized = properIndent + trimmed;

      if (normalized !== line) fixCount++;
      reformattedLines.push(normalized);
    } else {
      reformattedLines.push(lines[i]);
    }
  }

  if (startLine === -1) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Could not find interface ${interfaceName} in ${filePath}`);
  }

  fs.writeFileSync(filePath, reformattedLines.join('\n'), 'utf8');

  return {
    content: [{
      type: 'text',
      text: `## Normalized ${interfaceName} formatting\n\n` +
        `**File:** ${filePath}\n` +
        `**Lines fixed:** ${fixCount}\n` +
        `**Target indent:** "${targetIndent}" (${targetIndent.length} spaces)\n`
    }],
  };
}

/**
 * Audit: check if all *System.ts files in a directory are wired into a target class file.
 * Reports missing imports, missing instantiations, missing getters, and orphans.
 */
function handleAuditClassCompleteness(args) {
  const workDir = args.working_directory;
  if (!workDir) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
  }

  const systemsDir = args.systems_dir || path.join(workDir, 'src', 'systems');
  const targetFile = args.target_file || path.join(workDir, 'src', 'scenes', 'GameScene.ts');
  const filePattern = args.file_pattern || /System\.ts$/;
  const excludeFiles = args.exclude_files || ['EventSystem.ts', 'NotificationBridge.ts', 'SaveSystem.ts', 'AnalyticsSystem.ts'];
  if (args.systems_dir && !isPathTraversalSafe(args.systems_dir)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'systems_dir contains path traversal');
  }
  if (args.target_file && !isPathTraversalSafe(args.target_file)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'target_file contains path traversal');
  }

  if (!fs.existsSync(systemsDir)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Systems directory not found: ${systemsDir}`);
  }
  if (!fs.existsSync(targetFile)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Target file not found: ${targetFile}`);
  }

  const systemFiles = fs.readdirSync(systemsDir)
    .filter(f => (typeof filePattern === 'string' ? f.endsWith(filePattern) : filePattern.test(f)))
    .filter(f => !f.startsWith('.') && !excludeFiles.includes(f))
    .sort();

  const targetContent = fs.readFileSync(targetFile, 'utf8');
  const targetName = path.basename(targetFile);

  let output = `## Audit: ${targetName} completeness\n\n`;
  output += `**Systems found:** ${systemFiles.length} in ${path.relative(workDir, systemsDir)}\n`;
  output += `**Target:** ${path.relative(workDir, targetFile)}\n\n`;

  const missing = { imported: [], instantiated: [], getter: [] };
  const wired = [];

  for (const file of systemFiles) {
    const className = file.replace('.ts', '');

    const isImported = targetContent.includes(`import { ${className} }`) || targetContent.includes(`import {${className}}`);
    const isInstantiated = targetContent.includes(`new ${className}(`);
    const hasGetter = targetContent.includes(`get${className}()`);

    if (isImported && isInstantiated) {
      wired.push({ className, hasGetter });
    } else {
      if (!isImported) missing.imported.push(className);
      if (!isInstantiated) missing.instantiated.push(className);
      if (!hasGetter) missing.getter.push(className);
    }
  }

  output += `**Fully wired:** ${wired.length}/${systemFiles.length}\n`;
  const withGetters = wired.filter(w => w.hasGetter).length;
  output += `**With getters:** ${withGetters}/${wired.length}\n\n`;

  if (missing.imported.length > 0) {
    output += `### Missing imports (${missing.imported.length})\n\n`;
    for (const c of missing.imported) output += `- \`${c}\`\n`;
    output += '\n';
  }

  if (missing.instantiated.length > 0) {
    output += `### Missing instantiations (${missing.instantiated.length})\n\n`;
    for (const c of missing.instantiated) output += `- \`${c}\`\n`;
    output += '\n';
  }

  const missingGetters = wired.filter(w => !w.hasGetter);
  if (missingGetters.length > 0) {
    output += `### Wired but missing getter (${missingGetters.length})\n\n`;
    for (const w of missingGetters) output += `- \`${w.className}\`\n`;
    output += '\n';
  }

  if (missing.imported.length === 0 && missing.instantiated.length === 0 && missingGetters.length === 0) {
    output += '**All clear!** Every system is fully wired.\n';
  }

  return {
    content: [{ type: 'text', text: output }],
    _stats: { total: systemFiles.length, wired: wired.length, missingImport: missing.imported.length, missingInstantiation: missing.instantiated.length, missingGetter: missingGetters.length },
  };
}

// ─── Semantic TypeScript Tools (Harness Problem mitigation) ──────────────────

/**
 * Add a method body to a TypeScript class, identified by class name.
 */
function handleAddTsMethodToClass(args) {
  const { file_path: filePath, class_name: className, method_code, position = 'end' } = args;

  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  if (!className) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'class_name is required');
  if (!method_code) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'method_code is required');

  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');

  const classPattern = new RegExp(`(?:export\\s+)?class\\s+${escapeRegex(className)}\\b`);
  const classMatch = classPattern.exec(content);
  if (!classMatch) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Class '${className}' not found in ${filePath}`);
  }

  const methodNameMatch = method_code.match(/(?:(?:public|private|protected|static|async|get|set)\s+)*(\w+)\s*[(<]/);
  const methodName = methodNameMatch ? methodNameMatch[1] : null;

  if (methodName) {
    const existingPattern = new RegExp(`\\b${escapeRegex(methodName)}\\s*[(<]`);
    const classBody = content.slice(classMatch.index);
    if (existingPattern.test(classBody)) {
      return { content: [{ type: 'text', text: `Skipped: method '${methodName}' already exists in class '${className}'` }] };
    }
  }

  let braceDepth = 0;
  let classStartBrace = -1;
  let classEndBrace = -1;
  for (let i = classMatch.index; i < content.length; i++) {
    if (content[i] === '{') {
      if (braceDepth === 0) classStartBrace = i;
      braceDepth++;
    } else if (content[i] === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        classEndBrace = i;
        break;
      }
    }
  }

  if (classEndBrace === -1) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Could not find closing brace for class '${className}'`);
  }

  let insertIndex = classEndBrace;

  if (position === 'before_first_private') {
    const privatePattern = /\n\s*private\s+\w+/;
    const privateMatch = privatePattern.exec(content.slice(classStartBrace, classEndBrace));
    if (privateMatch) {
      insertIndex = classStartBrace + privateMatch.index;
    }
  } else if (position.startsWith('after_method:')) {
    const afterName = position.slice('after_method:'.length);
    const afterPattern = new RegExp(`\\b${escapeRegex(afterName)}\\s*[(<]`);
    const bodySlice = content.slice(classStartBrace, classEndBrace);
    const afterMatch = afterPattern.exec(bodySlice);
    if (afterMatch) {
      let depth = 0;
      let foundStart = false;
      for (let i = classStartBrace + afterMatch.index; i < classEndBrace; i++) {
        if (content[i] === '{') { depth++; foundStart = true; }
        else if (content[i] === '}') {
          depth--;
          if (foundStart && depth === 0) {
            insertIndex = i + 1;
            break;
          }
        }
      }
    }
  }

  const indent = '  ';
  const formattedMethod = '\n' + method_code.split('\n').map(l => indent + l).join('\n') + '\n';

  content = content.slice(0, insertIndex) + formattedMethod + content.slice(insertIndex);
  fs.writeFileSync(filePath, content, 'utf8');

  return {
    content: [{
      type: 'text',
      text: `## Added method to class ${className}\n\n` +
        `**File:** ${filePath}\n` +
        `**Method:** ${methodName || '(anonymous)'}\n` +
        `**Position:** ${position}\n`
    }],
  };
}

/**
 * Replace a method's implementation by class + method name.
 */
function handleReplaceTsMethodBody(args) {
  const { file_path: filePath, class_name: className, method_name: methodName, new_body: newBody } = args;

  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  if (!className) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'class_name is required');
  if (!methodName) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'method_name is required');
  if (!newBody) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'new_body is required');

  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');

  const classPattern = new RegExp(`(?:export\\s+)?class\\s+${escapeRegex(className)}\\b`);
  const classMatch = classPattern.exec(content);
  if (!classMatch) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Class '${className}' not found in ${filePath}`);
  }

  let braceDepth = 0;
  let classStartBrace = -1;
  let classEndBrace = -1;
  for (let i = classMatch.index; i < content.length; i++) {
    if (content[i] === '{') {
      if (braceDepth === 0) classStartBrace = i;
      braceDepth++;
    } else if (content[i] === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        classEndBrace = i;
        break;
      }
    }
  }

  if (classEndBrace === -1) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Could not find closing brace for class '${className}'`);
  }

  const classBody = content.slice(classStartBrace, classEndBrace + 1);
  const methodPattern = new RegExp(`((?:public|private|protected|static|async|get|set|\\s)*)\\b(${escapeRegex(methodName)})\\s*([(<])`);
  const methodMatch = methodPattern.exec(classBody);
  if (!methodMatch) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Method '${methodName}' not found in class '${className}'`);
  }

  const methodAbsStart = classStartBrace + methodMatch.index;
  let methodBodyStart = -1;
  let methodBodyEnd = -1;
  let depth = 0;

  for (let i = methodAbsStart; i < classEndBrace; i++) {
    if (content[i] === '{') {
      if (depth === 0) methodBodyStart = i;
      depth++;
    } else if (content[i] === '}') {
      depth--;
      if (depth === 0) {
        methodBodyEnd = i;
        break;
      }
    }
  }

  if (methodBodyStart === -1 || methodBodyEnd === -1) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Could not find method body for '${methodName}'`);
  }

  const indent = '    ';
  const formattedBody = newBody.split('\n').map(l => indent + l).join('\n');
  content = content.slice(0, methodBodyStart + 1) + '\n' + formattedBody + '\n  ' + content.slice(methodBodyEnd);

  fs.writeFileSync(filePath, content, 'utf8');

  return {
    content: [{
      type: 'text',
      text: `## Replaced method body\n\n` +
        `**File:** ${filePath}\n` +
        `**Class:** ${className}\n` +
        `**Method:** ${methodName}\n` +
        `**New body:** ${newBody.split('\n').length} lines\n`
    }],
  };
}

/**
 * Idempotent import injection — add an import statement if the module isn't already imported.
 */
function handleAddImportStatement(args) {
  const { file_path: filePath, import_statement: importStatement } = args;

  if (filePath && !isPathTraversalSafe(filePath)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  if (!filePath) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'file_path is required');
  if (!importStatement) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'import_statement is required');

  if (!fs.existsSync(filePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');

  const moduleMatch = importStatement.match(/from\s+['"]([^'"]+)['"]/);
  if (!moduleMatch) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Could not extract module path from import statement');
  }

  const modulePath = moduleMatch[1];

  const existingPattern = new RegExp(`from\\s+['"]${escapeRegex(modulePath)}['"]`);
  if (existingPattern.test(content)) {
    return {
      content: [{
        type: 'text',
        text: `Skipped: module '${modulePath}' is already imported in ${filePath}`
      }],
    };
  }

  const lines = content.split('\n');
  let lastImportIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(import\s|const\s+\w+\s*=\s*require\()/.test(lines[i])) {
      lastImportIndex = i;
    }
    if (lastImportIndex >= 0 && i > lastImportIndex + 2 && /\S/.test(lines[i]) && !/^\s*(import|const\s+\w+\s*=\s*require)/.test(lines[i])) {
      break;
    }
  }

  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, importStatement);
  } else {
    lines.unshift(importStatement);
  }

  content = lines.join('\n');
  fs.writeFileSync(filePath, content, 'utf8');

  return {
    content: [{
      type: 'text',
      text: `## Added import statement\n\n` +
        `**File:** ${filePath}\n` +
        `**Import:** \`${importStatement}\`\n` +
        `**Module:** ${modulePath}\n`
    }],
  };
}

// ─── Headwaters Convenience Wrappers ────────────────────────────────────────

function handleWireSystemToGamescene(args) {
  const workDir = args.working_directory;
  const systemName = args.system_name;
  if (!workDir || !systemName) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory and system_name are required');
  }

  const className = systemName.endsWith('System') ? systemName : `${systemName}System`;
  const fieldName = className.charAt(0).toLowerCase() + className.slice(1);
  const importPath = args.import_path || `../systems/${className}`;
  const constructorArgs = args.constructor_args || '';
  const filePath = args.file_path || path.join(workDir, 'src', 'scenes', 'GameScene.ts');
  if (args.file_path && !isPathTraversalSafe(args.file_path)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  const _kebab = systemName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

  return handleInjectClassDependency({
    file_path: filePath,
    import_statement: `import { ${className} } from "${importPath}";`,
    field_declaration: `  private ${fieldName}!: ${className};`,
    initialization: `    this.${fieldName} = new ${className}(${constructorArgs});`,
    getter: `  public get${className}(): ${className} {\n    return this.${fieldName};\n  }`,
    anchors: args.anchors || {
      import_after: 'from "../systems/',
      field_before: 'private notificationBridge',
      init_after: 'this\\.\\w+System\\s*=\\s*new\\s+\\w+System\\(',
      getter_before: 'private generateLoanRequestForRandomResident',
    },
  });
}

function handleWireEventsToEventsystem(args) {
  const workDir = args.working_directory;
  const events = args.events;
  if (!workDir || !events || !Array.isArray(events) || events.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory and events array are required');
  }

  const filePath = args.file_path || path.join(workDir, 'src', 'systems', 'EventSystem.ts');
  if (args.file_path && !isPathTraversalSafe(args.file_path)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  const interfaceName = args.interface_name || 'GameEvents';

  return handleAddTsInterfaceMembers({
    file_path: filePath,
    interface_name: interfaceName,
    members: events.map(e => ({ name: e.name, payload: e.payload })),
    indent: args.indent || '  ',
  });
}

function handleWireNotificationsToBridge(args) {
  const workDir = args.working_directory;
  const notifications = args.notifications;

  if (!workDir || !notifications || !Array.isArray(notifications) || notifications.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory and notifications array are required');
  }
  if (!notifications.every((notification) => notification && typeof notification === 'object')) {
    return makeError(ErrorCodes.INVALID_PARAM, 'All notifications must be objects');
  }

  const bridgePath = args.file_path || path.join(workDir, 'src', 'systems', 'NotificationBridge.ts');
  if (args.file_path && !isPathTraversalSafe(args.file_path)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'file_path contains path traversal');
  }
  const unionTypeName = args.union_type_name || 'NotificationEvent';
  const bindMarker = args.bind_marker || '    this.connected = true;';

  if (!fs.existsSync(bridgePath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${bridgePath}`);
  }

  // Step 1: Add to union type via universal tool
  for (const notification of notifications) {
    if (typeof notification.event_name !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'Each notification must include an event_name string');
    }
    if (typeof notification.toast_template !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'Each notification.toast_template must be a string');
    }
    if (notification.else_template !== undefined && typeof notification.else_template !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'Each notification.else_template must be a string if provided');
    }
  }

  const unionResult = handleAddTsUnionMembers({
    file_path: bridgePath,
    type_name: unionTypeName,
    members: notifications.map(n => n.event_name),
  });
  if (unionResult.isError) return unionResult;

  // Step 2: Build bind() code block
  let bindCode = '';
  for (const notif of notifications) {
    const { event_name, toast_template, color, icon, condition, else_template } = notif;
    const fieldRefs = new Set();
    const templateFieldPattern = /\$\{(\w+)\}/g;
    let fMatch;
    while ((fMatch = templateFieldPattern.exec(toast_template)) !== null) fieldRefs.add(fMatch[1]);
    if (else_template) {
      const ep = /\$\{(\w+)\}/g;
      let em;
      while ((em = ep.exec(else_template)) !== null) fieldRefs.add(em[1]);
    }
    if (condition && /^\w+$/.test(condition)) fieldRefs.add(condition);
    if (condition && !/^\w+$/.test(condition)) {
      const condVars = condition.match(/\b[a-z]\w*/g);
      if (condVars) condVars.forEach(v => fieldRefs.add(v));
    }

    const destructuredFields = [...fieldRefs].join(', ');
    const jsTemplate = toast_template.replace(/\$\{(\w+)\}/g, '${$1}');
    const iconOpt = icon ? `, icon: "${icon}"` : '';

    if (condition) {
      const elseJsTemplate = else_template ? else_template.replace(/\$?\{(\w+)\}/g, '${$1}') : '';
      const cbParams = destructuredFields ? `({ ${destructuredFields} })` : '()';
      bindCode += `    this.bind("${event_name}", ${cbParams} => {\n`;
      bindCode += `      if (${condition}) {\n`;
      bindCode += `        this.toastManager.show(\`${jsTemplate}\`, { color: "${color}"${iconOpt} });\n`;
      if (else_template) {
        const elseColor = notif.else_color || '#EF5350';
        const elseIcon = notif.else_icon ? `, icon: "${notif.else_icon}"` : '';
        bindCode += `      } else {\n`;
        bindCode += `        this.toastManager.show(\`${elseJsTemplate}\`, { color: "${elseColor}"${elseIcon} });\n`;
      }
      bindCode += `      }\n`;
      bindCode += `    });\n\n`;
    } else if (destructuredFields) {
      bindCode += `    this.bind("${event_name}", ({ ${destructuredFields} }) => {\n`;
      bindCode += `      this.toastManager.show(\`${jsTemplate}\`, { color: "${color}"${iconOpt} });\n`;
      bindCode += `    });\n\n`;
    } else {
      bindCode += `    this.bind("${event_name}", () => {\n`;
      bindCode += `      this.toastManager.show(\`${jsTemplate}\`, { color: "${color}"${iconOpt} });\n`;
      bindCode += `    });\n\n`;
    }
  }

  // Step 3: Inject bind code via universal tool
  const injectResult = handleInjectMethodCalls({
    file_path: bridgePath,
    before_marker: bindMarker,
    code: bindCode,
  });
  if (injectResult.isError) return injectResult;

  return {
    content: [{
      type: 'text',
      text: `## Wired ${notifications.length} notifications into ${path.basename(bridgePath)}\n\n` +
        notifications.map(n => `- ✓ \`${n.event_name}\` → "${n.toast_template}" (${n.color})`).join('\n') + '\n'
    }],
  };
}

module.exports = {
  // Universal tools
  handleAddTsInterfaceMembers,
  handleInjectClassDependency,
  handleAddTsUnionMembers,
  handleInjectMethodCalls,
  handleAddTsEnumMembers,
  handleNormalizeInterfaceFormatting,
  // Validation & audit
  handleValidateEventConsistency,
  handleAuditClassCompleteness,
  // Semantic TypeScript tools (Harness Problem mitigation)
  handleAddTsMethodToClass,
  handleReplaceTsMethodBody,
  handleAddImportStatement,
  // Headwaters convenience wrappers (use universal tools internally)
  handleWireSystemToGamescene,
  handleWireEventsToEventsystem,
  handleWireNotificationsToBridge,
};
