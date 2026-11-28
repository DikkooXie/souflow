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

function clearEnrollment(result) {
  if (result.dataset.file) URL.revokeObjectURL(result.dataset.file);
  delete result.dataset.file;
  result.replaceChildren();
}

function showEnrollment(result, node, data, command) {
  clearEnrollment(result);
  const file = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const filename = `souflow-device-${data.id.slice(0, 8)}.json`;
  const link = node("a", "", "下载设备接入文件");
  link.href = file;
  link.download = filename;
  result.dataset.file = file;
  result.append(node("p", "", `设备 ID ${data.id} · 接入地址 ${data.endpoint}`));
  if (command) {
    const worker = node("a", "", "下载设备程序");
    worker.href = "/souflow-worker.mjs";
    worker.download = "souflow-worker.mjs";
    result.append(worker, " · ", link,
      node("p", "", "把两个文件放到新设备上的同一目录，再打开终端进入该目录。"),
      node("code", "archive-text", `node souflow-worker.mjs ${filename}`));
  } else {
    result.append(link, node("p", "", "请管理员按设备 ID 加载执行许可，再在 Mac 上用接入文件启动代码连接器。"));
  }
}

function createPersonalDevices(node) {
  const panel = document.querySelector("#personal-home");
  const section = document.querySelector("#personal-devices");
  const identity = document.querySelector("#personal-identity");
  const list = document.querySelector("#personal-device-list");
  const empty = document.querySelector("#personal-devices-empty");
  if (!panel || !section || !identity || !list || !empty) return;

  const path = "/api/remote/personal-devices";
  const form = node("form");
  const label = node("label", "", "设备名称 ");
  const name = node("input");
  name.maxLength = 40;
  name.required = true;
  label.append(name);
  const connect = node("button", "button button-primary", "连接");
  connect.type = "submit";
  const confirm = node("button", "button", "确认连接");
  confirm.type = "button";
  const feedback = node("p");
  feedback.setAttribute("role", "status");
  const result = node("div");
  form.hidden = confirm.hidden = true;
  form.append(label, " ", connect);
  section.append(form, confirm, feedback, result);

  let member = "";
  let generation = 0;
  let read;
  let action;
  let code;
  let rendered;
  const visibleMember = () => panel.hidden || section.hidden || identity.hidden ? "" : identity.textContent;
  const isCurrent = epoch => epoch === generation && !!member && member === visibleMember();

  function invalidateActions() {
    generation += 1;
    code = undefined;
    if (!action) return;
    const { request, button } = action;
    action = undefined;
    request.abort();
    button.disabled = false;
  }

  function renderDevices(devices) {
    const key = JSON.stringify(devices);
    if (key === rendered) return;
    rendered = key;
    const focusedDevice = list.contains(document.activeElement) ? document.activeElement.dataset.device : undefined;
    list.replaceChildren(...devices.map(device => {
      const state = device.online ? (device.ready ? "在线 · 就绪" : "在线 · 未就绪") : "离线";
      const capacity = device.online ? ` · 空位 ${device.availableSlots}/${device.slots}` : "";
      const row = node("li", "monitor-meta", `${device.name} · 所有者 ${device.owner} · ${state}${capacity}`);
      row.append(node("p", "", `${device.id} · ${device.permitted ? "已获执行许可" : "待执行许可"}`));
      const revoke = node("button", "button", "撤销接入");
      revoke.type = "button";
      revoke.dataset.device = device.id;
      revoke.addEventListener("click", () => {
        if (!window.confirm(`撤销 ${device.name} 的设备接入？`)) return;
        void submit(revoke, `${device.id}/revoke`, {}, () => {
          clearEnrollment(result);
          feedback.textContent = "已撤销设备接入。";
          renderDevices(devices.filter(item => item.id !== device.id));
          read?.abort();
          read = undefined;
          void refresh();
        });
      });
      row.append(revoke);
      return row;
    }));
    list.hidden = !devices.length;
    empty.hidden = !!devices.length;
    if (focusedDevice) [...list.querySelectorAll("button")]
      .find(button => button.dataset.device === focusedDevice)?.focus({ preventScroll: true });
  }

  async function refresh() {
    const epoch = generation;
    if (!isCurrent(epoch) || read) return;
    const request = new AbortController();
    read = request;
    try {
      const response = await fetch(path, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]) });
      const data = response.ok ? await response.json() : undefined;
      if (!isCurrent(epoch) || read !== request) return;
      if (data?.identity === member) {
        form.hidden = false;
        renderDevices(data.devices);
      } else if (response.ok || [401, 403, 404].includes(response.status)) {
        // 设备接口可能先于主页发现身份失效，此时迟到的确认回执也必须作废。
        invalidateActions();
        form.hidden = confirm.hidden = true;
        renderDevices([]);
        clearEnrollment(result);
        feedback.textContent = "";
      }
    } catch { /* 保留最近一次读取的设备状态，下一轮重新请求。 */ }
    finally { if (read === request) read = undefined; }
  }

  async function submit(button, route, body, update) {
    const epoch = generation;
    if (!isCurrent(epoch) || action) return;
    const request = new AbortController();
    const current = { request, button };
    action = current;
    button.disabled = true;
    feedback.textContent = "";
    try {
      const response = await fetch(`${path}/${route}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]) });
      const data = await response.json();
      if (!isCurrent(epoch) || action !== current) return;
      if (!response.ok) throw Error(data.error);
      update(data);
    } catch (error) {
      if (isCurrent(epoch) && action === current) feedback.textContent = error.message || "设备操作暂不可用。";
    } finally {
      if (action === current) {
        action = undefined;
        button.disabled = false;
      }
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const deviceName = name.value.trim();
    void submit(connect, "pair", { name: deviceName }, data => {
      code = data.code;
      confirm.hidden = false;
      feedback.textContent = `请在 5 分钟内确认连接 ${deviceName}。`;
      confirm.focus();
    });
  });
  confirm.addEventListener("click", () => {
    if (!code) return;
    void submit(confirm, "confirm", { code }, data => {
      code = undefined;
      confirm.hidden = true;
      form.reset();
      showEnrollment(result, node, data, false);
      feedback.textContent = "设备已绑定。";
      result.querySelector("a")?.focus();
      read?.abort();
      read = undefined;
      void refresh();
    });
  });

  function updateMember() {
    const next = visibleMember();
    if (next === member) return;
    member = next;
    invalidateActions();
    read?.abort();
    read = rendered = undefined;
    form.hidden = confirm.hidden = true;
    form.reset();
    renderDevices([]);
    clearEnrollment(result);
    feedback.textContent = "";
    void refresh();
  }
  const observer = new MutationObserver(updateMember);
  for (const element of [panel, section, identity]) observer.observe(element, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(identity, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });
  setInterval(() => void refresh(), 1500);
  updateMember();
}

export function createRemoteWorkers(node) {
  createPersonalDevices(node);
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
      showEnrollment(result, node, data, true);
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
    const key = JSON.stringify([data.devices.map(({ id, name, status, code }) => [id, name, status, code]), data.canManage]);
    if (rendered === key) return;
    rendered = key;
    const nameById = new Map(data.devices.map(device => [device.id, device.name]));
    const selection = selector.value;
    const verificationDevices = data.devices.filter(device => !device.code);
    selector.replaceChildren(...verificationDevices.map(device => {
      const option = node("option", "", `${device.name} · ${deviceStatus[device.status]}`);
      option.value = device.id;
      return option;
    }));
    if (nameById.has(selection)) selector.value = selection;
    devices.replaceChildren(...data.devices.map(device => {
      const item = node("li", "monitor-meta", `${device.name} · ${device.code ? "代码设备" : deviceStatus[device.status]}`);
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
