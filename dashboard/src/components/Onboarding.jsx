export default function Onboarding({ onDismiss }) {
  return (
    <div className="m-4 p-8 border border-blue-500/50 rounded-xl bg-slate-800/80 backdrop-blur-sm">
      <h2 className="text-2xl font-bold text-white mb-2">Welcome to TORQUE</h2>
      <p className="text-slate-400 mb-6">Your distributed AI task orchestration platform is ready.</p>

      <h3 className="text-base font-semibold text-slate-200 mb-3">Quick Start</h3>
      <ol className="list-decimal list-inside space-y-2 mb-6 text-slate-300 text-sm">
        <li>
          <strong className="text-white">Submit a task</strong>
          {' — '}Use <code className="px-1.5 py-0.5 bg-slate-700 rounded text-blue-300 text-xs">smart_submit_task</code> or the{' '}
          <code className="px-1.5 py-0.5 bg-slate-700 rounded text-blue-300 text-xs">/torque-submit</code> slash command in Claude Code
        </li>
        <li>
          <strong className="text-white">Monitor progress</strong>
          {' — '}Watch tasks in the Kanban view or use{' '}
          <code className="px-1.5 py-0.5 bg-slate-700 rounded text-blue-300 text-xs">/torque-status</code>
        </li>
        <li>
          <strong className="text-white">Review results</strong>
          {' — '}Use{' '}
          <code className="px-1.5 py-0.5 bg-slate-700 rounded text-blue-300 text-xs">/torque-review [task-id]</code>{' '}
          to validate output
        </li>
      </ol>

      <h3 className="text-base font-semibold text-slate-200 mb-3">Key Features</h3>
      <ul className="space-y-2 mb-8 text-slate-300 text-sm">
        <li>
          <strong className="text-white">12 providers</strong>
          {' — '}Local LLMs (Ollama), CLI tools (Codex, Claude Code), and cloud APIs (DeepInfra, Groq, and more)
        </li>
        <li>
          <strong className="text-white">DAG workflows</strong>
          {' — '}Chain dependent tasks with automatic output injection
        </li>
        <li>
          <strong className="text-white">Smart routing</strong>
          {' — '}Tasks auto-route to the best provider based on complexity
        </li>
        <li>
          <strong className="text-white">Quality gates</strong>
          {' — '}Baselines, validation, approval, and auto-retry
        </li>
      </ul>

      <button
        onClick={onDismiss}
        className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
      >
        Got it — let&apos;s go!
      </button>
    </div>
  );
}
