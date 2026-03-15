import React from 'react';

export default function Onboarding({ onDismiss }) {
  return (
    <div style={{
      padding: '2rem',
      margin: '1rem',
      border: '1px solid #3b82f6',
      borderRadius: '8px',
      backgroundColor: '#1e293b',
    }}>
      <h2>Welcome to TORQUE</h2>
      <p>Your distributed AI task orchestration platform is ready.</p>

      <h3>Quick Start</h3>
      <ol>
        <li><strong>Submit a task</strong> — Use <code>smart_submit_task</code> or the <code>/torque-submit</code> slash command in Claude Code</li>
        <li><strong>Monitor progress</strong> — Watch tasks in the Kanban view or use <code>/torque-status</code></li>
        <li><strong>Review results</strong> — Use <code>/torque-review [task-id]</code> to validate output</li>
      </ol>

      <h3>Key Features</h3>
      <ul>
        <li><strong>10 providers</strong> — Local LLMs (Ollama) + Cloud (Codex, Claude, DeepInfra, etc.)</li>
        <li><strong>DAG workflows</strong> — Chain dependent tasks with automatic output injection</li>
        <li><strong>Smart routing</strong> — Tasks auto-route to the best provider based on complexity</li>
        <li><strong>Quality gates</strong> — Baselines, validation, approval, and auto-retry</li>
      </ul>

      <button
        onClick={onDismiss}
        style={{ marginTop: '1rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
      >
        Got it — let's go!
      </button>
    </div>
  );
}
