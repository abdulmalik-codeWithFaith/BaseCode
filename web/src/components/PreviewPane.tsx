import { useEffect, useState } from "react";

interface Props {
  /** Bumped by the app whenever a file is saved, to trigger a reload. */
  reloadNonce: number;
  onClose: () => void;
}

/** Accepts "/static/", "/proxy/3000/", ":3000", "3000", or "localhost:3000/path". */
function normalize(input: string): string {
  const v = input.trim();
  if (!v) return "/static/";
  const portOnly = /^:?(\d{2,5})(\/.*)?$/.exec(v);
  if (portOnly) return `/proxy/${portOnly[1]}${portOnly[2] ?? "/"}`;
  const local = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{2,5})(\/.*)?$/.exec(v);
  if (local) return `/proxy/${local[1]}${local[2] ?? "/"}`;
  if (v.startsWith("/")) return v;
  return `/static/${v}`;
}

export default function PreviewPane({ reloadNonce, onClose }: Props) {
  const [address, setAddress] = useState("/static/");
  const [src, setSrc] = useState("/static/");
  const [manualNonce, setManualNonce] = useState(0);

  const go = () => {
    const next = normalize(address);
    setAddress(next);
    setSrc(next);
    setManualNonce((n) => n + 1);
  };

  // Reload on save only for static project previews (dev servers hot-reload themselves).
  const [frameKey, setFrameKey] = useState(0);
  useEffect(() => {
    if (src.startsWith("/static")) setFrameKey((k) => k + 1);
  }, [reloadNonce, src]);

  return (
    <div className="preview-pane">
      <div className="panel-header">
        <span>PREVIEW</span>
        <span className="header-actions">
          <button title="Reload" onClick={() => setFrameKey((k) => k + 1)}>
            ⟳
          </button>
          <button title="Close preview" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>
      <div className="address-bar">
        <input
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="/static/  or  :3000"
        />
        <button onClick={go}>Go</button>
      </div>
      <iframe
        key={`${frameKey}-${manualNonce}`}
        title="Project preview"
        src={src}
        className="preview-frame"
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
      />
      <div className="preview-hint">
        Static files: <code>/static/</code> · Dev server: type its port, e.g. <code>:3000</code>
      </div>
    </div>
  );
}
