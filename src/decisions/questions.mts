export type DecisionQuestion = Readonly<{
  id: string;
  title: string;
  prompt: string;
  options: readonly Readonly<{ label: string; description: string }>[];
  allowCustom: boolean;
}>;

export function readDecisionAnswers(questions: readonly DecisionQuestion[], input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const answers = new Map(Object.entries(input));
  if (answers.size !== questions.length) return;
  const entries: [string, string][] = [];
  for (const question of questions) {
    const answer = answers.get(question.id);
    if (typeof answer !== "string" || !answer.trim() || answer.length > 1000) return;
    const selected = question.options.find(option => option.label === answer);
    if (!selected && !question.allowCustom) return;
    entries.push([question.id, selected?.label ?? answer.trim()]);
  }
  return Object.fromEntries(entries);
}
