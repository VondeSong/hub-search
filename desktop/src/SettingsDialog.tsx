import {
  ChevronRight,
  Cloud,
  Database,
  HardDrive,
  Keyboard,
  Plug,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useOperationStatus } from "./useOperationStatus";

export type SettingsCategory = "libraries" | "display" | "behavior" | "codex" | "mcp" | "index" | "cloud";

type SettingsDialogProps = {
  mobile?: boolean;
  externalModalOpen?: boolean;
  canClose: boolean;
  category: SettingsCategory;
  children: ReactNode;
  onCategoryChange: (category: SettingsCategory) => void;
  onClose: () => void;
};

type SettingsCategoryMeta = {
  value: SettingsCategory;
  label: string;
  desc: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  sepAfter?: boolean;
};

const SETTINGS_CATEGORIES: SettingsCategoryMeta[] = [
  {
    value: "libraries",
    label: "资料库",
    desc: "管理已接入的资料库与来源、同步频率、图标、排除目录及下载识别策略",
    Icon: Database,
  },
  {
    value: "cloud",
    label: "云同步",
    desc: "配置阿里云 OSS 跨设备云同步、附件传输方案、参与设备与云端整理",
    Icon: Cloud,
    sepAfter: true,
  },
  {
    value: "display",
    label: "显示",
    desc: "调整桌面侧边栏、任务状态样式、界面与列表字号及预览阅读比例",
    Icon: SlidersHorizontal,
  },
  {
    value: "behavior",
    label: "操作",
    desc: "设置全局唤醒快捷键、开机自启动与托盘行为、搜索历史及原文打开方式",
    Icon: Keyboard,
    sepAfter: true,
  },
  {
    value: "codex",
    label: "模型与运行",
    desc: "管理 Codex 账号池、模型提供方凭据、默认对话模型与推理运行设置",
    Icon: Sparkles,
  },
  {
    value: "mcp",
    label: "MCP",
    desc: "查看本地 Hub MCP 服务入口并配置外部 AI 客户端接入",
    Icon: Plug,
    sepAfter: true,
  },
  {
    value: "index",
    label: "数据管理",
    desc: "查看数据目录位置、整库备份与迁移、全局识别策略及后台索引维护",
    Icon: HardDrive,
  },
];

type SettingsSearchEntry = {
  category: SettingsCategory;
  title: string;
  desc: string;
  keywords: string;
};

