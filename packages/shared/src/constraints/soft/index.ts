import type { SoftConstraintCode } from '../../types';
import type { ConstraintEvaluator } from '../types';
import { evaluateS02, evaluateS03, evaluateS11 } from './curriculum';
import { evaluateS04 } from './room';
import { evaluateS07 } from './stability';
import { evaluateS01, evaluateS09, evaluateS10, evaluateS12, evaluateS13 } from './student';
import { evaluateS05, evaluateS06, evaluateS08 } from './teacher';

export const SOFT_EVALUATORS: Readonly<Record<SoftConstraintCode, ConstraintEvaluator>> = {
  S01: evaluateS01,
  S02: evaluateS02,
  S03: evaluateS03,
  S04: evaluateS04,
  S05: evaluateS05,
  S06: evaluateS06,
  S07: evaluateS07,
  S08: evaluateS08,
  S09: evaluateS09,
  S10: evaluateS10,
  S11: evaluateS11,
  S12: evaluateS12,
  S13: evaluateS13,
};

export {
  evaluateS01,
  evaluateS02,
  evaluateS03,
  evaluateS04,
  evaluateS05,
  evaluateS06,
  evaluateS07,
  evaluateS08,
  evaluateS09,
  evaluateS10,
  evaluateS11,
  evaluateS12,
  evaluateS13,
};
export { studentDays, studentWeeks } from './shared';
export type { StudentDay, StudentWeek } from './shared';
