import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { libraryRemovalPrompt, type CollectionStorageSnapshot, type useLibraryManagement } from "./LibraryManagement";
import type { LibrarySummary } from "./SearchTypes";
import type { ConnectionErrorProvider } from "./useLibraryConnections";
type Options = {
  libraryManagement: ReturnType<typeof useLibraryManagement>;
  reloadSpaces: () => Promise<LibrarySummary[]>;
  refreshStatus: () => Promise<unknown>;
  removeLibrarySelection: (id: string) => void;
  setConnectionError: (value: string) => void;
  setConnectionErrorProvider: (value: ConnectionErrorProvider) => void;
  setMaintenanceMessage: (value: string) => void;
};
export function useManagedLibraryOperations({ libraryManagement,reloadSpaces,refreshStatus,removeLibrarySelection,setConnectionError,setConnectionErrorProvider,setMaintenanceMessage }: Options) {
  const [editingExclusions,setEditingExclusions] = useState("");
  const [exclusionDraft,setExclusionDraft] = useState("");
  const [savingExclusions,setSavingExclusions] = useState(false);
  const [renamingLibraryId,setRenamingLibraryId] = useState("");
  const [libraryNameDraft,setLibraryNameDraft] = useState("");
  const [relocatingLibraryId,setRelocatingLibraryId] = useState("");
  const [iconCrop,setIconCrop] = useState<{space:LibrarySummary;source:string}|null>(null);
  const active = useRef(true), pending = useRef(new Set<string>());
  const editing = useRef({ editingExclusions, exclusionDraft, renamingLibraryId, libraryNameDraft });
  editing.current = { editingExclusions, exclusionDraft, renamingLibraryId, libraryNameDraft };
  const iconRead = useRef<FileReader | null>(null), iconGeneration = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; ++iconGeneration.current; iconRead.current?.abort(); iconRead.current = null; }; }, []);

  const relocateObsidian = useCallback(async (space: LibrarySummary) => {
    if (!active.current || space.provider !== "obsidian" || pending.current.has("location")) return;
    pending.current.add("location");
    setRelocatingLibraryId(space.id);
    setConnectionErrorProvider("general");
    setConnectionError("");
    try {
      const path = await open({ directory: true, multiple: false, title: `选择“${space.name}”改名或移动后的库文件夹` });
      if (!active.current || typeof path !== "string") return;
      const result = await invoke<{ location: string; warning: string | null }>("relocate_obsidian_library", { libraryId: space.id, path });
      if (!active.current) return;
      await reloadSpaces();
      if (!active.current) return;
      await refreshStatus();
      if (!active.current) return;
      setMaintenanceMessage(`“${space.name}”的文件夹位置已更新，已有索引与资料库关联已保留。${result.warning ? ` 后台更新暂未开始：${result.warning}` : ""}`);
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      pending.current.delete("location");
      if (active.current) setRelocatingLibraryId("");
    }
  }, [reloadSpaces,refreshStatus,setConnectionError,setConnectionErrorProvider,setMaintenanceMessage]);

const removeSpace = useCallback(async (space: LibrarySummary) => {
    const key = `remove:${space.id}`;
    if (!active.current || pending.current.has(key)) return;
    pending.current.add(key);
    try {
      const storage = await invoke<CollectionStorageSnapshot>("get_collection_storage").catch(() => undefined);
      if (!active.current || !window.confirm(libraryRemovalPrompt(space, storage))) return;
      await libraryManagement.act(space.id, "remove");
      if (active.current) removeLibrarySelection(space.id);
    } finally { pending.current.delete(key); }
  }, [libraryManagement.act, removeLibrarySelection]);

const editExclusions = useCallback((space: LibrarySummary) => {
    editing.current.editingExclusions = space.id;
    editing.current.exclusionDraft = (space.excludedPaths ?? []).join("\n");
    setConnectionErrorProvider("general");
    setEditingExclusions(space.id);
    setExclusionDraft((space.excludedPaths ?? []).join("\n"));
    setConnectionError("");
  }, []);

