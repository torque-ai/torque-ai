module.exports = [
  {
    name: 'predict_failure',
    description: 'Analyze task and return failure probability with matched patterns',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Existing task ID to analyze'
        },
        task_description: {
          type: 'string',
          description: 'Task description to analyze (if no task_id)'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory context'
        }
      },
      required: []
    }
  },
  {
    name: 'intelligence_dashboard',
    description: 'Overview of all intelligence metrics - cache hits, predictions, interventions',
    inputSchema: {
      type: 'object',
      properties: {
        time_range_hours: {
          type: 'number',
          description: 'Time range in hours (default: 24)'
        }
      },
      required: []
    }
  },
  {
    name: 'log_intelligence_outcome',
    description: 'Record whether a prediction or intervention was correct (feedback loop)',
    inputSchema: {
      type: 'object',
      properties: {
        log_id: {
          type: 'number',
          description: 'Intelligence log ID'
        },
        outcome: {
          type: 'string',
          description: 'Outcome: correct, incorrect'
        }
      },
      required: ['log_id', 'outcome']
    }
  },
  {
    name: 'export_metrics_prometheus',
    description: 'Export system metrics in Prometheus format for monitoring',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'cache_stats',
    description: 'View cache hit/miss statistics and performance metrics',
    inputSchema: {
      type: 'object',
      properties: {
        cache_name: {
          type: 'string',
          description: 'Specific cache to query (optional, default: all caches)'
        }
      }
    }
  },
  {
    name: 'database_stats',
    description: 'Get comprehensive database statistics including table sizes and index usage',
    inputSchema: {
      type: 'object',
      properties: {
        include_indexes: {
          type: 'boolean',
          description: 'Include detailed index statistics',
          default: false
        },
        include_history: {
          type: 'boolean',
          description: 'Include optimization history',
          default: false
        }
      }
    }
  },
];
