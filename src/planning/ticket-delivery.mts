import { scrubAuditText } from "../audit/activity-store.mts";

export type TicketDelivery = {
  outcome: string;
  priorityReason: string;
  prerequisites: readonly { ticket: string; reason: string }[];
};

const text = { type: "string" };
export const ticketDeliverySchema = {
  type: "object", additionalProperties: false, required: ["outcome", "priorityReason", "prerequisites"],
  properties: { outcome: text, priorityReason: text, prerequisites: {
    type: "array", items: { type: "object", additionalProperties: false, required: ["ticket", "reason"],
      properties: { ticket: text, reason: text } },
  } },
};

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function explanation(value: unknown) {
  if (typeof value === "string" && value.trim() && value.length <= 320 && !value.includes("\0")) return scrubAuditText(value.trim());
}

export function readTicketDelivery(raw: unknown, id: string, dependsOn: readonly string[]): TicketDelivery {
  const data = object(raw);
  const outcome = explanation(data?.outcome);
  const priorityReason = explanation(data?.priorityReason);
  if (!outcome || !priorityReason || !Array.isArray(data?.prerequisites) || data.prerequisites.length !== dependsOn.length) {
    throw Error(`工单校验未通过：${id} 缺少可演示结果、优先理由或完整的前置说明。`);
  }
  const remaining = new Set(dependsOn);
  const prerequisites = data.prerequisites.map(value => {
    const item = object(value);
    const reason = explanation(item?.reason);
    if (typeof item?.ticket !== "string" || !remaining.delete(item.ticket) || !reason) {
      throw Error(`工单校验未通过：${id} 的前置工单和阻塞理由不匹配。`);
    }
    return { ticket: item.ticket, reason };
  });
  return { outcome, priorityReason, prerequisites };
}

export function validateDeliveryOrder(tickets: readonly { id: string; dependsOn: readonly string[] }[]) {
  const earlier = new Set<string>();
  for (const ticket of tickets) {
    const invalid = ticket.dependsOn.find(id => !earlier.has(id));
    if (invalid) throw Error(`工单校验未通过：${ticket.id} 的前置 ${invalid} 必须排在它之前。`);
    earlier.add(ticket.id);
  }
}

export function ticketDeliveryLines(delivery: TicketDelivery) {
  return [
    `可演示结果：${delivery.outcome}`,
    `优先理由：${delivery.priorityReason}`,
    ...delivery.prerequisites.map(({ ticket, reason }) => `前置 ${ticket}：${reason}`),
  ];
}
