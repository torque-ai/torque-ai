module.exports = [
  {
    name: 'reject_task',
    description: 'Reject a pending task change.',
    inputSchema: {
      type: 'object',
      properties: {
        approval_id: {
          type: 'string',
          description: 'Approval ID to reject'
        },
        notes: {
          type: 'string',
          description: 'Reason for rejection'
        }
      },
      required: [
        'approval_id'
      ]
    }
  },
  {
    name: 'approve_diff',
    description: 'Approve a diff preview to allow committing.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to approve'
        }
      },
      required: [
        'task_id'
      ]
    }
  },
  {
    name: 'check_approval_gate',
    description: 'Check whether a task passes approval gates before allowing commit.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID to evaluate'
        }
      },
      required: [
        'task_id'
      ]
    }
  }
];
