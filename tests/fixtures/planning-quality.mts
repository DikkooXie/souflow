import { createConversationFlows, type Flow } from "../../src/planning/conversation-flow.mts";
import type { QualityPacket, QualityReviewer } from "../../src/planning/dispatch-quality.mts";

export const validation = [{ criterion: "AC-1", procedure: "按确认指引操作后检查产物", expected: "产物符合验收要求" }];

export function qualityReviewOutput(packet: QualityPacket) {
  const quote = (ref: string) => ({ ref, quote: packet.references[ref]?.slice(0, 40) ?? "" });
  return {
    scope: { status: "pass", summary: "夹具范围通过", evidence: [quote("request")] },
    evidence: { status: "pass", summary: "夹具依据通过", evidence: [quote("prd"), ...packet.batchAcceptance.flatMap(item =>
      item.owner === "related-issue" ? [{ ref: `github:issue:${item.issue}`, quote: item.basis }] : [])] },
    verification: {
      status: "pass", summary: "夹具验证通过", evidence: packet.planning.criteria.map(({ id }) =>
        quote(Object.keys(packet.references).find(ref => ref === `batch-test:${id}` || ref.startsWith("test:") && ref.endsWith(`:${id}`)) ?? "")),
    },
    ...(packet.tickets.some(ticket => ticket.delivery) ? { breakdown: packet.tickets.map(ticket => ({
      ticket: ticket.id, status: "pass", summary: "夹具可独立验证且顺序正确", evidence: [quote(`ticket:${ticket.id}`)],
    })) } : {}),
  };
}
export const passingQualityReview: QualityReviewer = async packet => JSON.stringify(qualityReviewOutput(packet));

export async function readyQualityFlow(prompt = "上传录音生成纪要，人工确认后发送待办"): Promise<Flow> {
  const service = createConversationFlows(async (_flow, phase) => phase.fields.map(field => field === "验收条件"
    ? "重复确认同一份纪要时只发送一次待办"
    : field === "目标与范围" ? "用户上传录音，确认纪要后才发送待办。首版只支持已有录音。"
      : field === "PRD" ? "上传录音，生成待确认纪要。重复确认只创建一次待办。"
        : field === "开发计划" ? "复用待办服务，同一纪要使用固定幂等键。先测两次确认，再实施。"
          : `夹具内容 ${field}`), 1);
  const flow = service.begin(prompt, "member");
  await service.settled();
  if (!flow) throw Error("无法创建测试需求。");
  return flow;
}
