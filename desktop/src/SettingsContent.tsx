import { lazy, Suspense, useRef } from "react";
import type { ComponentProps } from "react";
import type { BehaviorSettingsSection } from "./BehaviorSettingsSection";
import type { DisplaySettingsSection } from "./DisplaySettingsSection";
import type { IndexMaintenanceSettingsSection } from "./IndexMaintenanceSettingsSection";
import type { ManagedSpacesSection } from "./ManagedSpacesSection";
import type { SettingsCategory } from "./SettingsDialog";
import type { SettingsConnectionsSection } from "./SettingsConnectionsSection";
import type { StorageSyncSettingsSection } from "./StorageSyncSettingsSection";

const LazyBehaviorSettingsSection = lazy(() => import("./BehaviorSettingsSection").then((module) => ({ default: module.BehaviorSettingsSection })));
const LazyDisplaySettingsSection = lazy(() => import("./DisplaySettingsSection").then((module) => ({ default: module.DisplaySettingsSection })));
const LazyIndexMaintenanceSettingsSection = lazy(() => import("./IndexMaintenanceSettingsSection").then((module) => ({ default: module.IndexMaintenanceSettingsSection })));
const LazyManagedSpacesSection = lazy(() => import("./ManagedSpacesSection").then((module) => ({ default: module.ManagedSpacesSection })));
const LazyMcpSettingsSection = lazy(() => import("./McpSettingsSection").then((module) => ({ default: module.McpSettingsSection })));
const LazyCodexSuiteSettings = lazy(() => import("./CodexSuiteSettings").then((module) => ({ default: module.CodexSuiteSettings })));
const LazySettingsConnectionsSection = lazy(() => import("./SettingsConnectionsSection").then((module) => ({ default: module.SettingsConnectionsSection })));
const LazyStorageSyncSettingsSection = lazy(() => import("./StorageSyncSettingsSection").then((module) => ({ default: module.StorageSyncSettingsSection })));
const LazyCloudSyncSettingsSection = lazy(() => import("./CloudSyncSettingsSection").then((module) => ({ default: module.CloudSyncSettingsSection })));

export type SettingsContentProps = {
  category: SettingsCategory;
  managedSpaces: ComponentProps<typeof ManagedSpacesSection>;
  storageSync: ComponentProps<typeof StorageSyncSettingsSection>;
  display: ComponentProps<typeof DisplaySettingsSection>;
  behavior: ComponentProps<typeof BehaviorSettingsSection>;
  indexMaintenance: ComponentProps<typeof IndexMaintenanceSettingsSection>;
  connections: ComponentProps<typeof SettingsConnectionsSection>;
};

export function SettingsContent({
  category,
  managedSpaces,
  storageSync,
  display,
  behavior,
  indexMaintenance,
  connections,
}: SettingsContentProps) {
  const visitedCategories = useRef(new Set<SettingsCategory>());
  visitedCategories.current.add(category);
  const visited = visitedCategories.current;

  return (
    <>
      {visited.has("libraries") && <Suspense fallback={<CategoryLoading category="libraries" />}>
        <LazyManagedSpacesSection {...managedSpaces} />
      </Suspense>}
      <div className="background-settings settings-content-panels">
        {visited.has("cloud") && <Suspense fallback={<CategoryLoading category="cloud" />}>
          <LazyCloudSyncSettingsSection active={category === "cloud"} />
        </Suspense>}
        {visited.has("display") && <Suspense fallback={<CategoryLoading category="display" />}>
          <LazyDisplaySettingsSection {...display} />
        </Suspense>}
        {visited.has("behavior") && <Suspense fallback={<CategoryLoading category="behavior" />}>
          <LazyBehaviorSettingsSection {...behavior} />
        </Suspense>}
        {!behavior.runtimeCapabilities.mobile && visited.has("mcp") && <Suspense fallback={<CategoryLoading category="mcp" />}>
          <LazyMcpSettingsSection />
        </Suspense>}
        {!behavior.runtimeCapabilities.mobile && category === "codex" && <Suspense fallback={<CategoryLoading category="codex" />}>
          <LazyCodexSuiteSettings />
        </Suspense>}
        {visited.has("index") && <Suspense fallback={<CategoryLoading category="index" />}>
          <LazyStorageSyncSettingsSection
            {...storageSync}
            advancedSettings={<LazyIndexMaintenanceSettingsSection {...indexMaintenance} />}
          />
        </Suspense>}
      </div>
      {visited.has("libraries") && <Suspense fallback={<CategoryLoading category="libraries" />}>
        <LazySettingsConnectionsSection {...connections} />
      </Suspense>}
    </>
  );
}

function CategoryLoading({ category }: { category: SettingsCategory }) {
  return <div className={`settings-category settings-category-loading ${category}`} role="status">正在载入设置…</div>;
}
