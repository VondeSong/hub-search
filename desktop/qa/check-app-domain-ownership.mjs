import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ownedFacts = new Set("spaces ready selectedLibraryIds folders folderId dateFilter sourceFilters searchScope query searchHistory results desktopSidebarEnabled sidebarTags selectedSidebarTag tagResults tagResultsFor relatedSidebarTags tagsLoading dynamicFacets favoriteSidebarTags recentSidebarTags sidebarTagGroups tagProperties selectedTagTaxonomy tagTaxonomyRevision smartCollections favoriteResults viewHistory favoriteFilter syncing storageInfo storageMode storageCustomPath changingStorage cleaning retryingOcr retryingFailedJobs dismissingFailedJobs restartingWatcher exportingLibraryId exportProgress lastExportPath exportError editingExclusions exclusionDraft savingExclusions renamingLibraryId libraryNameDraft maintenanceMessage shortcutMessage updatingShortcut mcpUrl craftApiUrl craftApiKey obsidianPath connectingAction connectionError connectionErrorProvider feishuAppId feishuAppSecret feishuAuthorization selectedFeishuSpaceIds feishuBitableUrl feishuBitableSourceId iconCrop createJournalDate creatingJournal flashcardDueCount taskOpenCount resultsPanePercent".split(" "));
const ownedTypes = new Set(["LibrarySummary", "FolderSummary", "SearchResult", "SidebarTagSummary", "SidebarTagGroup", "TagUserPropertyMap", "TagTaxonomySummary", "DynamicFacetCounts", "StorageInfo", "CraftVaultExportProgress", "SmartCollection", "FeishuAuthorizationSummary"]);
const keys = new Set(["craft-search-history-v1", "craft-search-filters-v1", "craft-search-preview-split-v1", "hub-preview-split-compact-v1", "hub-desktop-sidebar-enabled-v1", "hub-desktop-favorites-v1", "hub-desktop-favorites-v2", "hub-desktop-view-history-v1", "hub-desktop-favorite-tags-v1", "hub-desktop-recent-tags-v1", "hub-desktop-tag-groups-v1", "hub-desktop-tag-properties-v1", "hub-desktop-smart-collections-v1"]);
const owners = ["useAppSettings", "useLibraryRegistry", "useLibraryManagement", "useSearchWorkspaceState", "useSavedResults", "useSidebarTags", "useStorageMaintenance", "useWindowLifecycleControls", "useLibraryConnections", "useManagedLibraryOperations", "useSearchResultData", "useWorkspaceIndexing", "useJournalCreation", "useNavigationBadges", "useResultActions", "useMarkdownLinkOpening"];

/** Checks formal producers and restored facts, while permitting local UI state. */
export function appDomainViolations(source, requireOwners = true) {
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [], imports = new Map(), namespaces = new Map(), aliases = new Map(), nativeAliases = new Set();
  const issue = (node, rule, detail) => violations.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, rule, detail });
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const module = statement.moduleSpecifier.text, bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const entry of bindings.elements) {
      const name = entry.propertyName?.text ?? entry.name.text;
      imports.set(entry.name.text, { module, name });
      if (module === "@tauri-apps/api/core" && name === "invoke") nativeAliases.add(entry.name.text);
    }
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, module);
  }
  const callName = expression => {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? imports.get(expression.text)?.name ?? expression.text;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) return expression.name.text;
    return "";
  };
  const isNativeProducer = expression => ts.isIdentifier(expression) ? nativeAliases.has(expression.text)
    : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.get(expression.expression.text) === "@tauri-apps/api/core" && expression.name.text === "invoke";
  const app = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "App");
  if (!app?.body) return [{ line: 1, rule: "missing-app", detail: "App function is absent" }];
  const localComponents = new Map(file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && node.body).map(node => [node.name.text, node]));
  const assemblyPath = new Set([app]);
  const count = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
      aliases.set(node.name.text, callName(node.initializer));
      if (isNativeProducer(node.initializer)) nativeAliases.add(node.name.text);
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      count.set(name, (count.get(name) ?? 0) + 1);
      if (isNativeProducer(node.expression)) issue(node, "native-producer", "Native domain operations belong to their formal owner");
      if (name === "useState") {
        const declaration = node.parent;
        const identifiers = [];
        const findNames = child => { if (ts.isIdentifier(child)) identifiers.push(child.text); ts.forEachChild(child, findNames); };
        if (ts.isVariableDeclaration(declaration)) findNames(declaration.name);
        const types = [];
        for (const argument of node.typeArguments ?? []) { const findTypes = child => { if (ts.isIdentifier(child)) types.push(child.text); ts.forEachChild(child, findTypes); }; findTypes(argument); }
        if (identifiers.some(identifier => ownedFacts.has(identifier)) || types.some(type => ownedTypes.has(type))) issue(node, "domain-state", `Restored domain fact remains in App: ${identifiers.join(", ")}`);
      }
    }
    if (ts.isStringLiteralLike(node) && keys.has(node.text)) issue(node, "domain-persistence", `Persistence key remains in App: ${node.text}`);
    // App may wrap its actual content in providers. Trace each rendered local
    // component instance so wrappers neither hide producers nor conceal duplicates.
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName)) {
      const component = localComponents.get(node.tagName.text);
      if (component) {
        if (assemblyPath.has(component)) issue(node, "assembly-cycle", `Recursive local component: ${node.tagName.text}`);
        else { assemblyPath.add(component); visit(component.body); assemblyPath.delete(component); }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(app.body);
  // Module-level key aliases also constitute a persistence owner in this file.
  for (const node of file.statements) if (ts.isVariableStatement(node)) { const visitKeys = child => { if (ts.isStringLiteralLike(child) && keys.has(child.text)) issue(child, "domain-persistence", `Module-level persistence key: ${child.text}`); ts.forEachChild(child, visitKeys); }; visitKeys(node); }
  if (requireOwners) for (const owner of owners) if (count.get(owner) !== 1) issue(app, "owner-identity", `${owner} must have exactly one instance; found ${count.get(owner) ?? 0}`);
  return violations;
}

export function readAppDomainSource() {
  return fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/App.tsx"), "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/App.tsx");
  const violations = appDomainViolations(fs.readFileSync(app, "utf8"));
  process.stdout.write(JSON.stringify({ app, violations }, null, 2) + "\n");
  process.exitCode = violations.length ? 1 : 0;
}
