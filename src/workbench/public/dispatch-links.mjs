export function createDispatchLinks(map, canvas) {
  const context = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let frame;
  let links = [];
  let paths = [];
  let colors;
  let visible = false;
  let online = false;
  let animate = false;

  function draw(time = 0) {
    if (!context || !visible || !colors) return;
    context.clearRect(0, 0, map.clientWidth, map.clientHeight);
    context.lineCap = "round";
    for (const { path, state } of paths) {
      const running = state === "running" && animate;
      context.setLineDash([4, 6]);
      context.lineDashOffset = 0;
      context.lineWidth = 1.4;
      context.globalAlpha = online ? .8 : .5;
      context.strokeStyle = online ? colors[state] : colors.idle;
      context.stroke(path);
      if (running) {
        context.setLineDash([5, 38]);
        context.lineDashOffset = -time / 13;
        context.lineWidth = 2.5;
        context.globalAlpha = 1;
        context.strokeStyle = colors.accentDark;
        context.stroke(path);
      }
    }
    if (animate && paths.some(link => link.state === "running")) frame = requestAnimationFrame(draw);
  }

  function layout() {
    if (!context || !visible) return;
    cancelAnimationFrame(frame);
    const ratio = devicePixelRatio;
    canvas.width = Math.round(map.clientWidth * ratio);
    canvas.height = Math.round(map.clientHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const origin = map.getBoundingClientRect();
    const style = getComputedStyle(map);
    const muted = style.getPropertyValue("--muted").trim();
    colors = {
      idle: muted,
      connecting: muted,
      running: style.getPropertyValue("--accent").trim(),
      waiting: style.getPropertyValue("--monitor-waiting").trim(),
      accentDark: style.getPropertyValue("--accent-dark").trim(),
    };
    const vertical = style.getPropertyValue("--topology-direction").trim() === "vertical";
    paths = links.map(({ from, to, state, trunk }) => {
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const path = new Path2D();
      const fromMiddle = a.top + a.height / 2 - origin.top;
      const toMiddle = b.top + b.height / 2 - origin.top;
      if (vertical && trunk) {
        const x = a.left + a.width / 2 - origin.left;
        path.moveTo(x, a.bottom - origin.top);
        path.lineTo(b.left + b.width / 2 - origin.left, b.top - origin.top);
      } else if (vertical) {
        const left = a.left - origin.left;
        const rail = left - 12;
        const end = b.left - origin.left;
        path.moveTo(left, fromMiddle);
        path.lineTo(rail, fromMiddle);
        path.lineTo(rail, toMiddle);
        path.lineTo(end, toMiddle);
      } else {
        const start = a.right - origin.left;
        const end = b.left - origin.left;
        const bend = (start + end) / 2;
        path.moveTo(start, fromMiddle);
        path.bezierCurveTo(bend, fromMiddle, bend, toMiddle, end, toMiddle);
      }
      return { path, state };
    });
    draw(performance.now());
  }

  function updateMotion() {
    cancelAnimationFrame(frame);
    animate = visible && online && !reduced.matches && !document.hidden;
    canvas.dataset.motion = animate && paths.some(link => link.state === "running") ? "flowing" : "still";
    draw(performance.now());
  }

  const resize = new ResizeObserver(layout);
  reduced.addEventListener("change", updateMotion);
  document.addEventListener("visibilitychange", updateMotion);
  return {
    show() {
      visible = true;
      resize.observe(map);
      layout();
      updateMotion();
    },
    hide() {
      visible = false;
      resize.disconnect();
      updateMotion();
    },
    setRoutes(routes) {
      links = routes;
      layout();
      updateMotion();
    },
    setOnline(value) {
      if (online === value) return;
      online = value;
      updateMotion();
    },
  };
}
