import sys
import os

def replace_in_file(path, replacements):
    """Apply a list of (old, new) replacements to a file."""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    original = content
    for old, new in replacements:
        if old in content:
            content = content.replace(old, new, 1)
        else:
            print(f'  WARNING: pattern not found in {path}:')
            print(f'    {repr(old[:120])}')
    if content != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'  OK: {path}')
    else:
        print(f'  UNCHANGED: {path}')

# 1. coordination.js
replace_in_file('server/db/coordination.js', [
    (
        "const crypto = require('crypto');\nconst logger = require('../logger').child({ component: 'coordination' });",
        "const crypto = require('crypto');\nconst logger = require('../logger').child({ component: 'coordination' });\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, defaultValue = null) {\n  if (!value) return defaultValue;\n  try { return JSON.parse(value); } catch { return defaultValue; }\n}\n",
        ""
    ),
])

# 2. event-tracking.js
replace_in_file('server/db/event-tracking.js', [
    (
        "let db;\nlet getTaskFn;\nconst dbFunctions = {};",
        "const { safeJsonParse } = require('../utils/json');\n\nlet db;\nlet getTaskFn;\nconst dbFunctions = {};"
    ),
    (
        "function safeJsonParse(value, defaultValue = null) {\n  if (!value) return defaultValue;\n  try { return JSON.parse(value); } catch { return defaultValue; }\n}\n",
        ""
    ),
])

# 3. file-baselines.js
replace_in_file('server/db/file-baselines.js', [
    (
        "} = require('../constants');",
        "} = require('../constants');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, defaultValue = null) {\n  if (value === null || value === undefined) return defaultValue;\n  try { return JSON.parse(value); } catch { return defaultValue; }\n}\n",
        ""
    ),
])

# 4. host-benchmarking.js
replace_in_file('server/db/host-benchmarking.js', [
    (
        "const logger = require('../logger').child({ component: 'host-benchmarking' });",
        "const logger = require('../logger').child({ component: 'host-benchmarking' });\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, defaultValue = null) {\n  if (value === null || value === undefined) return defaultValue;\n  try {\n    return JSON.parse(value);\n  } catch {\n    return defaultValue;\n  }\n}\n",
        ""
    ),
])

# 5. pack-registry.js
replace_in_file('server/db/pack-registry.js', [
    (
        "const crypto = require('crypto');",
        "const crypto = require('crypto');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, defaultValue) {\n  try {\n    return JSON.parse(value);\n  } catch {\n    return defaultValue;\n  }\n}\n",
        ""
    ),
])

# 6. peek-fixture-catalog.js
replace_in_file('server/db/peek-fixture-catalog.js', [
    (
        "} = require('../contracts/peek-fixtures');",
        "} = require('../contracts/peek-fixtures');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, defaultValue) {\n  if (value === null || value === undefined) return defaultValue;\n  try {\n    return JSON.parse(value);\n  } catch {\n    return defaultValue;\n  }\n}\n",
        ""
    ),
])

# 7. project-cache.js
replace_in_file('server/db/project-cache.js', [
    (
        "const crypto = require('crypto');",
        "const crypto = require('crypto');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(str, fallback = null) {\n  if (!str || typeof str !== 'string') return fallback;\n  if (str.length > 1048576) return fallback;\n  try { return JSON.parse(str); } catch { return fallback; }\n}\n",
        ""
    ),
])

# 8. project-config-core.js
replace_in_file('server/db/project-config-core.js', [
    (
        "const crypto = require('crypto');",
        "const crypto = require('crypto');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(str, fallback = null) {\n  if (!str || typeof str !== 'string') return fallback;\n  if (str.length > 1048576) return fallback;\n  try { return JSON.parse(str); } catch { return fallback; }\n}\n",
        ""
    ),
])

# 9. scheduling-automation.js
replace_in_file('server/db/scheduling-automation.js', [
    (
        "const { createHash } = require('crypto');",
        "const { createHash } = require('crypto');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "// Local copy — avoids importing from database.js (circular dependency)\nfunction safeJsonParse(value, defaultValue = null) {\n  if (!value) return defaultValue;\n  try { return JSON.parse(value); } catch { return defaultValue; }\n}\n",
        ""
    ),
])

# 10. task-metadata.js
replace_in_file('server/db/task-metadata.js', [
    (
        "const logger = require('../logger').child({ component: 'task-metadata' });",
        "const logger = require('../logger').child({ component: 'task-metadata' });\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, defaultValue = null) {\n  if (!value) return defaultValue;\n  try { return JSON.parse(value); } catch { return defaultValue; }\n}\n",
        ""
    ),
])

# 11. webhooks-streaming.js
replace_in_file('server/db/webhooks-streaming.js', [
    (
        "const credCrypto = require('../utils/credential-crypto');",
        "const credCrypto = require('../utils/credential-crypto');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, defaultValue = null) {\n  if (!value) return defaultValue;\n  try { return JSON.parse(value); } catch { return defaultValue; }\n}\n",
        ""
    ),
])

# 12. provider-crud-handlers.js
replace_in_file('server/handlers/provider-crud-handlers.js', [
    (
        "const credentialCrypto = require('../utils/credential-crypto');",
        "const credentialCrypto = require('../utils/credential-crypto');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, fallback = {}) {\n  if (!value) return fallback;\n  if (typeof value === 'object' && !Array.isArray(value)) return value;\n  if (typeof value !== 'string') return fallback;\n  try {\n    const parsed = JSON.parse(value);\n    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;\n  } catch (_e) { void _e;\n    return fallback;\n  }\n}\n",
        ""
    ),
])

# 13. release-gate.js
replace_in_file('server/policy-engine/adapters/release-gate.js', [
    (
        "const database = require('../../database');",
        "const database = require('../../database');\nconst { safeJsonParse } = require('../../utils/json');"
    ),
    (
        "function safeJsonParse(value, fallback = {}) {\n  if (value === null || value === undefined) return fallback;\n  if (typeof value !== 'string') {\n    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;\n  }\n\n  try {\n    const parsed = JSON.parse(value);\n    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;\n  } catch {\n    return fallback;\n  }\n}\n",
        ""
    ),
])

# 14. workstation/model.js
replace_in_file('server/workstation/model.js', [
    (
        "const logger = require('../logger').child({ component: 'workstation-model' });",
        "const logger = require('../logger').child({ component: 'workstation-model' });\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value, fallback) {\n  if (!value) return fallback;\n  try {\n    return JSON.parse(value);\n  } catch (error) {\n    logger.warn(`Failed to parse JSON field: ${error.message}`);\n    return fallback;\n  }\n}\n",
        ""
    ),
])

# 15. peek-compliance-handlers.test.js
replace_in_file('server/tests/peek-compliance-handlers.test.js', [
    (
        "const Database = require('better-sqlite3');",
        "const Database = require('better-sqlite3');\nconst { safeJsonParse } = require('../utils/json');"
    ),
    (
        "function safeJsonParse(value) {\n  if (!value) return null;\n\n  try {\n    return JSON.parse(value);\n  } catch {\n    return null;\n  }\n}\n",
        ""
    ),
])

print('All done!')
