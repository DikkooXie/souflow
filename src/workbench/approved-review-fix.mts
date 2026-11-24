import { deliveryPath } from "../execution/local-code-changes.mts";

export type ApprovedReviewFix = { issue: number; pull: number; head: string; files: string[]; instructions: string };

export function readApprovedReviewFix(raw: string): ApprovedReviewFix {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Object.keys(value).length !== 5
    || ![value.issue, value.pull].every(number => Number.isSafeInteger(number) && number > 0)
    || typeof value.head !== "string" || !/^[a-f0-9]{40}$/.test(value.head)
    || typeof value.instructions !== "string" || !value.instructions.trim() || value.instructions.length > 4000
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 16
    || new Set(value.files).size !== value.files.length
    || !value.files.every((path: unknown) => typeof path === "string" && deliveryPath.test(path))) {
    throw Error("PR 续修需要指定 Issue、PR、提交、文件范围和维护者要求。");
  }
  return { issue: value.issue, pull: value.pull, head: value.head, files: value.files, instructions: value.instructions };
}
