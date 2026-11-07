import "./CardSizeControl.css";
export type CardSize = "compact" | "comfortable" | "spacious";
export function CardSizeIcon({size}:{size:CardSize}) {
 const height={compact:8,comfortable:12,spacious:16}[size];
 return <svg className="card-size-icon" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y={(20-height)/2} width="14" height={height} rx="2.3"/></svg>;
}
export function CardSizeControl({value,onChange}:{value:CardSize;onChange:(value:CardSize)=>void}) {
 return <div className="shared-card-sizes" role="group" aria-label="画廊卡片大小">{(["compact","comfortable","spacious"] as const).map(size=><button key={size} aria-label={`${{compact:"小",comfortable:"中",spacious:"大"}[size]}卡片`} title={`${{compact:"小",comfortable:"中",spacious:"大"}[size]}卡片`} aria-pressed={value===size} onClick={()=>onChange(size)}><CardSizeIcon size={size}/></button>)}</div>;
}
