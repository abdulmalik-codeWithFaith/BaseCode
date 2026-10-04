import { useState } from "react";
import { api, type SearchHit } from "../api";

interface Props {
  onOpen: (path: string, line?: number) => void;
}

export default function SearchPanel({ onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    try {
      setHits((await api.search(query)).hits);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const grouped = new Map<string, SearchHit[]>();
  for (const h of hits ?? []) grouped.set(h.path, [...(grouped.get(h.path) ?? []), h]);

  return (
    <div className="explorer">
      <div className="panel-header">
        <span>SEARCH</span>
      </div>
      <div className="search-box">
        <input
          value={query}
          placeholder="Search in project…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
      </div>
      <div className="tree">
        {busy && <div className="empty-note">Searching…</div>}
        {error && <div className="empty-note error">{error}</div>}
        {hits && !busy && hits.length === 0 && <div className="empty-note">No results</div>}
        {[...grouped.entries()].map(([path, list]) => (
          <div key={path}>
            <div className="search-file">
              {path} <span className="badge">{list.length}</span>
            </div>
            {list.map((h) => (
              <div key={`${h.path}:${h.line}`} className="search-hit" onClick={() => onOpen(h.path, h.line)}>
                <span className="line-no">{h.line}</span>
                <span className="hit-text">{h.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
