/**
 * Deterministically generate `scenarios/Q01.json` and `scenarios/Q21.json`.
 * Usage: pnpm gen:scenarios   (re-running produces byte-identical files)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findRepoRoot } from './env';
import { SCENARIO_BUILDERS, type ScenarioCode } from './scenario-builder';

export function serializeScenario(code: ScenarioCode): string {
  return `${JSON.stringify(SCENARIO_BUILDERS[code](), null, 2)}\n`;
}

async function main(): Promise<void> {
  const outDir = path.join(findRepoRoot(), 'scenarios');
  await mkdir(outDir, { recursive: true });
  for (const code of Object.keys(SCENARIO_BUILDERS) as ScenarioCode[]) {
    const json = serializeScenario(code);
    const file = path.join(outDir, `${code}.json`);
    await writeFile(file, json, 'utf8');
    const { meta } = JSON.parse(json) as { meta: { counts: Record<string, number>; totalSlots: number } };
    const c = meta.counts;
    console.log(
      `✔ ${path.relative(process.cwd(), file)} — departments=${c.departments}, student_groups=${c.student_groups}, ` +
        `staff=${c.staff}, rooms=${c.rooms}, slots=${meta.totalSlots}, subjects=${c.subjects}, ` +
        `course_offerings=${c.course_offerings}, students=${c.students}, eligibility=${c.teacher_subject_eligibility} ` +
        `(${(Buffer.byteLength(json) / 1024).toFixed(1)} KiB)`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
