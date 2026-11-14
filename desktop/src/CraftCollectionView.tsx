import { useState, type ReactNode } from "react";
import { Columns3, Table2 } from "lucide-react";
import type { CraftCollection } from "./CraftCollectionData";

export function CraftCollectionView({ collection, renderValue }: { collection: CraftCollection; renderValue: (value: string) => ReactNode }) {
  const [mode, setMode] = useState<"table" | "gallery">("table");
  const [limit, setLimit] = useState(50);
  const rows = collection.rows.slice(0, limit);
  const hasBody = collection.rows.some(row => row.body);
  return <section className="preview-craft-collection" aria-label={`合集 ${collection.title}`}>
    <header><div><strong>{collection.title}</strong><small>{collection.rows.length} 条记录</small></div>
      <div role="group" aria-label="合集视图"><button aria-pressed={mode === "table"} onClick={() => setMode("table")}><Table2 size={14} />表格</button>
        <button aria-pressed={mode === "gallery"} onClick={() => setMode("gallery")}><Columns3 size={14} />画廊</button></div>
    </header>
    {!rows.length ? <p>此合集暂无已缓存记录。</p> : mode === "table" ? <div className="preview-table-scroll" role="region" aria-label="合集表格，可横向滚动" tabIndex={0}><table>
      <thead><tr><th>名称</th>{collection.columns.map(name => <th key={name}>{name}</th>)}{hasBody && <th>内容</th>}</tr></thead>
      <tbody>{rows.map((row,index) => <tr key={index}><td>{renderValue(row.title)}</td>{collection.columns.map(name => <td key={name}>{renderValue(row.values[name] || "")}</td>)}
        {hasBody && <td>{renderValue(row.body)}</td>}</tr>)}</tbody>
    </table></div> : <div className="preview-craft-gallery">{rows.map((row,index) => <article key={index}>
      <h3>{row.title}</h3>{collection.columns.map(name => <div key={name}><small>{name}</small>{renderValue(row.values[name] || "")}</div>)}
      {row.body && renderValue(row.body)}</article>)}</div>}
    {collection.rows.length > limit && <button onClick={() => setLimit(value => value + 50)}>显示更多记录</button>}
  </section>;
}
