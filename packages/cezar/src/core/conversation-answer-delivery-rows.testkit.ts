import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { it as registerTest } from 'vitest';
import { ANSWER_DELIVERY_CRITERIA, exemptionFor, type ParityExemption } from './harness-parity-core.testkit.ts';
import { collectedOnly, type CellBody } from './parity-partition.testkit.ts';

// The conversation answer delivery cells and their groups, apart from the engine the cell bodies
// drive, so the registration guard collects the same names without loading it.
type AnswerDeliveryRow = (typeof ANSWER_DELIVERY_CRITERIA)[number];
export type AnswerDeliveryBodies = {
  steerExemption: (backend: string, steer: AnswerDeliveryRow, steerExemption: ParityExemption) => CellBody;
  steering: (backend: string, steer: AnswerDeliveryRow) => CellBody;
  declaredDelivery: (backend: string, declared: AnswerDeliveryRow) => CellBody;
  pendingQuestion: (backend: string, held: AnswerDeliveryRow) => CellBody;
};
type AnswerDeliveryFamily = (backend: string, it?: typeof registerTest) => void;

/** The registrar of each family's cell over its bodies. */
export function answerDeliveryFamilies(bodies: AnswerDeliveryBodies): Record<'steering' | 'declared-delivery' | 'pending-question', AnswerDeliveryFamily> {
  const [steer, declared, held] = ANSWER_DELIVERY_CRITERIA;
  return {
    'steering': (backend, it = registerTest) => {
      const steerExemption = exemptionFor(steer.id, backend);
      if (steerExemption) it(`${backend} is exempt from ${steer.id} — ${steerExemption.reason}`, bodies.steerExemption(backend, steer, steerExemption));
      else it(`${backend} ${steer.id} ${steer.name}`, bodies.steering(backend, steer), 60_000);
    },
    'declared-delivery': (backend, it = registerTest) => it(`${backend} ${declared.id} ${declared.name}`, bodies.declaredDelivery(backend, declared), 60_000),
    'pending-question': (backend, it = registerTest) => it(`${backend} ${held.id} ${held.name}`, bodies.pendingQuestion(backend, held), 60_000),
  };
}

const FAMILIES = ['steering', 'declared-delivery', 'pending-question'] as const;
export const ANSWER_DELIVERY_GROUPS = Object.fromEntries(FAMILIES.map(family => [family, BUILT_IN_RUNNER_IDS.map(runner => ({ runner, family }))]));

/** The same cells by name only, for the registration guard. */
export const answerDeliveryCellNames = answerDeliveryFamilies({ steerExemption: collectedOnly, steering: collectedOnly, declaredDelivery: collectedOnly, pendingQuestion: collectedOnly });
