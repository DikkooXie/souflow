import { createHash, timingSafeEqual } from "node:crypto";

export type Member = { id: "implementer" | "reviewer"; label: string };
export type MemberKeys = Record<Member["id"], string>;

const members: readonly Member[] = [
  { id: "implementer", label: "实施成员" }, { id: "reviewer", label: "验收成员" },
];
const digest = (value: string) => createHash("sha256").update(value).digest();

export function createMembers(keys: MemberKeys) {
  if (members.some(member => !/^[A-Za-z0-9_-]{32,128}$/.test(keys[member.id])) || keys.implementer === keys.reviewer) {
    throw Error("两位成员须配置不同的 32 至 128 字符随机登录凭据，只能使用字母、数字、下划线或连字符。");
  }
  const entries = members.map(member => ({ member, proof: digest(`${member.id}:${keys[member.id]}`) }));
  return (authorization: string | undefined) => {
    const encoded = /^Basic ([A-Za-z0-9+/=]{1,256})$/i.exec(authorization ?? "")?.[1];
    if (!encoded) return;
    const presented = digest(Buffer.from(encoded, "base64").toString("utf8"));
    return entries.find(entry => timingSafeEqual(entry.proof, presented))?.member;
  };
}
