let requestedSection: "dida-cleanup" | undefined;
export const openCloudSyncSettings = () => {
  requestedSection = undefined;
  window.dispatchEvent(new Event("hub:open-cloud-sync-settings"));
};
export const openDidaReadingCleanupSettings = () => {
  requestedSection = "dida-cleanup";
  window.dispatchEvent(new Event("hub:open-cloud-sync-settings"));
};
export const consumeCloudSyncSettingsSection = () => {
  const section = requestedSection;
  requestedSection = undefined;
  return section;
};
