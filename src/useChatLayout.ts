import { useEffect, useRef, useState, type PointerEvent } from "react";
type Layout = {
  x: number;
  y: number;
  width: number;
  height: number;
  moved: boolean;
};
const key = "forma-chat-layout-v4";
function defaults(): Layout {
  const width = Math.min(520, innerWidth - 24),
    height = Math.min(560, innerHeight * 0.65);
  return {
    x: (innerWidth - width) / 2,
    y: Math.max(76, innerHeight - height - 76),
    width,
    height,
    moved: false,
  };
}
function clamp(v: Layout): Layout {
  const narrow = innerWidth < 650;
  const width = narrow
    ? innerWidth - 24
    : Math.min(Math.max(360, v.width), innerWidth - 24);
  const height = Math.min(Math.max(300, v.height), innerHeight - 96);
  return {
    ...v,
    width,
    height,
    x: narrow ? 12 : Math.min(Math.max(12, v.x), innerWidth - width - 12),
    y: Math.min(Math.max(76, v.y), innerHeight - height - 20),
  };
}
export function useChatLayout(expanded: boolean) {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return clamp(
        JSON.parse(localStorage.getItem(key) || "null") || defaults(),
      );
    } catch {
      return defaults();
    }
  });
  const [collapsedHeight, setCollapsedHeight] = useState(108);
  const [dragging, setDragging] = useState(false);
  const moved = useRef(false);
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(layout));
  }, [layout]);
  useEffect(() => {
    const fn = () => setLayout((v) => (v.moved ? clamp(v) : defaults()));
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  function start(e: PointerEvent<HTMLElement>, edge = "move") {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = e.clientX,
      y = e.clientY,
      original = layout;
    moved.current = false;
    const node = e.currentTarget;
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - x,
        dy = ev.clientY - y;
      if (Math.abs(dx) + Math.abs(dy) < 4 && !moved.current) return;
      moved.current = true;
      setDragging(true);
      let next = { ...original, moved: true };
      if (edge === "move") {
        next.x += dx;
        next.y += dy;
      } else {
        if (edge.includes("e")) next.width += dx;
        if (edge.includes("s")) next.height += dy;
        if (edge.includes("w")) {
          next.width -= dx;
          next.x += dx;
        }
        if (edge.includes("n")) {
          next.height -= dy;
          next.y += dy;
        }
      }
      setLayout(clamp(next));
    };
    const end = () => {
      setDragging(false);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", end);
      node.removeEventListener("pointercancel", end);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  }
  return {
    layout,
    setCollapsedHeight,
    dragging,
    start,
    moved,
    reset: () => setLayout(defaults()),
    style: {
      left: layout.x,
      top: expanded
        ? layout.y
        : Math.min(
            innerHeight - collapsedHeight - 20,
            layout.y + layout.height - collapsedHeight,
          ),
      width: expanded ? layout.width : Math.min(520, layout.width),
      height: expanded ? layout.height : collapsedHeight,
      bottom: "auto",
      transform: "none",
    },
  };
}
