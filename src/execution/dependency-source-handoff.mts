type Git = (args: string[]) => Promise<string>;

export type SourceProducer = {
  issue: number; pull: number; head: string; merge: string; baseName: string;
  files: readonly string[]; sources: readonly string[];
};
export type SourceHandoff = {
  original: string; execution: string; producers: readonly SourceProducer[];
  changedPaths: string[];
  blobs: { path: string; mode: string; sha: string }[];
  refreshed?: true;
};

export class IssueDeliverySourcesChanged extends Error {
  constructor() { super("依赖合并改变了已校验的源码或项目计划，请重新规划。"); }
}

const commit = /^[a-f0-9]{40}$/;
const splitPaths = (value: string) => value.split("\0").filter(Boolean);

export async function proveRefreshedSources(git: Git, original: string, execution: string, paths: readonly string[],
  planPath: string | undefined, upstream: readonly string[], producers: readonly SourceProducer[]): Promise<SourceHandoff> {
  const changed = () => new IssueDeliverySourcesChanged();
  if (![original, execution, ...upstream].every(sha => commit.test(sha))
    || execution === original || !producers.length || await git(["rev-parse", "HEAD"]) !== execution) throw changed();
  const history = (await git(["rev-list", "--first-parent", "--parents", execution, `^${original}`]))
    .split("\n").filter(Boolean).map(line => line.split(" "));
  if (history.at(-1)?.[1] !== original || upstream.some(merge => !history.some(([sha]) => sha === merge))
    || producers.some(producer => !upstream.includes(producer.merge))) throw changed();
  if (planPath) {
    try { await git(["--literal-pathspecs", "diff", "--quiet", "--no-ext-diff", "--no-textconv", original, execution, "--", planPath]); }
    catch { throw changed(); }
  }
  const relevant = [...new Set(paths)];
  const changedPaths = splitPaths(await git(["--literal-pathspecs", "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff",
    "--no-textconv", original, execution, "--", ...relevant]));
  const blobs = readBlobs(await git(["--literal-pathspecs", "ls-tree", "-z", execution, "--", ...relevant]), relevant);
  if (!changedPaths.length) throw changed();
  return { original, execution, producers, changedPaths, blobs, refreshed: true };
}

function readBlobs(raw: string, relevant: readonly string[]): SourceHandoff["blobs"] {
  const blobs = splitPaths(raw).map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match?.[1] || !match[2] || !match[3] || !relevant.includes(match[3])) throw new IssueDeliverySourcesChanged();
    return { path: match[3], mode: match[1], sha: match[2] };
  });
  if (new Set(blobs.map(blob => blob.path)).size !== new Set(relevant).size) throw new IssueDeliverySourcesChanged();
  return blobs;
}

export async function proveSourceHandoff(git: Git, original: string, execution: string, fixedPaths: readonly string[],
  sources: readonly string[], producers: readonly SourceProducer[]): Promise<SourceHandoff | undefined> {
  const changed = () => new IssueDeliverySourcesChanged();
  const byMerge = new Map(producers.map(producer => [producer.merge, producer]));
  const byPath = new Map<string, SourceProducer>();
  const fixed = new Set(fixedPaths);
  const input = new Set(sources);
  if (!commit.test(original) || !commit.test(execution) || byMerge.size !== producers.length) throw changed();
  for (const producer of producers) {
    if (!commit.test(producer.merge) || !commit.test(producer.head) || !producer.sources.length) throw changed();
    for (const path of producer.sources) {
      if (byPath.has(path) || !input.has(path) || fixed.has(path) || !producer.files.includes(path)) throw changed();
      byPath.set(path, producer);
    }
  }
  // 从刚克隆的默认分支追溯第一父历史，不能把旁支祖先当成实际交接。
  const history = (await git(["rev-list", "--first-parent", "--parents", "HEAD", `^${original}`]))
    .split("\n").filter(Boolean).map(line => line.split(" "));
  const first = history.findIndex(([sha]) => sha === execution);
  if (first < 0 || history.at(-1)?.[1] !== original) throw changed();
  const relevant = [...fixed, ...input];
  const touched = new Set<string>();
  const verified = new Set<string>();
  for (const [sha, parent, second, ...additional] of history.slice(first)) {
    if (!sha || !parent || !commit.test(sha) || !commit.test(parent)) throw changed();
    const producer = byMerge.get(sha);
    if (producer) {
      if (additional.length || (second && second !== producer.head) || sha === producer.head) throw changed();
      verified.add(sha);
    }
    const paths = splitPaths(await git(["--literal-pathspecs", "diff", "--name-only", "-z", "--no-renames",
      "--no-ext-diff", "--no-textconv", parent, sha, "--", ...(producer ? [] : relevant)]));
    if (producer && paths.some(path => !producer.files.includes(path))) throw changed();
    for (const path of paths) {
      if (fixed.has(path) || (input.has(path) && (!producer || byPath.get(path) !== producer))) throw changed();
      if (input.has(path)) touched.add(path);
    }
  }
  if (verified.size !== producers.length) throw changed();
  if (!touched.size) return;
  const blobs = readBlobs(await git(["--literal-pathspecs", "ls-tree", "-z", execution, "--", ...relevant]), relevant);
  return { original, execution, producers, changedPaths: [...touched], blobs };
}
