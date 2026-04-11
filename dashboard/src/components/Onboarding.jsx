import { useState } from 'react';

export default function Onboarding({ onDismiss }) {
  const [currentStep, setCurrentStep] = useState(0);

  const steps = [
    {
      title: 'Register a Project',
      description:
        'TORQUE organizes work by project so your provider defaults, verification settings, and routing stay attached to the right repository from the start.',
      snippet: 'set_project_defaults({ working_directory: "/path/to/your/project", provider: "codex" })',
    },
    {
      title: 'Scan Your Codebase',
      description:
        'Scanning reveals test gaps, TODOs, and file sizes at zero cost so you can understand the codebase before spending tokens on changes.',
      snippet: 'scan_project({ path: "/path/to/your/project" })',
    },
    {
      title: 'Submit Your First Task',
      description:
        'Once your project is configured, submit a focused task and let TORQUE route the work to the right provider for execution.',
      snippet:
        'smart_submit_task({ task_description: "Add unit tests for utils.ts", working_directory: "/path/to/your/project" })',
    },
  ];

  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === steps.length - 1;
  const step = steps[currentStep];

  return (
    <div className="m-4 rounded-xl border border-blue-500/50 bg-slate-800/80 p-8 backdrop-blur-sm">
      <div className="mb-8">
        <h2 className="mb-2 text-2xl font-bold text-white">Welcome to TORQUE</h2>
        <p className="text-slate-400">Follow the guided setup to register a project, scan your codebase, and ship your first task.</p>
      </div>

      <ol className="mb-8 flex items-start">
        {steps.map((item, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;

          return (
            <li key={item.title} className="flex flex-1 items-start">
              <div className="flex w-full flex-col items-center text-center">
                <div className="flex w-full items-center">
                  <div
                    aria-current={isCurrent ? 'step' : undefined}
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors ${
                      isCompleted
                        ? 'border-blue-500 bg-blue-500 text-white'
                        : isCurrent
                          ? 'border-blue-400 text-white ring-2 ring-blue-400/40 ring-offset-2 ring-offset-slate-800'
                          : 'border-slate-600 text-slate-400'
                    }`}
                  >
                    {isCompleted ? (
                      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-5 w-5">
                        <path d="M5 10.5L8.5 14L15 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      index + 1
                    )}
                  </div>
                  {index < steps.length - 1 ? (
                    <div className={`mx-3 h-px flex-1 ${isCompleted ? 'bg-blue-500' : 'bg-slate-700'}`} />
                  ) : null}
                </div>
                <span className={`mt-3 max-w-[10rem] text-xs font-medium ${isCompleted || isCurrent ? 'text-white' : 'text-slate-400'}`}>
                  {item.title}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-blue-300">Step {currentStep + 1}</p>
        <h3 className="mt-3 text-xl font-semibold text-white">{step.title}</h3>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">{step.description}</p>

        <div className="mt-6 rounded-lg border border-slate-700 bg-slate-950/80 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Command</p>
          <pre className="overflow-x-auto text-sm text-blue-300">
            <code>{step.snippet}</code>
          </pre>
        </div>

        <div className={`mt-8 flex items-center gap-3 ${isFirstStep ? 'justify-end' : 'justify-between'}`}>
          {!isFirstStep ? (
            <button
              type="button"
              onClick={() => setCurrentStep((stepIndex) => Math.max(0, stepIndex - 1))}
              className="cursor-pointer rounded-lg border border-slate-600 bg-slate-900/80 px-5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700/80"
            >
              Back
            </button>
          ) : null}

          {isLastStep ? (
            <button
              type="button"
              onClick={() => onDismiss()}
              className="cursor-pointer rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCurrentStep((stepIndex) => Math.min(steps.length - 1, stepIndex + 1))}
              className="cursor-pointer rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
