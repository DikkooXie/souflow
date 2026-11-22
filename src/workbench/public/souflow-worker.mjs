import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function main() {
  const configFile = resolve(process.argv[2] ?? "");
  if (process.argv.length !== 3) throw Error("请传入工作台下载的设备接入 JSON 文件。");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/"
    || endpoint.search || endpoint.hash || !idPattern.test(config.id) || !/^[a-f0-9]{64}$/.test(config.key)
    || typeof config.certificate !== "string") throw Error("设备接入文件无效。");
  await chmod(configFile, 0o600);
  const stateFile = join(dirname(configFile), `.souflow-worker-${config.id}.json`);
  let state;
  try { state = JSON.parse(await readFile(stateFile, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw Error("设备本地回执无法读取。");
    state = { instance: randomUUID() };
  }
  if (!idPattern.test(state.instance)) throw Error("设备状态无效。");
  const save = async () => {
    const temp = `${stateFile}.next`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, stateFile);
  };
  await save();
  const pollMs = Number(process.env.SOULFLOW_WORKER_POLL_MS ?? 1500);
  if (!Number.isSafeInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw Error("设备轮询间隔无效。");
  const url = new URL(`/v1/devices/${config.id}/poll`, endpoint);
  const poll = () => new Promise((fulfill, reject) => {
    const payload = JSON.stringify(state);
    const req = request(url, { method: "POST", ca: config.certificate, timeout: 8000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${config.key}` },
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", part => {
        body += part;
        if (body.length > 2_000_000) req.destroy(Error("工单响应过大。"));
      });
      response.on("error", reject);
      response.on("end", () => {
        if ([401, 409, 422].includes(response.statusCode)) return fulfill({ stopped: response.statusCode });
        if (response.statusCode !== 200) return reject(Error("设备接口暂不可用。"));
        try { fulfill(JSON.parse(body)); } catch { reject(Error("设备接口回执无效。")); }
      });
    });
    req.on("timeout", () => req.destroy(Error("设备连接超时。")));
    req.on("error", reject);
    req.end(payload);
  });

  let connected;
  process.stdout.write("正在连接 souflow 工作台。\n");
  for (;;) {
    let receipt;
    try { receipt = await poll(); }
    catch {
      if (connected !== false) process.stdout.write("暂未连到工作台，保留回执并等待恢复。\n");
      connected = false;
      await sleep(pollMs);
      continue;
    }
    if (receipt.stopped) throw Error(`工作台拒绝设备或回执（HTTP ${receipt.stopped}）。请核对接入文件及原设备回执。`);
    if (!connected) process.stdout.write("已连接 souflow 工作台。\n");
    connected = true;
    const task = receipt.task;
    if (task) {
      const index = task.receipts.length;
      const file = task.files[index];
      if (!idPattern.test(task.id) || typeof file?.text !== "string") throw Error("远端工单格式无效。");
      if (state.update?.id !== task.id) process.stdout.write(`已领取文件核验工单 …${task.id.slice(-8)}。\n`);
      const checked = { sha256: createHash("sha256").update(file.text).digest("hex"), bytes: Buffer.byteLength(file.text),
        headings: file.text.split("\n").filter(line => /^ {0,3}#{1,6}(?:\s|$)/.test(line)).length };
      state.update = { id: task.id, receipts: [...task.receipts, checked] };
      await save();
      process.stdout.write(`已核验 ${index + 1}/${task.files.length}，等待回传。\n`);
    } else if (state.update) {
      delete state.update;
      await save();
      process.stdout.write("工单回执已同步。\n");
    }
    await sleep(pollMs);
  }
}

main().catch(error => {
  // 不输出接入文件中的密钥、地址证书或完整网络异常。
  const message = error instanceof Error && /^(请传入|设备|工作台|远端)/.test(error.message) ? error.message : "设备启动失败，请核对接入文件。";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