const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    category: "libraries",
    title: "已接入资料库、图标裁剪与排除目录",
    desc: "Craft、Obsidian、飞书、滴答清单状态、同步、改名、图标与 Obsidian 导出",
    keywords: "资料库 craft obsidian 飞书 滴答 图标 裁剪 改名 排除 监听 同步 导出 vault",
  },
  {
    category: "libraries",
    title: "添加或重新连接资料库",
    desc: "接入新的 Craft 空间、Obsidian 仓库、飞书文档/多维表格与滴答清单",
    keywords: "添加 连接 craft obsidian 飞书 多维表格 bitable 滴答 清单 mcp api",
  },
  {
    category: "libraries",
    title: "单库自动同步计划与内容策略",
    desc: "设置单个资料库的同步频率、暂停/恢复同步与附件识别规则",
    keywords: "自动同步 频率 间隔 暂停 恢复 策略 ocr pdf 附件",
  },
  {
    category: "cloud",
    title: "跨设备云同步与阿里云 OSS 连接",
    desc: "配置云空间连接、立即同步、同步模式、凭据更新与空间迁移",
    keywords: "云同步 oss 阿里云 连接 凭据 bucket 立即同步 暂停 迁移",
  },
  {
    category: "cloud",
    title: "跨设备同步内容与附件策略",
    desc: "按模块开关闪卡、阅读、速记与技能同步，配置图片/视频/PDF 附件规则",
    keywords: "同步内容 附件 策略 图片 视频 pdf 流量 wifi 闪卡 阅读 速记 技能",
  },
  {
    category: "cloud",
    title: "同步设备管理与云端修复整理",
    desc: "管理已接入设备、检查点清理与云端历史整理",
    keywords: "设备 退休 恢复 检查点 清理 修复 诊断",
  },
  {
    category: "display",
    title: "桌面左侧边栏与任务状态样式",
    desc: "开关桌面侧边栏，选择任务完成图标样式（实心圆勾 / 圆圈勾）",
    keywords: "侧边栏 任务 状态 图标 样式 实心 圆圈 sidebar",
  },
  {
    category: "display",
    title: "界面、列表与预览正文文字大小",
    desc: "调整界面文字、列表标题字号与字重、预览正文阅读比例",
    keywords: "字号 字体 界面 列表 预览 正文 加粗 排版 密度 缩放 font size",
  },
  {
    category: "display",
    title: "最近文档分组与搜索结果展示",
    desc: "控制首页最近文档时间分组、显示条数与列表摘要信息",
    keywords: "最近 分组 摘要 列表 条数 展示",
  },
  {
    category: "behavior",
    title: "显示/隐藏 Hub 全局快捷键",
    desc: "录制唤醒完整 Hub 主窗口的全局组合键或功能键",
    keywords: "快捷键 唤醒 shortcut hotkey ctrl shift",
  },
  {
    category: "behavior",
    title: "开机自启动与系统托盘隐藏行为",
    desc: "登录自动启动、启动后最小化到托盘、失焦/打开后自动隐藏窗口",
    keywords: "开机 自启动 托盘 隐藏 失焦 窗口 boot tray",
  },
  {
    category: "behavior",
    title: "搜索历史记录管理",
    desc: "开启/关闭历史记录与清空已保存搜索历史",
    keywords: "搜索 历史 清空 search history",
  },
  {
    category: "behavior",
    title: "Craft 原文打开方式与 CraftBridge 检测",
    desc: "配置列表与预览打开 Craft 的方式、检测 CraftBridge 连通性及滴答路径",
    keywords: "craft bridge 原文 打开 定位 网页 协议 检测 滴答 路径",
  },
  {
    category: "behavior",
    title: "全局排除目录复核提醒",
    desc: "管理排除范围的复核提醒频率与开关",
    keywords: "排除 复核 提醒 exclusion",
  },
  {
    category: "codex",
    title: "模型提供方、Codex 账号与 API 凭据",
    desc: "登录或切换 Codex 多账号、配置 DeepSeek 等模型提供方密钥",
    keywords: "codex 账号 模型 提供方 deepseek api key 密钥 登录 额度",
  },
  {
    category: "codex",
    title: "默认对话模型与推理运行策略",
    desc: "选择默认模型、后台轻量任务模型与推理强度设置",
    keywords: "默认 模型 推理 强度 并发 后台 轻量 运行",
  },
  {
    category: "mcp",
    title: "Hub 本地 MCP 服务与外部客户端注册",
    desc: "复制 STDIO 启动器路径并注册到 Codex、Claude 等外部工具",
    keywords: "mcp stdio 启动器 客户端 路径 注册 外部 工具 claude",
  },
  {
    category: "index",
    title: "Hub 数据目录与存储位置更改",
    desc: "查看当前数据路径、打开目录或更改便携/自定义数据位置",
    keywords: "数据目录 位置 迁移 便携 文件夹 空间 storage",
  },
  {
    category: "index",
    title: "整库备份、恢复与换电脑授权迁移",
    desc: "创建与恢复整库备份，准备加密换机授权副本",
    keywords: "备份 恢复 换电脑 迁移 加密 授权 导出 导入",
  },
  {
    category: "index",
    title: "全局下载与识别策略（OCR / PDF）及索引维护",
    desc: "配置默认图片 OCR / PDF 提取规则、重新排队失败 OCR 与清理维护索引",
    keywords: "ocr pdf 识别 下载 内容策略 索引 维护 重试 失败 缓存 清理",
  },
];