const saveExclusions = useCallback(async () => {
    if (!active.current || !editingExclusions || pending.current.has("exclusions")) return;
    pending.current.add("exclusions");
    setConnectionErrorProvider("general");
    const excludedPaths = exclusionDraft
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    setSavingExclusions(true);
    setConnectionError("");
    try {
      await invoke<string[]>("update_obsidian_exclusions", {
        libraryId: editingExclusions,
        excludedPaths,
      });
      if (!active.current) return;
      await reloadSpaces();
      if (!active.current) return;
      await refreshStatus();
      if (!active.current) return;
      if (editing.current.editingExclusions === editingExclusions && editing.current.exclusionDraft === exclusionDraft) {
        setEditingExclusions(""); setExclusionDraft("");
      }
      setMaintenanceMessage("Vault 排除路径已保存，受影响的本地索引已更新。");
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally {
      pending.current.delete("exclusions");
      if (active.current) setSavingExclusions(false);
    }
  }, [editingExclusions, exclusionDraft, refreshStatus, reloadSpaces]);

const updateLibraryIcon = useCallback(async (space: LibrarySummary, file?: File) => {
    if (!active.current || !file) return;
    const generation = ++iconGeneration.current;
    iconRead.current?.abort(); iconRead.current = null;
    setConnectionErrorProvider("general");
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
    const isSvg = file.type === "image/svg+xml" || extension === ".svg";
    const supportedRaster = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
      || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension);
    if (!isSvg && !supportedRaster) {
      setMaintenanceMessage("资料库图标支持 SVG、PNG、JPG、WebP 和 GIF。");
      return;
    }
    if ((isSvg && file.size > 64 * 1024) || (!isSvg && file.size > 2 * 1024 * 1024)) {
      setMaintenanceMessage(isSvg ? "SVG 图标不能超过 64 KB。" : "图片图标不能超过 2 MB。");
      return;
    }
    try {
      const iconSvg = isSvg
        ? await file.text()
        : await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            iconRead.current = reader;
            reader.onabort = () => reject(new Error("图标读取已停止"));
            reader.onload = () => typeof reader.result === "string"
              ? resolve(reader.result.replace(/^data:application\/octet-stream/i, `data:${
                  extension === ".png" ? "image/png"
                    : extension === ".webp" ? "image/webp"
                      : extension === ".gif" ? "image/gif"
                        : "image/jpeg"
                }`))
              : reject(new Error("无法读取图片图标"));
            reader.onerror = () => reject(reader.error ?? new Error("无法读取图片图标"));
            reader.readAsDataURL(file);
          });
      if (!active.current || generation !== iconGeneration.current) return;
      iconRead.current = null;
      setIconCrop({space,source:isSvg?`data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg)}`:iconSvg});
      setConnectionError("");
    } catch (reason) {
      if (active.current && generation === iconGeneration.current) setConnectionError(String(reason));
    }
  }, []);

const resetLibraryIcon = useCallback(async (space: LibrarySummary) => {
    const key = `icon:${space.id}`;
    if (!active.current || pending.current.has(key)) return;
    pending.current.add(key);
    setConnectionErrorProvider("general");
    try {
      await invoke("update_library_icon", { libraryId: space.id, iconSvg: null });
      if (!active.current) return;
      await reloadSpaces();
      if (!active.current) return;
      setMaintenanceMessage(`“${space.name}”已恢复默认资料库图标。`);
      setConnectionError("");
    } catch (reason) {
      if (active.current) setConnectionError(String(reason));
    } finally { pending.current.delete(key); }
  }, [reloadSpaces]);

const beginRenameLibrary = useCallback((space: LibrarySummary) => {
    editing.current.renamingLibraryId = space.id; editing.current.libraryNameDraft = space.name;
    setRenamingLibraryId(space.id);
    setLibraryNameDraft(space.name);
    setConnectionError("");
  }, []);

const saveLibraryName = useCallback(async () => {
    const name = libraryNameDraft.trim();
    if (!active.current || !renamingLibraryId || !name || pending.current.has("rename")) return;
    pending.current.add("rename");
    try {
      await invoke("rename_library", { libraryId: renamingLibraryId, name });
      if (!active.current) return;
      await reloadSpaces();
      if (!active.current) return;
      if (editing.current.renamingLibraryId === renamingLibraryId && editing.current.libraryNameDraft === libraryNameDraft) {
        setRenamingLibraryId(""); setLibraryNameDraft("");
      }
      setMaintenanceMessage(`资料库名称已改为“${name}”。`);
    } catch (reason) {
      if (active.current) { setConnectionErrorProvider("general"); setConnectionError(String(reason)); }
    } finally { pending.current.delete("rename"); }
  }, [libraryNameDraft, reloadSpaces, renamingLibraryId]);

  const commitLibraryIcon = useCallback(async (space: LibrarySummary, iconSvg: string) => {
    const key = `icon:${space.id}`;
    if (!active.current || pending.current.has(key)) return;
    pending.current.add(key);
    try {
    setConnectionErrorProvider("general");
    await invoke("update_library_icon", { libraryId: space.id, iconSvg });
    if (!active.current) return;
    await reloadSpaces();
    if (!active.current) return;
    setMaintenanceMessage(`“${space.name}”的资料库图标已更新。`);
    setIconCrop(current => current?.space.id === space.id ? null : current);
    } finally { pending.current.delete(key); }
  }, [reloadSpaces,setConnectionErrorProvider,setMaintenanceMessage]);
  return { editingExclusions,setEditingExclusions,exclusionDraft,setExclusionDraft,savingExclusions,
    renamingLibraryId,setRenamingLibraryId,libraryNameDraft,setLibraryNameDraft,iconCrop,setIconCrop,
    relocatingLibraryId,relocateObsidian,removeSpace,editExclusions,saveExclusions,updateLibraryIcon,resetLibraryIcon,beginRenameLibrary,saveLibraryName,commitLibraryIcon };
}
