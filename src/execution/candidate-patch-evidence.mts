import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentDigest, type CandidateFile } from "./code-worker-protocol.mts";
import { deliveryPath, maxCodeProposalBytes } from "./local-code-changes.mts";

type Source = { content: string; mode: number };

export function verifyCandidatePatch(sources: ReadonlyMap<string, Source>, files: readonly CandidateFile[], patch: string) {
  if (Buffer.byteLength(patch) > maxCodeProposalBytes) return false;
  const headers = [...patch.matchAll(/^diff --git [^\r\n]+$/gm)].map(([header]) => header);
  const names = headers.map(header => {
    const match = /^diff --git a\/before\/([^\s]+) b\/after\/([^\s]+)$/.exec(header);
    return match?.[1] && match[1] === match[2] && deliveryPath.test(match[1]) ? match[1] : "";
  });
  const paths = files.map(file => file.path);
  if (!names.length || names.some(path => !path) || names.length !== paths.length
    || names.some((path, index) => path !== paths[index]) || new Set(names).size !== names.length) return false;
  const beforeHeaders = [...patch.matchAll(/^--- a\/before\/([^\r\n]+)$/gm)].map(([, path]) => path);
  const afterHeaders = [...patch.matchAll(/^\+\+\+ b\/after\/([^\r\n]+)$/gm)].map(([, path]) => path);
  if (beforeHeaders.length !== names.length || afterHeaders.length !== names.length
    || beforeHeaders.some((path, index) => path !== names[index]) || afterHeaders.some((path, index) => path !== names[index])) return false;

  const directory = mkdtempSync(join(tmpdir(), "souflow-candidate-proof-"));
  try {
    for (const file of files) {
      const source = sources.get(file.path);
      if (!source || contentDigest(source.content) !== file.before
        || (source.mode & 0o111 ? 0o100755 : 0o100644) !== file.mode) return false;
      const target = join(directory, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, source.content, { flag: "wx", mode: source.mode });
      chmodSync(target, source.mode);
    }
    const patchPath = join(directory, "candidate.patch");
    writeFileSync(patchPath, patch, { flag: "wx", mode: 0o600 });
    execFileSync("git", ["apply", "--check", "--binary", "-p2", patchPath], { cwd: directory, timeout: 5000, stdio: "ignore" });
    execFileSync("git", ["apply", "--binary", "-p2", patchPath], { cwd: directory, timeout: 5000, stdio: "ignore" });
    const resultFiles = listFiles(directory);
    if (!resultFiles || JSON.stringify(resultFiles.filter(path => path !== "candidate.patch").sort()) !== JSON.stringify([...paths].sort())) return false;
    return files.every(file => {
      const target = join(directory, file.path);
      try {
        const info = lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink()) return false;
        const contents = readFileSync(target);
        const text = contents.toString("utf8");
        const mode = info.mode & 0o111 ? 0o100755 : 0o100644;
        return !text.includes("\0") && contents.equals(Buffer.from(text))
          && contentDigest(text) === file.after && mode === file.mode;
      } catch { return false; }
    });
  } catch { return false; }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function listFiles(directory: string, relative = ""): string[] | undefined {
  try {
    const files: string[] = [];
    for (const name of readdirSync(join(directory, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const info = lstatSync(join(directory, path));
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) {
        const nested = listFiles(directory, path);
        if (!nested) return;
        files.push(...nested);
      } else if (info.isFile()) files.push(path);
      else return;
    }
    return files;
  } catch { return; }
}
