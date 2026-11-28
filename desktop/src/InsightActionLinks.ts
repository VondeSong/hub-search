import { flushUserProfileStorage, userProfileStorage, userProfileKeys } from "./UserProfileStorage";
import { createDidaTaskSource } from "./TaskPlanningSource";

export type InsightTaskLink = { insightId: string; taskId: string; libraryId: string };
const prefix = "hub.tasks.insight-link.v1.";

// One profile entry per relation keeps concurrent writes for different links independent.
export function listInsightTaskLinks(): InsightTaskLink[] {
  return userProfileKeys(prefix).map(key => JSON.parse(userProfileStorage.getItem(key)!) as InsightTaskLink);
}

export async function saveInsightTaskLink(link: InsightTaskLink): Promise<void> {
  const ids = [link.libraryId, link.taskId, link.insightId];
  if (ids.some(id => !id?.trim())) throw new Error("缺少关联发现或任务的身份");
  userProfileStorage.setItem(prefix + JSON.stringify(ids), JSON.stringify(link));
  await flushUserProfileStorage();
}

type CreateInsightTask = {
  insightId: string;
  title: string;
  priority: 0 | 5;
  libraryId: string;
  projectId?: string;
};

export async function createLinkedInsightTask({ insightId, libraryId, projectId, priority, title }: CreateInsightTask) {
  title = title.trim();
  if (!insightId || !libraryId || !title) throw new Error("请确认来源、任务标题和目标资料库");
  const intent = JSON.stringify([insightId, libraryId, projectId || "", title, priority]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(intent));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const retryKey = "hub.tasks.insight-create.v1." + fingerprint;
  // A lost response or a failed local link can replay the native receipt, even after restart.
  const requestId = userProfileStorage.getItem(retryKey) || "insight-" + fingerprint;
  const receipt = await createDidaTaskSource({ requestId, libraryId, projectId, priority, title });
  if (receipt.state === "failed") {
    userProfileStorage.setItem(retryKey, crypto.randomUUID());
    await flushUserProfileStorage();
    throw new Error(receipt.error || "滴答创建失败，可重试");
  }
  const taskId = receipt.task?.id || receipt.taskId;
  if (receipt.state !== "confirmed" || !taskId || (receipt.libraryId && receipt.libraryId !== libraryId)) {
    throw new Error(receipt.error || "创建结果待核对，重试将沿用同一回执");
  }
  await saveInsightTaskLink({ insightId, libraryId, taskId });
  return receipt;
}
