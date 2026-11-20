// 调用方须先校验输入 JSON 的结构；工单计划的审批由应用层负责。
export type TicketDraft = {
  id: string;
  dependsOn: readonly string[];
  criteria: readonly string[];
};

export function validateTicketPlan(required: readonly string[], tickets: readonly TicketDraft[]): string[] {
  const errors: string[] = [];
  const ids = new Set(tickets.map(ticket => ticket.id));
  const known = new Set(required);
  const covered = new Set<string>();
  if (required.length === 0 || tickets.length === 0) errors.push("empty-plan");
  if (required.some(id => !id.trim()) || known.size !== required.length) errors.push("invalid-criteria");
  if (tickets.some(ticket => !ticket.id.trim()) || ids.size !== tickets.length) errors.push("invalid-ticket-ids");

  for (const ticket of tickets) {
    for (const dep of ticket.dependsOn) {
      if (!ids.has(dep)) errors.push(`unknown-dependency:${ticket.id}:${dep}`);
    }
    if (!ticket.criteria.length) errors.push(`missing-criteria:${ticket.id}`);
    for (const id of ticket.criteria) {
      if (!known.has(id)) errors.push(`unknown-criterion:${ticket.id}:${id}`);
      covered.add(id);
    }
  }
  for (const id of known) {
    if (!covered.has(id)) errors.push(`uncovered:${id}`);
  }
  if (errors.length) return errors;

  // 逐轮移除依赖已就绪的工单。若无法继续，剩余工单要么处于环中，要么依赖环中的工单。
  const remaining = new Set(ids);
  while (remaining.size) {
    const ready = tickets.filter(t => remaining.has(t.id) && t.dependsOn.every(id => !remaining.has(id)));
    if (!ready.length) return [`blocked-by-cycle:${[...remaining].join(",")}`];
    for (const ticket of ready) remaining.delete(ticket.id);
  }
  return [];
}
