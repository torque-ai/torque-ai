# Variant: Security

## Focus Area

Find security vulnerabilities and unsafe patterns.

## What to Look For

- **Command injection** — user input flowing into shell execution functions without sanitization
- **SQL injection** — string concatenation in SQL queries instead of parameterized `?` placeholders
- **Path traversal** — user-controlled paths passed to file read/write operations without validation
- **SSRF** — user-controlled URLs passed to HTTP clients or git operations without protocol/host validation
- **Authentication bypass** — endpoints missing auth middleware, auth skipped on sensitive routes
- **Secrets in code** — hardcoded API keys, tokens, passwords, connection strings
- **Unsafe deserialization** — parsing untrusted input without error handling, dynamic code evaluation
- **CSRF** — state-changing endpoints without origin validation or CSRF tokens
- **Missing input validation** — API endpoints or MCP tool handlers that don't validate required parameters or types
- **Overly permissive access** — servers binding to all interfaces without auth, files with open permissions

## Search Patterns

Look for: shell execution with user input, string-concatenated SQL, file operations on user-supplied paths, `skipAuth`, dynamic evaluation, hardcoded credentials, unvalidated URLs.

## Severity Guide

- CRITICAL: Exploitable vulnerability (injection, auth bypass, remote code execution)
- HIGH: Potential vulnerability requiring specific conditions
- MEDIUM: Unsafe pattern that could become exploitable
- LOW: Missing defense-in-depth (e.g., no rate limiting)
