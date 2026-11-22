export function accountLabel(item) {
  const label = item.accountAssignment?.label ?? item.accountRef;
  return label ? `账号 ${label}` : "账号未知";
}

export function assignmentDetail({ plan, remaining, active, capacity, reason }) {
  const quota = typeof remaining === "number" ? `剩余 ${remaining.toLocaleString("zh-CN", {maximumFractionDigits: 2})}%` : "额度未知";
  return [plan ?? "套餐未知", quota, `分配前 ${active}/${capacity} 条会话`, reason].join(" · ");
}
