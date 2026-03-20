/**
 * Tool definitions for API key management (authentication).
 */

module.exports = [
  {
    "name": "create_api_key",
    "description": "Create a new API key for TORQUE authentication. The plaintext key is returned once — save it immediately. Admin only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Human-readable label for this API key"
        },
        "role": {
          "type": "string",
          "description": "Role assigned to this key",
          "enum": ["admin", "operator"],
          "default": "admin"
        }
      },
      "required": ["name"]
    }
  },
  {
    "name": "list_api_keys",
    "description": "List all API keys with metadata. Never shows the actual key value. Admin only.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "revoke_api_key",
    "description": "Revoke an API key. The key immediately stops working. Cannot revoke the last admin key. Admin only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "The key ID to revoke"
        }
      },
      "required": ["id"]
    }
  }
];
