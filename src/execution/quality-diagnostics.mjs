import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Biome JSON 含说明和源码片段；跨隔离边界只输出有限的结构化定位信息。
export function biomeDiagnostics(report) {
  if (!report || !Array.isArray(report.diagnostics)) return [];
  return report.diagnostics.flatMap(({ category, severity, location }) => {
    if (!/^(lint|suspicious|correctness)\/[a-zA-Z0-9/]+$/.test(category ?? "")
      || !["error", "warning", "info"].includes(severity)
      || !/^(src|tests)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:[cm]?[jt]s|css|html)$/.test(location?.path ?? "")
      || !Number.isSafeInteger(location.start?.line) || location.start.line < 1
      || !Number.isSafeInteger(location.start?.column) || location.start.column < 1) return [];
    return [`${location.path}:${location.start.line}:${location.start.column} BIOME:${severity}:${category}`];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = process.argv[2];
    if (path && statSync(path).size <= 4 * 1024 * 1024) {
      const report = JSON.parse(readFileSync(path, "utf8"));
      const diagnostics = biomeDiagnostics(report).filter(line => !line.includes(" BIOME:info:"));
      if (!Array.isArray(report.diagnostics) || diagnostics.length > 64
        || diagnostics.length !== report.diagnostics.filter(row => ["error", "warning"].includes(row.severity)).length) {
        process.stdout.write("SOUFLOW_DIAGNOSTICS_INCOMPLETE\n");
      }
      for (const diagnostic of diagnostics.slice(0, 64)) {
        process.stdout.write(`SOUFLOW_DIAGNOSTIC ${diagnostic}\n`);
      }
    } else process.stdout.write("SOUFLOW_DIAGNOSTICS_INCOMPLETE\n");
  } catch { process.stdout.write("SOUFLOW_DIAGNOSTICS_INCOMPLETE\n"); }
}
