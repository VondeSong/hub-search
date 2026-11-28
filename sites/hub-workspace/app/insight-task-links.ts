"use client";
import { useEffect, useState } from "react";

export type InsightTaskLink = {
  insightId: string;
  taskId: string;
  libraryId: string;
  insightTitle?: string;
  taskTitle?: string;
  listName?: string;
  sourceLabel?: string;
  createdAt?: string;
};

const STORAGE_KEY = "hub-proto-insight-task-links-v1";
const CHANGE_EVENT = "hub-proto-insight-task-links-change";

export const PROTO_DIDA_LIBRARY_ID = "dida";
export const PROTO_DIDA_LISTS = ["线束项目", "学习安排", "收件箱", "稍后处理"] as const;

const SEED_LINKS: InsightTaskLink[] = [];

export function listInsightTaskLinks(): InsightTaskLink[] {
  if (typeof window === "undefined") return SEED_LINKS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return SEED_LINKS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return SEED_LINKS;
    return parsed.filter(
      (item): item is InsightTaskLink =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof item.insightId === "string" &&
        typeof item.taskId === "string" &&
        typeof item.libraryId === "string",
    );
  } catch {
    return SEED_LINKS;
  }
}

export function saveInsightTaskLink(link: InsightTaskLink): InsightTaskLink[] {
  const current = listInsightTaskLinks();
  const exists = current.some(
    (row) =>
      row.insightId === link.insightId &&
      row.taskId === link.taskId &&
      row.libraryId === link.libraryId,
  );
  const next = exists
    ? current.map((row) =>
        row.insightId === link.insightId &&
        row.taskId === link.taskId &&
        row.libraryId === link.libraryId
          ? { ...row, ...link }
          : row,
      )
    : [{ ...link, createdAt: link.createdAt || new Date().toISOString() }, ...current];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* keep in-memory state */
  }
  return next;
}

export function useInsightTaskLinks() {
  const [links, setLinks] = useState<InsightTaskLink[]>(SEED_LINKS);
  useEffect(() => {
    const sync = () => setLinks(listInsightTaskLinks());
    sync();
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const save = (link: InsightTaskLink) => {
    const next = saveInsightTaskLink(link);
    setLinks(next);
    return next;
  };
  return { links, save };
}