export function SettingsDialog({
  mobile = false,
  externalModalOpen = false,
  canClose,
  category,
  children,
  onCategoryChange,
  onClose,
}: SettingsDialogProps) {
  const { operationStatus } = useOperationStatus();
  const [searchQuery, setSearchQuery] = useState("");
  const categories = SETTINGS_CATEGORIES.filter(({ value }) => !mobile || (value !== "mcp" && value !== "codex"));
  const activeMeta = SETTINGS_CATEGORIES.find(({ value }) => value === category) ?? SETTINGS_CATEGORIES[0];
  const trimmedSearch = mobile ? "" : searchQuery.trim();
  const searchMatches = useMemo(() => {
    if (!trimmedSearch) return [];
    const tokens = trimmedSearch.toLowerCase().split(/\s+/).filter(Boolean);
    return SETTINGS_SEARCH_INDEX.filter((entry) => {
      const catLabel = SETTINGS_CATEGORIES.find((item) => item.value === entry.category)?.label ?? "";
      const haystack = `${entry.title} ${entry.desc} ${entry.keywords} ${catLabel}`.toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [trimmedSearch]);

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const canCloseRef = useRef(canClose);
  const onCloseRef = useRef(onClose);
  const externalModalOpenRef = useRef(externalModalOpen);
  const searchQueryRef = useRef(searchQuery);

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [category, trimmedSearch]);

  useEffect(() => {
    canCloseRef.current = canClose;
    onCloseRef.current = onClose;
    externalModalOpenRef.current = externalModalOpen;
    searchQueryRef.current = searchQuery;
  }, [canClose, onClose, externalModalOpen, searchQuery]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const overlay = overlayRef.current;
    if (!dialog || !overlay) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(overlay.parentElement?.children ?? []).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== overlay,
    );
    const siblingState = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    siblings.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });

    const focusableSelector = [
      "button:not([disabled])",
      "[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusDialog = () => dialog.focus({ preventScroll: true });
    const handleFocusIn = (event: FocusEvent) => {
      if (externalModalOpenRef.current) return;
      if (!dialog.contains(event.target as Node)) focusDialog();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (externalModalOpenRef.current) return;
      if (event.key === "Escape") {
        if (searchQueryRef.current.trim()) {
          event.preventDefault();
          setSearchQuery("");
          return;
        }
        if (canCloseRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => {
          for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.hidden || ancestor.getAttribute("aria-hidden") === "true") return false;
            const style = window.getComputedStyle(ancestor);
            if (style.display === "none" || style.visibility === "hidden") return false;
            if (ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")
              && !ancestor.querySelector(":scope > summary")?.contains(element)) return false;
          }
          return true;
        });
      if (!focusable.length) {
        event.preventDefault();
        focusDialog();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    focusDialog();
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
      siblingState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, []);

  if (mobile) {
    return (
      <div ref={overlayRef} className="connection-overlay settings-overlay">
        <section
          ref={dialogRef}
          className="connection-card space-settings"
          data-category={category}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-dialog-title"
          tabIndex={-1}
        >
          <button className="modal-close" onClick={onClose} disabled={!canClose} aria-label="关闭"><X size={18} /></button>
          <div className="settings-brand"><img className="hub-mark" src="/icons/hub.png" srcSet="/icons/hub@2x.png 2x" alt="" /><h2 id="settings-dialog-title">Hub 设置</h2></div>
          <p>管理资料库、软件数据与同步，调整阅读和操作习惯。</p>
          <div className="settings-layout">
            <nav className="settings-category-tabs" aria-label="设置分类">
              {categories.map(({ value, label }) => (
                <button
                  key={value}
                  className={category === value ? "active" : ""}
                  aria-current={category === value ? "page" : undefined}
                  onClick={() => onCategoryChange(value)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <label className="mobile-settings-category-picker">
              <span>设置分类</span>
              <select
                value={category}
                aria-label="设置分类"
                onChange={(event) => onCategoryChange(event.target.value as SettingsCategory)}
              >
                {categories.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <div ref={contentRef} className="settings-detail" role="region" aria-label={activeMeta.label} tabIndex={0}>
              {children}
            </div>
          </div>
          <footer className={`settings-operation-status${operationStatus ? ` ${operationStatus.tone}` : ""}`} role={operationStatus?.tone === "error" ? "alert" : "status"} aria-label="操作状态">
            {operationStatus && <span title={operationStatus.text}>{operationStatus.text}</span>}
          </footer>
        </section>
      </div>
    );
  }

  return (
    <div ref={overlayRef} className="connection-overlay settings-overlay">
      <section
        ref={dialogRef}
        className="connection-card space-settings settings-desktop-shell"
        data-category={category}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
      >
        <button className="modal-close" onClick={onClose} disabled={!canClose} aria-label="关闭"><X size={17} /></button>
        <div className="settings-layout settings-desktop-layout">
          <aside className="settings-sidebar">
            <div className="settings-brand">
              <img className="hub-mark" src="/icons/hub.png" srcSet="/icons/hub@2x.png 2x" alt="" />
              <h2 id="settings-dialog-title">Hub 设置</h2>
            </div>
            <div className="settings-search-box">
              <Search size={13} aria-hidden="true" />
              <input
                type="text"
                aria-label="搜索设置"
                placeholder="搜索设置…"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="settings-search-clear"
                  aria-label="清除设置搜索"
                  onClick={() => setSearchQuery("")}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <nav className="settings-category-tabs" aria-label="设置分类">
              {categories.map(({ value, label, Icon, sepAfter }) => (
                <div key={value} className="settings-nav-item-wrap">
                  <button
                    type="button"
                    className={!trimmedSearch && category === value ? "active" : ""}
                    aria-current={!trimmedSearch && category === value ? "page" : undefined}
                    onClick={() => {
                      setSearchQuery("");
                      onCategoryChange(value);
                    }}
                  >
                    <Icon size={15} className="settings-nav-ico" />
                    <span>{label}</span>
                  </button>
                  {sepAfter && <div className="settings-nav-sep" role="separator" />}
                </div>
              ))}
            </nav>
            <div className="settings-sidebar-footer">
              <span>更改实时保存</span>
            </div>
          </aside>
          <div className="settings-main">
            <header className="settings-pane-header">
              <div className="settings-pane-heading">
                <h3 className="settings-pane-title">{trimmedSearch ? "搜索设置" : activeMeta.label}</h3>
                <p className="settings-pane-desc">
                  {trimmedSearch
                    ? `找到 ${searchMatches.length} 项相关设置，点击直达对应分类`
                    : activeMeta.desc}
                </p>
              </div>
            </header>
            <div
              ref={contentRef}
              className={`settings-detail${trimmedSearch ? " settings-searching" : ""}`}
              role="region"
              aria-label={trimmedSearch ? "搜索设置" : activeMeta.label}
              tabIndex={0}
            >
              {trimmedSearch && (
                <div className="settings-search-results" role="list" aria-label="设置搜索结果">
                  {searchMatches.length > 0 ? searchMatches.map((entry) => {
                    const cat = SETTINGS_CATEGORIES.find((item) => item.value === entry.category)!;
                    return (
                      <button
                        key={`${entry.category}:${entry.title}`}
                        type="button"
                        className="settings-search-hit"
                        onClick={() => {
                          setSearchQuery("");
                          onCategoryChange(entry.category);
                        }}
                      >
                        <span className="settings-search-hit-body">
                          <strong>{entry.title}</strong>
                          <small>{entry.desc}</small>
                        </span>
                        <span className="settings-search-hit-cat">{cat.label}<ChevronRight size={13} /></span>
                      </button>
                    );
                  }) : (
                    <div className="settings-search-empty">
                      <p>未找到与“{trimmedSearch}”匹配的设置项</p>
                      <button type="button" onClick={() => setSearchQuery("")}>清除搜索</button>
                    </div>
                  )}
                </div>
              )}
              <div className="settings-detail-inner" hidden={Boolean(trimmedSearch) && !externalModalOpen}>
                {children}
              </div>
            </div>
            <footer className={`settings-operation-status${operationStatus ? ` ${operationStatus.tone}` : ""}`} role={operationStatus?.tone === "error" ? "alert" : "status"} aria-label="操作状态">
              {operationStatus && <span title={operationStatus.text}>{operationStatus.text}</span>}
            </footer>
          </div>
        </div>
      </section>
    </div>
  );
}
