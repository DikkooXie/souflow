import { createConversationFlows } from "../../src/planning/conversation-flow.mts";
import { type PlannedTicket, type QualityTicket, qualityPacket } from "../../src/planning/dispatch-quality.mts";

export async function deviceTicketPlan() {
  const prompt = "让新成员从个人主页查看自己的设备，并能撤销自己的设备连接。先交付设备列表，再交付撤销操作。两项都可以从已有登录入口独立验证。";
  const docs: Record<string, string> = {
    "场景与已有依据": "成员已能登录。设备列表可使用现有已登记设备，撤销可直接通过已有设备详情操作。",
    "待核实事项": "核对同一成员权限是否传到设备查询和撤销，验证其他成员不能读或撤销。",
    "目标与范围": prompt,
    "验收条件": "AC-1 成员在个人主页只看到自己名下的设备。\nAC-2 成员在已有设备详情撤销自己的设备，其他成员撤销会被拒绝。",
    "推荐方案": "沿用已有登录与设备详情，分别完成列表和撤销。",
    "依据与取舍": "使用同一登录身份。列表采用已有登记结果，撤销使用已有详情流程。",
    "PRD": "列表显示成员自己的设备。现有设备详情提供撤销操作，成员只能撤销自己的设备。列表先交付。",
    "开发计划": "优先顺序 T1 设备列表、T2 设备撤销。无阻塞依赖，两单在各自入口执行。分别测试跨成员隔离。",
    "建议工单": "T1 成员设备列表；T2 成员设备撤销。",
    "依赖与验证": "两项独立，优先从设备详情保留撤销入口；验证列表的可见范围与撤销的前后状态。",
  };
  const service = createConversationFlows(async (_flow, phase) => phase.fields.map(field => docs[field] ?? ""), 1);
  const flow = service.begin(prompt, "member");
  await service.settled();
  if (!flow) throw Error("无法构造设备接入规划样例。");
  const tickets: PlannedTicket[] = [
    { id: "T1", title: "列出成员自己的设备", instructions: "从个人主页读取并显示自己的设备，在入口及查询处使用当前身份。",
      paths: ["src/workbench/device-list.mts", "tests/device-list.test.mts"], criteria: ["AC-1"], dependsOn: [],
      delivery: { outcome: "两位成员分别登录个人主页，每人只看到自己的设备", priorityReason: "已确认先交付主页列表", prerequisites: [] },
      validation: [{ criterion: "AC-1", procedure: "以两位成员登录，各登记一台设备并打开个人主页",
        expected: "每位成员仅能看到自己的设备，另一成员的设备不出现在列表" }] },
    { id: "T2", title: "只撤销自己绑定的设备", instructions: "在已有设备详情提交撤销，服务端检查当前成员是否拥有该设备。",
      paths: ["src/workbench/device-revoke.mts", "tests/device-revoke.test.mts"], criteria: ["AC-2"], dependsOn: [],
      delivery: { outcome: "成员撤销自己的设备后重连失败，尝试撤销他人设备时被拒绝", priorityReason: "已有详情可独立验证，按计划排在列表之后", prerequisites: [] },
      validation: [{ criterion: "AC-2", procedure: "先尝试撤销另一成员设备，再撤销自己的绑定并尝试重连",
        expected: "前者被拒且状态不变，后者无法重连" }] },
  ];
  const sources = {
    "src/workbench/device-list.mts": "export function listMemberDevices(memberId, registry) { return registry.listByMember(memberId); }",
    "src/workbench/device-revoke.mts": "export function existingDeviceDetails(memberId, registry) { return registry.detailsForMember(memberId); }",
    "tests/device-list.test.mts": "现有测试夹具支持分别登录两个成员，为每个成员登记设备并读取个人主页。",
    "tests/device-revoke.test.mts": "现有测试夹具可使用成员身份打开设备详情，提交撤销并验证设备重连。",
  };
  return { flow, tickets, packet: (items: readonly QualityTicket[]) => qualityPacket(flow, "a".repeat(40), "fixture", items, sources) };
}
