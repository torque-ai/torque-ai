import type { StepDef } from './step';

interface BuilderState {
  name: string;
  description?: string;
  tasks: StepDef[];
  frontier: string[];
}

interface WorkflowSpec {
  name: string;
  description?: string;
  tasks: StepDef[];
}

function mergeDependencies(existing: string[] | undefined, automatic: string[]): string[] | undefined {
  const merged = [...(existing || []), ...automatic];
  if (merged.length === 0) {
    return undefined;
  }

  return [...new Set(merged)];
}

export function createWorkflow({ name, description }: { name: string; description?: string }) {
  const state: BuilderState = { name, description, tasks: [], frontier: [] };

  function addStep(step: StepDef, overrideDepsOn?: string[]) {
    if (state.tasks.find((task) => task.id === step.id)) {
      throw new Error(`duplicate step id: ${step.id}`);
    }

    const deps = overrideDepsOn !== undefined ? overrideDepsOn : [...state.frontier];
    const newStep: StepDef = {
      ...step,
      depends_on: mergeDependencies(step.depends_on, deps),
    };

    state.tasks.push(newStep);
    return newStep;
  }

  const api = {
    step(step: StepDef) {
      const added = addStep(step);
      state.frontier = [added.id];
      return api;
    },
    then(step: StepDef) {
      return api.step(step);
    },
    parallel(steps: StepDef[]) {
      const parentFrontier = [...state.frontier];
      const ids: string[] = [];

      for (const step of steps) {
        const added = addStep(step, parentFrontier);
        ids.push(added.id);
      }

      state.frontier = ids;
      return api;
    },
    branch(branches: Record<string, StepDef>) {
      const parentFrontier = [...state.frontier];
      const ids: string[] = [];

      for (const [condition, step] of Object.entries(branches)) {
        const added = addStep({ ...step, when: condition }, parentFrontier);
        ids.push(added.id);
      }

      state.frontier = ids;
      return api;
    },
    toSpec(): WorkflowSpec {
      return {
        name: state.name,
        description: state.description,
        tasks: state.tasks.map((task) => ({ ...task })),
      };
    },
  };

  return api;
}
