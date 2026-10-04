import { useCallback, useRef, useState } from "react";

/** Pointer-drag resizing for panels. `invert` flips direction (panels anchored right/bottom). */
export function useSplit(initial: number, min: number, max: number, axis: "x" | "y", invert = false) {
  const [size, setSize] = useState(initial);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const start = axis === "x" ? e.clientX : e.clientY;
      const startSize = sizeRef.current;
      document.body.classList.add("dragging", axis === "x" ? "dragging-x" : "dragging-y");

      const move = (ev: MouseEvent) => {
        const pos = axis === "x" ? ev.clientX : ev.clientY;
        const delta = invert ? start - pos : pos - start;
        const hi = Math.min(max, axis === "x" ? window.innerWidth - 200 : window.innerHeight - 160);
        setSize(Math.max(min, Math.min(hi, startSize + delta)));
      };
      const up = () => {
        document.body.classList.remove("dragging", "dragging-x", "dragging-y");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [axis, invert, max, min],
  );

  return [size, onMouseDown] as const;
}
