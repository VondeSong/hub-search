import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useMobileMenuAppearance } from "./MobileAppearance";
import { useModalFocus } from "./useModalFocus";
import { openQuickJournalCapture } from "./QuickJournalEvents";

export type MobileSpaceActions = {
  onLibraries: () => void;
  onConnections: () => void;
  onAppearance: () => void;
};

export function MobileSpaceMenu({ onClose, onSettings, onLibraries, onConnections, onAppearance }: MobileSpaceActions & { onClose: () => void; onSettings: () => void }) {
  const appearance = useMobileMenuAppearance();
  const panel = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useModalFocus({ active: true, containerRef: panel, onDismiss: onClose });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="mobile-space-layer" role="dialog" aria-modal="true" aria-label="空间与设置" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="mobile-space-menu" tabIndex={-1}>
      <header><h2>空间菜单与外观设置</h2><button type="button" aria-label="关闭空间菜单" onClick={onClose}>完成</button></header>
      <nav aria-label="空间快捷入口">
        <h3>快捷工作流直达</h3>
        <div className="bw-menu-grid">
          <button onClick={() => {onClose(); openQuickJournalCapture();}}>✍️ 记一条速记</button>
          <button onClick={() => {onClose(); onLibraries();}}>🎯 资料库搜索范围</button>
          <button onClick={() => {onClose(); onConnections();}}>☁️ 双链路连接总览</button>
          <button disabled={!appearance.ready} onClick={appearance.toggleSize}>📖 阅读字号：{appearance.large ? "大字 19px" : "标准 17px"}</button>
        </div>
        <h3>主题表面（Base White / 暖纸 / 深色）</h3>
        <div className="bw-menu-grid three">{[["white","☀️ 纯净白"],["paper","📜 暖纸"],["black","🌙 深色"]].map(([id,label]) =>
          <button key={id} disabled={!appearance.ready} aria-pressed={appearance.theme === id} onClick={() => appearance.selectTheme(id)}>{label}</button>)}</div>
        <h3>强调色</h3>
        <div className="bw-menu-grid three">{[["blue","🔵 湖蓝"],["sage","🌿 鼠尾草"],["iris","🟣 鸢尾紫"]].map(([id,label]) =>
          <button key={id} disabled={!appearance.ready} aria-pressed={appearance.accent === id} onClick={() => appearance.selectAccent(id)}>{label}</button>)}</div>
        <details><summary>更多设置</summary><div className="bw-menu-grid">
          <button disabled={!appearance.ready} aria-pressed={appearance.theme === "system"} onClick={() => appearance.selectTheme("system")}>跟随系统主题</button>
          <button onClick={() => {onClose(); onAppearance();}}>外观与阅读</button>
          <button onClick={() => {onClose(); onSettings();}}>设置</button>
        </div></details>
        {appearance.error && <p role="alert">{appearance.error}</p>}
      </nav>
    </section>
  </dialog>, document.body);
}
