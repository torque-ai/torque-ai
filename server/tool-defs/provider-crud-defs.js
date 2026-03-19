'use strict';

module.exports = [
  {
    name: 'add_provider',
    description: 'Add a new execution provider to provider_config and optionally seed pending models in model_registry.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique provider name/id (for example: "my-custom-api").',
        },
        provider_type: {
          type: 'string',
          enum: ['ollama', 'cloud-cli', 'cloud-api', 'custom'],
          description: 'Provider type used for transport defaults and capability expectations.',
        },
        api_base_url: {
          type: 'string',
          description: 'Optional provider base URL for API-backed providers.',
        },
        api_key: {
          type: 'string',
          description: 'Optional API key stored with the provider configuration.',
        },
        max_concurrent: {
          type: 'number',
          description: 'Maximum concurrent tasks for this provider. Defaults to 3.',
          default: 3,,
          minimum: 0
        },
        default_model: {
          type: 'string',
          description: 'Optional default model for this provider.',
        },
        priority: {
          type: 'number',
          description: 'Optional provider priority. Lower values are preferred first.',
        },
        transport: {
          type: 'string',
          enum: ['api', 'cli', 'hybrid'],
          description: 'Optional transport override. Defaults from provider_type when omitted.',
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional initial model names to register as pending for this provider.',
        },
      },
      required: ['name', 'provider_type'],
    },
  },
  {
    name: 'remove_provider',
    description: 'Preview or remove a provider. Without confirm it reports affected queued/running tasks; with confirm=true it deletes the provider, marks models removed, and re-routes queued tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider name/id to remove.',
        },
        confirm: {
          type: 'boolean',
          description: 'Set true to confirm deletion after previewing affected tasks.',
        },
      },
      required: ['provider'],
    },
  },
  {
    name: 'set_provider_api_key',
    description: 'Set or update the API key for a provider. Encrypts at rest and triggers an async health check.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name (e.g., "deepinfra", "groq")' },
        api_key: { type: 'string', description: 'The API key value' },
      },
      required: ['provider', 'api_key'],
    },
  },
  {
    name: 'clear_provider_api_key',
    description: 'Clear the stored API key for a provider.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name (e.g., "deepinfra", "groq")' },
      },
      required: ['provider'],
    },
  },
];
