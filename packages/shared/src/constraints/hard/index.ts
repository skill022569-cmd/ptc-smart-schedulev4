import type { HardConstraintCode } from '../../types';
import type { ConstraintEvaluator } from '../types';
import { evaluateH01, evaluateH02, evaluateH03 } from './clash';
import { computeOfferingHours, evaluateH17, evaluateH18, evaluateH20 } from './curriculum';
import { evaluateH04, evaluateH05, evaluateH12 } from './room';
import { evaluateH11, evaluateH13, evaluateH14, evaluateH15, evaluateH16, evaluateH19 } from './teacher';
import { evaluateH06, evaluateH07, evaluateH08, evaluateH09, evaluateH10, evaluateH21 } from './time';

export const HARD_EVALUATORS: Readonly<Record<HardConstraintCode, ConstraintEvaluator>> = {
  H01: evaluateH01,
  H02: evaluateH02,
  H03: evaluateH03,
  H04: evaluateH04,
  H05: evaluateH05,
  H06: evaluateH06,
  H07: evaluateH07,
  H08: evaluateH08,
  H09: evaluateH09,
  H10: evaluateH10,
  H11: evaluateH11,
  H12: evaluateH12,
  H13: evaluateH13,
  H14: evaluateH14,
  H15: evaluateH15,
  H16: evaluateH16,
  H17: evaluateH17,
  H18: evaluateH18,
  H19: evaluateH19,
  H20: evaluateH20,
  H21: evaluateH21,
};

export {
  computeOfferingHours,
  evaluateH01,
  evaluateH02,
  evaluateH03,
  evaluateH04,
  evaluateH05,
  evaluateH06,
  evaluateH07,
  evaluateH08,
  evaluateH09,
  evaluateH10,
  evaluateH11,
  evaluateH12,
  evaluateH13,
  evaluateH14,
  evaluateH15,
  evaluateH16,
  evaluateH17,
  evaluateH18,
  evaluateH19,
  evaluateH20,
  evaluateH21,
};
export type { OfferingHours, OfferingHoursTrack } from './curriculum';
