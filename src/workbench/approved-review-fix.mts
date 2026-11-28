import { deliveryPath } from "../execution/local-code-changes.mts";

export const approvedReviewFixInstructionLimit = 4000;
export type ApprovedReviewFix = { issue: number; pull: number; head: string; base: string; files: string[]; instructions: string;
  testFiles?: string[]; testFailureNote?: string };
const testPath = /^tests\/[\w./-]+\.test\.[cm]?[jt]s$/;

export function readApprovedReviewFix(raw: string): ApprovedReviewFix {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Object.keys(value).length !== 6 + Number(Object.hasOwn(value, "testFiles"))
      + Number(Object.hasOwn(value, "testFailureNote"))
    || ![value.issue, value.pull].every(number => Number.isSafeInteger(number) && number > 0)
    || typeof value.head !== "string" || !/^[a-f0-9]{40}$/.test(value.head)
    || typeof value.base !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(value.base) || value.base.includes("..")
    || typeof value.instructions !== "string" || !value.instructions.trim() || value.instructions.length > approvedReviewFixInstructionLimit
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 16
    || new Set(value.files).size !== value.files.length
    || !value.files.every((path: unknown) => typeof path === "string" && deliveryPath.test(path))
    || (value.testFiles !== undefined && (!Array.isArray(value.testFiles) || !value.testFiles.length
      || new Set([...value.files, ...value.testFiles]).size !== value.files.length + value.testFiles.length
      || value.files.length + value.testFiles.length > 16 || !value.testFiles.every((path: unknown) =>
        typeof path === "string" && deliveryPath.test(path) && testPath.test(path))))
    || (value.testFailureNote !== undefined && (!value.testFiles || typeof value.testFailureNote !== "string"
      || !value.testFailureNote.trim() || value.testFailureNote.length > approvedReviewFixInstructionLimit))) {
    throw Error("PR 续修需要指定 Issue、PR、提交、文件范围和维护者要求。");
  }
  return { issue: value.issue, pull: value.pull, head: value.head, base: value.base, files: value.files, instructions: value.instructions,
    ...(value.testFiles ? { testFiles: value.testFiles } : {}),
    ...(value.testFailureNote ? { testFailureNote: value.testFailureNote } : {}) };
}

export function readApprovedReviewFixes(raw: string): ApprovedReviewFix[] {
  const input: unknown = JSON.parse(raw);
  const fixes = Array.isArray(input) ? input.map(value => readApprovedReviewFix(JSON.stringify(value))) : [readApprovedReviewFix(raw)];
  if (new Set(fixes.map(fix => fix.issue)).size !== fixes.length) throw Error("同一工单只能配置一次续修。");
  return fixes;
}
