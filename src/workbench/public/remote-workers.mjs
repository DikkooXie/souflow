const deviceStatus = { pending: "待接入", online: "在线", offline: "离线" };
const statuses = { queued: "等待领取", running: "正在核验", ready: "核验通过", failed: "核验未通过", revoked: "设备已撤销" };
export const remoteJobStatus = job => job.status === "running" && job.deviceStatus === "offline" ? "等待重连" : statuses[job.status];

export const remoteProgress = job => `已回传 ${job.receipts.length}/${job.files.length}`;

export function remoteTopologyJobs(jobs, deviceId, animateLink) {
  return jobs.filter(job => job.deviceId === deviceId && (job.status === "queued" || job.status === "running")).map(job => {
    const status = job.status === "running" && job.deviceStatus !== "online" ? "interrupted" : job.status;
    const linkState = status === "queued" || (status === "running" && !animateLink) ? "idle" : status;
    return {
      id: job.id, status, linkState, label: remoteJobStatus(job),
      task: `文件核验 · ${job.receipts.length}/${job.files.length}`,
    };
  });
}

export function createRemoteWorkers(node) {
  const section = document.querySelector("#remote-workers");
  const enrol = document.querySelector("#remote-enrol");
  const enqueue = document.querySelector("#remote-enqueue");
  const selector = document.querySelector("#remote-device");
  const result = document.querySelector("#remote-enrol-result");
  const feedback = document.querySelector("#remote-feedback");
  const devices = document.querySelector("#remote-devices");
  let rendered;

  async function submit(button, path, body, update) {
    button.disabled = true;
    feedback.textContent = "";
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      update(data);
    } catch (error) {
      feedback.textContent = error.message || "设备操作暂不可用。";
    } finally {
      button.disabled = false;
    }
  }

  enrol.addEventListener("submit", event => {
    event.preventDefault();
    const name = new FormData(enrol).get("name").trim();
    void submit(enrol.querySelector("button"), "/api/remote/devices", { name }, data => {
      const contents = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const file = URL.createObjectURL(contents);
      const name = `souflow-device-${data.id.slice(0, 8)}.json`;
      const link = node("a", "", "下载设备接入文件");
      link.href = file;
      link.download = name;
      const worker = node("a", "", "下载设备程序");
      worker.href = "/souflow-worker.mjs";
      worker.download = "souflow-worker.mjs";
      if (result.dataset.file) URL.revokeObjectURL(result.dataset.file);
      result.dataset.file = file;
      result.replaceChildren(node("p", "", `接入地址 ${data.endpoint}`), worker, " · ", link,
        node("p", "", "把两个文件放到新设备上的同一目录，再打开终端进入该目录。"),
        node("code", "archive-text", `node souflow-worker.mjs ${name}`));
      enrol.reset();
    });
  });

  enqueue.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(enqueue);
    void submit(enqueue.querySelector("button"), "/api/remote/jobs", { deviceId: data.get("device"), paths: data.get("paths").trim().split(/\s+/) }, () => {
      feedback.textContent = "已发出远端核验工单。";
    });
  });

  return data => {
    section.hidden = !data;
    if (!data) return;
    enrol.hidden = enqueue.hidden = !data.canManage;
    const key = JSON.stringify([data.devices.map(({ id, name, status }) => [id, name, status]), data.canManage]);
    if (rendered === key) return;
    rendered = key;
    const nameById = new Map(data.devices.map(device => [device.id, device.name]));
    const selection = selector.value;
    selector.replaceChildren(...data.devices.map(device => {
      const option = node("option", "", `${device.name} · ${deviceStatus[device.status]}`);
      option.value = device.id;
      return option;
    }));
    if (nameById.has(selection)) selector.value = selection;
    devices.replaceChildren(...data.devices.map(device => {
      const item = node("li", "monitor-meta", `${device.name} · ${deviceStatus[device.status]}`);
      if (data.canManage) {
        const button = node("button", "button", "撤销接入");
        button.type = "button";
        button.addEventListener("click", () => {
          if (!confirm(`撤销 ${device.name} 的设备接入？`)) return;
          void submit(button, `/api/remote/devices/${device.id}/revoke`, {}, () => { feedback.textContent = "已撤销设备接入。"; });
        });
        item.append(" ", button);
      }
      return item;
    }));
  };
}
