export interface StepDef {
  id: string;
  task_description?: string;
  provider?: string;
  kind?: string;
  produces?: string[];
  consumes?: string[];
  depends_on?: string[];
  when?: string;
}

export function createStep(def: StepDef): StepDef {
  if (!def.id) {
    throw new Error('step requires id');
  }

  return { ...def };
}
