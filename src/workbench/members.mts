import { createHash, timingSafeEqual } from "node:crypto";

export type Member = { id: "implementer" | "reviewer"; label: string; login?: string };
export type MemberKeys = Record<Member["id"], string> & { additionalImplementers?: Record<string, string> };

const members: readonly Member[] = [
  { id: "implementer", label: "实施成员" }, { id: "reviewer", label: "验收成员" },
];
const digest = (value: string) => createHash("sha256").update(value).digest();

export function createMembers(keys: MemberKeys) {
  const accounts = members.map(member => ({ member, login: member.id as string, key: keys[member.id] }));
  for (const [login, key] of Object.entries(keys.additionalImplementers ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(login) || accounts.some(account => account.login === login)) {
      throw Error("附加实施成员登录名无效或重复。");
    }
    accounts.push({ member: { id: "implementer", label: login, login }, login, key });
  }
  if (accounts.some(account => typeof account.key !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(account.key))
    || new Set(accounts.map(account => account.key)).size !== accounts.length) {
    throw Error("成员须配置不同的 32 至 128 字符随机登录凭据，只能使用字母、数字、下划线或连字符。");
  }
  const entries = accounts.map(({ member, login, key }) => ({ member, proof: digest(`${login}:${key}`) }));
  return (authorization: string | undefined) => {
    const encoded = /^Basic ([A-Za-z0-9+/=]{1,256})$/i.exec(authorization ?? "")?.[1];
    if (!encoded) return;
    const presented = digest(Buffer.from(encoded, "base64").toString("utf8"));
    return entries.find(entry => timingSafeEqual(entry.proof, presented))?.member;
  };
}
