import { USER_PROFILE_PREPARE_FLUSH_EVENT, userProfileStorage } from "./UserProfileStorage";
import { useFlashcardStudyPlan } from "./useFlashcardStudyPlan";
import {AgentFlashcardMaterial} from "./StandaloneAgentLauncher";
import { FlashcardDeckTree } from "./FlashcardDeckTree";
import { buildDeckHierarchy } from "./FlashcardDeckHierarchy";
import { CardSizeIcon } from "./CardSizeControl";
import type { QualityTarget } from "./FlashcardQuality";
import { formatReviewInterval, useFlashcardSchedulePreview } from "./FlashcardScheduling";
import { inboxDraftIdsFromTransfer } from "./FlashcardInboxTransfer";
import { MobileTabBar } from "./MobileTabBar";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  BookOpenCheck,
  BookPlus,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CirclePlus,
  Cloud,
  Columns3,
  Copy,
  ExternalLink,
  Eye,
  Filter,
  Grid2X2,
  GripVertical,
  Folder,
  FolderOpen,
  History,
  Image as ImageIcon,
  Inbox,
  LayoutDashboard,
  Layers3,
  List,
  ListFilter,
  LoaderCircle,
  PanelLeftOpen,
  Palette,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  RotateCcw,
  SkipForward,
  Search,
  Save,
  Settings2,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type {
  Flashcard,
  FlashcardDashboardStats,
  FlashcardDeckSummary,
  FlashcardDeckFolderSummary,
  FlashcardDraft,
  FlashcardDraftResolutionResult,
  FlashcardSyncSettings,
  FlashcardSyncSummary,
  FlashcardQualityReport,
  FlashcardMedia,
  FlashcardOcclusion,
} from "./FlashcardTypes";
import { flashcardFrontPreview } from "./FlashcardPresentation";
import { useWorkspaceSession, useWorkspaceScroll } from "./useWorkspaceSession";
import { WorkspaceFilterSummary } from "./WorkspaceFilterSummary";
import {
  DECK_VIEW_DEFAULT_NAMES,
  LEGACY_DECK_VIEW_NAMES,
  loadActiveDeckViewId,
  loadDeckViews,
  loadDeckViewType,
  saveActiveDeckViewId,
  saveDeckViews,
  saveDeckViewType,
  type CardColorName,
  type CardColorOperator,
  type CardColorRule,
  type CardFieldKey,
  type CardPropertyKey,
  type DeckDatabaseView,
  type DeckViewConfig,
} from "./FlashcardDeckViews";
import { correctReviewOrdering, recommendedReviewRating, reviewOrderingMatches, typedReviewAnswerMatches } from "./FlashcardReview";
import {
  FLASHCARD_STAGE_LABELS as CARD_STAGE_LABELS,
  flashcardStage as cardStage,
  type FlashcardStage,
  type FlashcardSort as CardSort,
} from "./FlashcardWorkspacePresentation";
import { FlashcardAttachment } from "./FlashcardAttachment";
import { openCloudSyncSettings } from "./CloudSyncEvents";
import { useVisiblePolling } from "./useVisiblePolling";
import { loadFlashcardsByIds } from "./FlashcardQueries";
import { useFlashcardBrowser } from "./useFlashcardBrowser";
import { ViewRequest } from "./ViewRequest";
import { useWindowResumeRefresh } from "./useWindowResumeRefresh";
import { useFlashcardDataRefresh } from "./useFlashcardDataRefresh";
import { useExternalLinkOpener } from "./useExternalLinkOpener";
import { useModalFocus } from "./useModalFocus";
import { editorValuesForCard, emptyEditorValues, serializeEditorValues, type FlashcardEditorValues } from "./FlashcardEditorState";
import { clearFlashcardEditorDraft, flashcardEditorDraftMatches, loadFlashcardEditorDraft, saveFlashcardEditorDraft, type FlashcardEditorDraft } from "./EditorDraftStorage";
import { loadFlashcardReviewSession, saveFlashcardReviewSession, useFlashcardReviewSession } from "./FlashcardReviewSession";
import { DAILY_NEW_CARD_LIMIT_KEY, DAILY_NEW_CARD_LIMIT_OPTIONS, loadDailyNewCardLimit, remainingNewCardAllowance, todayFlashcardDueCount } from "./FlashcardStudyPlan";
import { isEditorSaveShortcut } from "./EditorShortcuts";
import { editorSaveErrorDetail } from "./EditorSaveStatus";
import { validateFlashcardEditor, type FlashcardEditorValidationIssue } from "./FlashcardEditorValidation";
import "./FlashcardsWorkspace.css";
import { FlashcardTodayProgress } from "./FlashcardTodayProgress";

const FlashcardInbox = lazy(() => import("./FlashcardInbox").then(module => ({ default: module.FlashcardInbox })));
const StudyDashboard = lazy(() => import("./StudyDashboard").then(module => ({ default: module.StudyDashboard })));
const FlashcardQuality = lazy(() => import("./FlashcardQuality").then(module => ({ default: module.FlashcardQuality })));
const FlashcardBackup = lazy(() => import("./FlashcardBackup").then(module => ({ default: module.FlashcardBackup })));
const ImageOcclusionCanvas = lazy(() => import("./ImageOcclusionCanvas").then(module => ({ default: module.ImageOcclusionCanvas })));

type Props = {
  initialCardId?: string;
  onSearchTargetHandled?: () => void;
  onClose: () => void;
  onDueCountChange?: (count: number) => void;
  desktopSidebarVisible?: boolean;
  onToggleDesktopSidebar?: () => void;
  sourceOpenMode?: "bridge" | "web" | "client";
  onStatusMessage?: (text: string, tone?: "working" | "success" | "error", duration?: number) => void;
};


type FlashcardView = "inbox" | "due" | "stats" | "cards" | "deck";
type EditableCardField = "question" | "answer" | "explanation";
type CardConfigPage = "root" | "colors" | "properties" | "layout" | "gallery";
type DeckTreeContextTarget = { kind: "deck" | "folder"; id: string; name: string; x: number; y: number };

const DECK_FOLDER_EXPANSION_KEY = "hub.flashcards.deck-folder-expansion";
const DECK_SIDEBAR_WIDTH_KEY = "hub.flashcards.deck-sidebar-width-v1";
const DEFAULT_DECK_SIDEBAR_WIDTH = 264;
const MIN_DECK_SIDEBAR_WIDTH = 216;
const MAX_DECK_SIDEBAR_WIDTH = 380;
const MIN_FLASHCARD_CONTENT_WIDTH = 480;
const CARD_PROPERTY_LABELS: Record<CardPropertyKey, string> = { answer: "答案", explanation: "解释", type: "卡片类型", status: "学习状态", deck: "所属牌组", sourceTitle: "来源标题", sourcePath: "来源路径", tags: "标签", confidence: "置信度", media: "图片" };
const ALL_CARD_PROPERTY_KEYS: CardPropertyKey[] = ["answer", "explanation", "type", "status", "deck", "sourceTitle", "sourcePath", "tags", "confidence", "media"];
const CARD_COLOR_STYLES: Record<CardColorName, { accent: string; background: string }> = {
  gray: { accent: "#8a918d", background: "#f4f5f4" }, blue: { accent: "#6f98be", background: "#f2f7fa" }, green: { accent: "#68a077", background: "#f2f8f3" }, yellow: { accent: "#c5a349", background: "#fcf9ed" }, orange: { accent: "#d4934d", background: "#fdf7ef" }, red: { accent: "#bd6670", background: "#fbf2f3" }, purple: { accent: "#8970b7", background: "#f7f4fb" },
};
const CARD_COLOR_LABELS: Record<CardColorName, string> = { gray: "灰色", blue: "蓝色", green: "绿色", yellow: "黄色", orange: "橙色", red: "红色", purple: "紫色" };
const TAG_COLOR_STYLES = [
  { background: "#e7f3ec", color: "#376c51" }, { background: "#eee8f7", color: "#654c82" },
  { background: "#e9f0f8", color: "#456687" }, { background: "#f8eadf", color: "#8a5c37" },
  { background: "#f7e8ee", color: "#875265" }, { background: "#f5f0dc", color: "#79662e" },
  { background: "#ececea", color: "#5f625f" },
];

function flashcardTagStyle(tag: string): CSSProperties {
  const index = [...tag].reduce((sum, character) => ((sum * 31) + (character.codePointAt(0) ?? 0)) >>> 0, 0) % TAG_COLOR_STYLES.length;
  return { "--tag-bg": TAG_COLOR_STYLES[index].background, "--tag-color": TAG_COLOR_STYLES[index].color } as CSSProperties;
}

function loadDeckSidebarWidth(): number {
  if (typeof window === "undefined") return DEFAULT_DECK_SIDEBAR_WIDTH;
  const raw = userProfileStorage.getItem(DECK_SIDEBAR_WIDTH_KEY);
  if (raw === null) return DEFAULT_DECK_SIDEBAR_WIDTH;
  const stored = Number(raw);
  return Number.isFinite(stored)
    ? Math.min(MAX_DECK_SIDEBAR_WIDTH, Math.max(MIN_DECK_SIDEBAR_WIDTH, stored))
    : DEFAULT_DECK_SIDEBAR_WIDTH;
}

function availableDeckSidebarMaximum(bodyWidth: number): number {
  if (!Number.isFinite(bodyWidth) || bodyWidth <= 0) return MAX_DECK_SIDEBAR_WIDTH;
  return Math.max(MIN_DECK_SIDEBAR_WIDTH, Math.min(MAX_DECK_SIDEBAR_WIDTH, bodyWidth - MIN_FLASHCARD_CONTENT_WIDTH));
}


function dueLabel(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  if (timestamp <= now) return "现在";
  const minutes = Math.ceil((timestamp - now) / 60);
  if (minutes < 60) return `${minutes} 分钟后`;
  const days = Math.ceil(minutes / 1440);
  return `${days} 天后`;
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取所选图片"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error("所选图片格式无效"));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

const CARD_TYPE_LABELS: Record<Flashcard["cardType"], string> = {
  qa: "问答",
  cloze: "填空",
  multiple_choice: "选择题",
  typed_answer: "输入答案",
  ordering: "排序",
  image_occlusion: "图片遮挡",
};
const MEDIA_PLACEMENT_LABELS: Record<NonNullable<FlashcardMedia["placement"]>, string> = { question: "问题", answer: "答案", explanation: "解释" };

export function FlashcardsWorkspace({ onClose, onDueCountChange, desktopSidebarVisible = false, onToggleDesktopSidebar, sourceOpenMode = "client", onStatusMessage, initialCardId, onSearchTargetHandled }: Props) {
  const isAndroid = typeof document !== "undefined" && document.documentElement.dataset.runtimePlatform === "android";
  const [decks, setDecks] = useState<FlashcardDeckSummary[]>([]);
  const [deckFolders, setDeckFolders] = useState<FlashcardDeckFolderSummary[]>([]);
  const [selectedDeckId, setSelectedDeckId] = useWorkspaceSession("flashcards.deck", "");
  const [activeView, setActiveView] = useWorkspaceSession<FlashcardView>("flashcards.view", "due");
  const cardRequests = useRef(new ViewRequest());
  const cardViewKey = (view: FlashcardView, deckId: string) => `${view}:${view === "deck" ? deckId : ""}`;
  cardRequests.current.select(cardViewKey(activeView, selectedDeckId));
  const [dashboardStats, setDashboardStats] = useState<FlashcardDashboardStats | null>(null);
  const dashboardRefreshRevision = useRef(0);
  const [drafts, setDrafts] = useState<FlashcardDraft[]>([]);
  const draftRefreshRevisionRef = useRef(0);
  const { queue: reviewQueue, total: reviewSessionTotal, reviewing, answerVisible, busy: reviewingCard,
    selectedChoice, typedResponse, orderingResponse, label: reviewLabel, error: reviewError, lastRated, session: reviewSession } = useFlashcardReviewSession();
  const [reviewRecoveryChecked, setReviewRecoveryChecked] = useState(false);
  const setReviewing = (value: boolean) => { if (!value) reviewSession.pause(); };
  const setAnswerVisible = (value: boolean) => reviewSession.patch({ answerVisible: value });
  const setSelectedChoice = (value: number | null) => reviewSession.patch({ selectedChoice: value });
  const setTypedResponse = (value: string) => reviewSession.patch({ typedResponse: value });
  const setOrderingResponse = (update: (items: string[]) => string[]) => reviewSession.patch({ orderingResponse: update(reviewSession.getSnapshot().orderingResponse) });
  const [loading, setLoading] = useState(true);
  const [resolvingDraft, setResolvingDraft] = useState("");
  const resolvingDraftRef = useRef(false);
  const [inboxDropDeckId, setInboxDropDeckId] = useState("");
  const [deletingCardId, setDeletingCardId] = useState("");
  const [editingCardId, setEditingCardId] = useState("");
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editExplanation, setEditExplanation] = useState("");
  const [editCardType, setEditCardType] = useState<Flashcard["cardType"]>("qa");
  const [editDeckId, setEditDeckId] = useState("");
  const [editSourceTitle, setEditSourceTitle] = useState("");
  const [editSourcePath, setEditSourcePath] = useState("");
  const [editOptions, setEditOptions] = useState(["", "", "", ""]);
  const [editCorrectIndex, setEditCorrectIndex] = useState(0);
  const [editMedia, setEditMedia] = useState<FlashcardMedia[]>([]);
  const [newMediaPlacement, setNewMediaPlacement] = useState<NonNullable<FlashcardMedia["placement"]>>("answer");
  const [editOcclusions, setEditOcclusions] = useState<FlashcardOcclusion[]>([]);
  const [editTags, setEditTags] = useState("");
  const [editCustomFields, setEditCustomFields] = useState<Array<{ key: string; value: string }>>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [mediaPasteNotice, setMediaPasteNotice] = useState("");
  const [mobilePage, setMobilePage] = useState<"review" | "library" | "deck" | "inbox" | "stats">("review");
  const [sessionLimit, setSessionLimit] = useState(() => { try { const saved = Number(userProfileStorage.getItem("hub.flashcards.session-limit") ?? 20); return [0,10,20,50,100].includes(saved) ? saved : 20; } catch { return 20; } });
  const [dailyNewLimit, setDailyNewLimit] = useState(() => loadDailyNewCardLimit(userProfileStorage));
  const [dailyLimitReady, setDailyLimitReady] = useState(false);
  const [savingDailyLimit, setSavingDailyLimit] = useState(false);
  const [mobileDeckSearch, setMobileDeckSearch] = useState("");
  const [savingCard, setSavingCard] = useState(false);
  const [creatingCard, setCreatingCard] = useState(false);
  const [duplicatingCard, setDuplicatingCard] = useState(false);
  const [inlineCell, setInlineCell] = useState<{ cardId: string; field: EditableCardField } | null>(null);
  const [selectedTextCell, setSelectedTextCell] = useState<{ cardId: string; field: EditableCardField } | null>(null);
  const [inlineValue, setInlineValue] = useState("");
  const [tagCell, setTagCell] = useState<{ cardId: string; tags: string[]; input: string } | null>(null);
  const [savingTagCell, setSavingTagCell] = useState(false);
  const [statusCellId, setStatusCellId] = useState("");
  const [deckCell, setDeckCell] = useState<{ cardId: string; query: string } | null>(null);
  const [savingPropertyCell, setSavingPropertyCell] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<FlashcardMedia | null>(null);
  const [discardEditorConfirmOpen, setDiscardEditorConfirmOpen] = useState(false);
  const [editorValidationIssue, setEditorValidationIssue] = useState<FlashcardEditorValidationIssue | null>(null);
  const [editorSaveError, setEditorSaveError] = useState("");
  const [editorSaveNotice, setEditorSaveNotice] = useState("");
  const [editorRecoveryDraft, setEditorRecoveryDraft] = useState<FlashcardEditorDraft | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState(() => loadFlashcardEditorDraft(userProfileStorage));
  const [recoveringEditor, setRecoveringEditor] = useState(false);
  const workspaceMounted = useRef(true);
  useEffect(() => { workspaceMounted.current = true; return () => { workspaceMounted.current = false; }; }, []);
  const [savingInlineCell, setSavingInlineCell] = useState(false);
  const [tableColumnDrag, setTableColumnDrag] = useState<{ key: string; target: string; after: boolean; x: number; y: number; width: number } | null>(null);
  const [tableColumnPressKey, setTableColumnPressKey] = useState("");
  const [gridModalCardId, setGridModalCardId] = useState("");
  const [detailCard, setDetailCard] = useState<Flashcard | null>(null);
  const [qualityFeedbackOpen,setQualityFeedbackOpen] = useState(false);
  const [qualityTarget,setQualityTarget] = useState<QualityTarget | undefined>();
  const openQuality = (target?:QualityTarget) => {setQualityTarget(target);setQualityFeedbackOpen(true);};
  useEffect(()=>{if(qualityFeedbackOpen){reviewSession.suspendTiming();return ()=>reviewSession.resumeTiming();}},[qualityFeedbackOpen,reviewSession]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (isAndroid && activeView !== "due") setActiveView("due");
    // Mobile opens on the focused daily-review route; later navigation is user-controlled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openExternalLink = useExternalLinkOpener({ showStatus: onStatusMessage, setError });
  const [deckDatabaseView, setDeckDatabaseView] = useState<DeckDatabaseView>("table");
  const [cardSearch, setCardSearch] = useWorkspaceSession("flashcards.search", "");
  const cardSearchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); event.stopImmediatePropagation();
        cardSearchRef.current?.focus(); cardSearchRef.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch, true);
    return () => window.removeEventListener("keydown", focusSearch, true);
  }, []);
  const [cardTypeFilter, setCardTypeFilter] = useWorkspaceSession<"all" | Flashcard["cardType"]>("flashcards.type", "all");
  const [cardStageFilter, setCardStageFilter] = useWorkspaceSession<"all" | ReturnType<typeof cardStage>>("flashcards.stage", "all");
  const [cardSort, setCardSort] = useWorkspaceSession<CardSort>("flashcards.sort", "updated");
  const [cardSortAscending, setCardSortAscending] = useWorkspaceSession("flashcards.ascending", false);
  const resetCardFilters = () => { setCardSearch(""); setCardTypeFilter("all"); setCardStageFilter("all"); };
  const { ref: mainScrollRef, onScroll: rememberMainScroll } = useWorkspaceScroll("flashcards.main", !loading);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [batchDeckId, setBatchDeckId] = useState("");
  const [batchTags, setBatchTags] = useState("");
  const [batchFieldKey, setBatchFieldKey] = useState("");
  const [batchFieldValue, setBatchFieldValue] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchEditorOpen, setBatchEditorOpen] = useState(false);
  const [qualityReport, setQualityReport] = useState<FlashcardQualityReport | null>(null);
  const [qualityReportOpen, setQualityReportOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [cardConfigOpen, setCardConfigOpen] = useState(false);
  const [cardConfigPage, setCardConfigPage] = useState<CardConfigPage>("root");
  const [cardPropertySearch, setCardPropertySearch] = useState("");
  const [colorPickerRuleId, setColorPickerRuleId] = useState<string | null>(null);
  const [deckViews, setDeckViews] = useState<DeckViewConfig[]>([]);
  const [activeDeckViewId, setActiveDeckViewId] = useState("default");
  const [queryToolsOpen, setQueryToolsOpen] = useState(false);
  const [databaseSearchOpen, setDatabaseSearchOpen] = useState(false);
  const [galleryCoverIndexes, setGalleryCoverIndexes] = useState<Record<string, number>>({});
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [deckDropTarget, setDeckDropTarget] = useState<string | null>(null);
  const [deckInsertTarget, setDeckInsertTarget] = useState<string | null>(null);
  const [deckDragPreview, setDeckDragPreview] = useState<{ name: string; x: number; y: number } | null>(null);
  const [boardDragCardId, setBoardDragCardId] = useState("");
  const [boardDropStage, setBoardDropStage] = useState<ReturnType<typeof cardStage> | null>(null);
  const [boardDragPreview, setBoardDragPreview] = useState<{ title: string; x: number; y: number } | null>(null);
  const [creatingDeckFolder, setCreatingDeckFolder] = useState(false);
  const [creatingDeck, setCreatingDeck] = useState(false);
  const [newDeckName, setNewDeckName] = useState("");
  const [newDeckParentId, setNewDeckParentId] = useState("");
  const deckHierarchy = useMemo(() => buildDeckHierarchy(decks), [decks]);
  const [savingNewDeck, setSavingNewDeck] = useState(false);
  const creatingDeckRef = useRef(false);
  const [newDeckFolderName, setNewDeckFolderName] = useState("");
  const [deckTreeContextMenu, setDeckTreeContextMenu] = useState<DeckTreeContextTarget | null>(null);
  const matchingDeckIds = useMemo(() => deckHierarchy.matching(mobileDeckSearch), [deckHierarchy,mobileDeckSearch]);
  const blockedParentIds = useMemo(() => deckTreeContextMenu?.kind === "deck" ? deckHierarchy.descendants(deckTreeContextMenu.id) : new Set<string>(), [deckHierarchy,deckTreeContextMenu]);
  const [deckTreeRename, setDeckTreeRename] = useState<{ kind: "deck" | "folder"; id: string; value: string } | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const backupModalRef = useRef<HTMLElement | null>(null);
  const [chromeActions, setChromeActions] = useState<HTMLElement | null>(null);
  useEffect(() => { setChromeActions(document.getElementById("flashcards-chrome-actions")); }, []);
  useModalFocus({ active: backupOpen, containerRef: backupModalRef, onDismiss: () => setBackupOpen(false) });
  const [syncMessage, setSyncMessage] = useState("");
  const [preferredDeckSidebarWidth, setPreferredDeckSidebarWidth] = useState(loadDeckSidebarWidth);
  const [flashcardsBodyWidth, setFlashcardsBodyWidth] = useState(Number.POSITIVE_INFINITY);
  const [resizingDeckSidebar, setResizingDeckSidebar] = useState(false);
  const flashcardsBodyRef = useRef<HTMLDivElement | null>(null);
  const folderExpansionLoaded = useRef(false);
  const draggedDeckIdRef = useRef("");
  const deckPointerDragRef = useRef<{ deckId: string; pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null);
  const boardPointerDragRef = useRef<{ cardId: string; pointerId: number; startX: number; startY: number; dragging: boolean } | null>(null);
  const suppressBoardClickRef = useRef(false);
  const editorBaselineRef = useRef("");
  const editorSaveFailureSnapshotRef = useRef("");
  const latestEditorSnapshotRef = useRef("");
  const savingCardRef = useRef(false);
  const viewSettingsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!error || !onStatusMessage) return;
    onStatusMessage?.(error, "error", 8_000);
    setError("");
  }, [error, onStatusMessage]);

  useEffect(() => {
    if (!message || !onStatusMessage) return;
    const working = message.includes("正在");
    onStatusMessage?.(message, working ? "working" : "success", working ? 120_000 : 5_000);
    setMessage("");
  }, [message, onStatusMessage]);

  useEffect(() => {
    if (!syncMessage || !onStatusMessage) return;
    const working = syncMessage.includes("正在");
    onStatusMessage?.(syncMessage, working ? "working" : "success", working ? 120_000 : 5_000);
    setSyncMessage("");
  }, [onStatusMessage, syncMessage]);
  const cardConfigRef = useRef<HTMLDivElement | null>(null);
  const galleryGridRef = useRef<HTMLDivElement | null>(null);
  const galleryLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const databaseLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const boardLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const cardModalRef = useRef<HTMLElement | null>(null);
  const mediaPreviewModalRef = useRef<HTMLElement | null>(null);
  const discardEditorConfirmRef = useRef<HTMLElement | null>(null);

  const deckSidebarWidth = Math.min(
    preferredDeckSidebarWidth,
    availableDeckSidebarMaximum(flashcardsBodyWidth),
  );

  useEffect(() => {
    const body = flashcardsBodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const updateWidth = () => setFlashcardsBodyWidth(body.getBoundingClientRect().width || Number.POSITIVE_INFINITY);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(body);
    return () => observer.disconnect();
  }, [loading]);

  const commitDeckSidebarWidth = useCallback((width: number) => {
    const next = Math.min(availableDeckSidebarMaximum(flashcardsBodyWidth), Math.max(MIN_DECK_SIDEBAR_WIDTH, Math.round(width)));
    setPreferredDeckSidebarWidth(next);
    userProfileStorage.setItem(DECK_SIDEBAR_WIDTH_KEY, String(next));
  }, [flashcardsBodyWidth]);

  const resetDeckSidebarWidth = useCallback(() => {
    commitDeckSidebarWidth(DEFAULT_DECK_SIDEBAR_WIDTH);
  }, [commitDeckSidebarWidth]);

  const resizeDeckSidebar = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const body = flashcardsBodyRef.current;
    if (!body) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = body.getBoundingClientRect();
    const maximum = availableDeckSidebarMaximum(bounds.width);
    const widthFromPointer = (clientX: number) => Math.min(maximum, Math.max(MIN_DECK_SIDEBAR_WIDTH, clientX - bounds.left));
    let latestWidth = deckSidebarWidth;
    const update = (clientX: number) => {
      latestWidth = widthFromPointer(clientX);
      setPreferredDeckSidebarWidth(latestWidth);
    };
    const finish = (finishEvent: PointerEvent) => {
      const next = finishEvent.type === "pointercancel" ? latestWidth : widthFromPointer(finishEvent.clientX);
      setPreferredDeckSidebarWidth(next);
      userProfileStorage.setItem(DECK_SIDEBAR_WIDTH_KEY, String(Math.round(next)));
      setResizingDeckSidebar(false);
      document.body.classList.remove("resizing-flashcard-decks");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    setResizingDeckSidebar(true);
    document.body.classList.add("resizing-flashcard-decks");
    update(event.clientX);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [deckSidebarWidth]);

  const resizeDeckSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 12;
    let next = deckSidebarWidth;
    if (event.key === "ArrowLeft") next -= step;
    else if (event.key === "ArrowRight") next += step;
    else if (event.key === "Home") next = MIN_DECK_SIDEBAR_WIDTH;
    else if (event.key === "End") next = availableDeckSidebarMaximum(flashcardsBodyWidth);
    else if (event.key === "Enter") next = DEFAULT_DECK_SIDEBAR_WIDTH;
    else return;
    event.preventDefault();
    commitDeckSidebarWidth(next);
  }, [commitDeckSidebarWidth, deckSidebarWidth, flashcardsBodyWidth]);

  const refreshDecks = useCallback(async () => {
    const next = await invoke<FlashcardDeckSummary[]>("list_flashcard_decks");
    setDecks(next);
    setSelectedDeckId((current) => current && next.some((deck) => deck.id === current) ? current : next[0]?.id ?? "");
    return next;
  }, []);

  const refreshDeckFolders = useCallback(async () => {
    const next = await invoke<FlashcardDeckFolderSummary[]>("list_flashcard_deck_folders");
    setDeckFolders(next);
    if (!folderExpansionLoaded.current) {
      folderExpansionLoaded.current = true;
      try {
        const stored = userProfileStorage.getItem(DECK_FOLDER_EXPANSION_KEY);
        setExpandedFolderIds(new Set(stored ? JSON.parse(stored) : next.map((folder) => folder.id)));
      } catch {
        setExpandedFolderIds(new Set(next.map((folder) => folder.id)));
      }
    }
    return next;
  }, []);

  const activeDeckView = deckViews.find((view) => view.id === activeDeckViewId) ?? deckViews[0];
  const databaseViewActive = activeView === "deck" || activeView === "cards";
  const browser = useFlashcardBrowser({
    deckId: activeView === "deck" ? selectedDeckId || null : null, dueOnly: false,
    query: { search: cardSearch, cardType: cardTypeFilter, stage: cardStageFilter, sort: cardSort, ascending: cardSortAscending, includeMastered: !activeDeckView || activeDeckView.showAll, includeSubdecks: activeView === "deck" && Boolean(activeDeckView?.showSubdecks) },
  }, deckDatabaseView === "column" && !isAndroid ? "column" : deckDatabaseView === "grid" ? "grid" : "linear", databaseViewActive && !reviewing && !loading, setError);
  const cards = useMemo(() => deckDatabaseView === "column" && !isAndroid
    ? Object.values(browser.columns).flatMap(page => page?.items ?? []) : browser.page.items, [browser.columns, browser.page.items, deckDatabaseView, isAndroid]);
  const refreshViewCards = useCallback((view = activeView, deckId = selectedDeckId, _fresh = true) => {
    if (cardViewKey(view, deckId) !== cardViewKey(activeView, selectedDeckId)) return Promise.resolve();
    return browser.refresh();
  }, [activeView, selectedDeckId, browser.refresh]);
  useEffect(() => { setSelectedCardIds(new Set()); }, [browser.page.revision]);

  const refreshDashboard = useCallback(async () => {
    const revision = ++dashboardRefreshRevision.current;
    const next = await invoke<FlashcardDashboardStats>("get_flashcard_dashboard_stats");
    if (workspaceMounted.current && revision === dashboardRefreshRevision.current) setDashboardStats(next);
    return next;
  }, []);

  const refreshStudySettings = useCallback(async () => {
    const settings = await invoke<{ dailyNewLimit: number }>("get_flashcard_study_settings");
    setDailyNewLimit(settings.dailyNewLimit);
    try { userProfileStorage.setItem(DAILY_NEW_CARD_LIMIT_KEY, String(settings.dailyNewLimit)); } catch { /* The database remains authoritative. */ }
    return settings;
  }, []);

  useEffect(() => {
    void refreshStudySettings().catch(() => undefined).finally(() => setDailyLimitReady(true));
  }, [refreshStudySettings]);

  const refreshDrafts = useCallback(async () => {
    const revision = ++draftRefreshRevisionRef.current;
    const next = await invoke<FlashcardDraft[]>("list_flashcard_drafts");
    if (workspaceMounted.current && revision === draftRefreshRevisionRef.current) setDrafts(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([refreshDecks(), refreshDeckFolders(), refreshDashboard()])
      .catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; cardRequests.current.invalidate(); };
  }, [refreshDashboard, refreshDeckFolders, refreshDecks]);

  useEffect(() => {
    void refreshDrafts().catch((reason) => setError(String(reason)));
  }, [refreshDrafts]);

  useEffect(() => {
    let cancelled = false;
    const stored = loadFlashcardReviewSession(userProfileStorage);
    if (!stored) { setReviewRecoveryChecked(true); return () => { cancelled = true; }; }
    void loadFlashcardsByIds(stored.queue.map(card => card.id))
      .then((available) => {
        if (cancelled) return;
        reviewSession.restoreStored(stored, available);
        setReviewRecoveryChecked(true);
      })
      .catch((reason) => { if (!cancelled) setError(`暂时无法找回复习进度：${String(reason)}`); });
    return () => { cancelled = true; };
  }, [reviewSession]);

  useEffect(() => {
    if (!reviewRecoveryChecked) return;
    saveFlashcardReviewSession(userProfileStorage, reviewSession.storedSnapshot());
  }, [answerVisible, orderingResponse, reviewLabel, reviewQueue, reviewRecoveryChecked, reviewSession, reviewSessionTotal, selectedChoice, typedResponse]);

  useVisiblePolling(refreshDrafts, activeView === "inbox", 2_000);

  useEffect(() => {
    const views = loadDeckViews(selectedDeckId);
    const activeId = loadActiveDeckViewId(selectedDeckId, views);
    setDeckViews(views);
    setActiveDeckViewId(activeId);
    setDeckDatabaseView(views.find((view) => view.id === activeId)?.type ?? loadDeckViewType(selectedDeckId));
    setViewMenuOpen(false);
    setSelectedCardIds(new Set());
    setBatchDeckId("");
  }, [selectedDeckId]);

  useEffect(() => { setSelectedCardIds(new Set()); }, [activeView, selectedDeckId, activeDeckViewId, cardSearch, cardTypeFilter, cardStageFilter, cardSort, cardSortAscending, activeDeckView?.showAll, activeDeckView?.showSubdecks]);

  useEffect(() => {
    if (selectedCardIds.size === 0) setBatchEditorOpen(false);
  }, [selectedCardIds.size]);

  useEffect(() => {
    if (!viewMenuOpen) return;
    const closeWhenOutside = (event: PointerEvent | FocusEvent) => {
      if (!viewSettingsRef.current?.contains(event.target as Node)) setViewMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("focusin", closeWhenOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("focusin", closeWhenOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [viewMenuOpen]);

  useEffect(() => {
    if (!cardConfigOpen) return;
    const closeWhenOutside = (event: PointerEvent | FocusEvent) => {
      if (!cardConfigRef.current?.contains(event.target as Node)) setCardConfigOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cardConfigPage !== "root") setCardConfigPage("root"); else setCardConfigOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("focusin", closeWhenOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("focusin", closeWhenOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [cardConfigOpen, cardConfigPage]);

  useEffect(() => {
    if (!deckTreeContextMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".flashcards-deck-context-menu")) {
        setDeckTreeContextMenu(null);
        setDeckTreeRename(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setDeckTreeContextMenu(null); setDeckTreeRename(null); }
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [deckTreeContextMenu]);

  useEffect(() => {
    if (!statusCellId && !deckCell && !tagCell) return;
    const closeCellEditor = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".flashcards-property-cell-editor, .flashcards-tag-cell-editor")) {
        setStatusCellId("");
        setDeckCell(null);
        setTagCell(null);
      }
    };
    document.addEventListener("pointerdown", closeCellEditor);
    return () => document.removeEventListener("pointerdown", closeCellEditor);
  }, [statusCellId, deckCell, tagCell]);

  useEffect(() => {
    if (!selectedTextCell) return;
    const clearTextCellSelection = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".flashcards-table-text-cell")) setSelectedTextCell(null);
    };
    document.addEventListener("pointerdown", clearTextCellSelection);
    return () => document.removeEventListener("pointerdown", clearTextCellSelection);
  }, [selectedTextCell]);

  useWindowResumeRefresh(() => Promise.all([
    refreshDrafts(),
    refreshDecks(),
    refreshDeckFolders(),
    refreshViewCards(),
    refreshDashboard(),
    refreshStudySettings(),
  ]).catch((reason) => setError(String(reason))));

  const selectedDeck = decks.find((deck) => deck.id === selectedDeckId);
  const selectedDeckCounts = useMemo(() => deckHierarchy.scopeCounts(selectedDeckId, Boolean(activeDeckView?.showSubdecks)), [deckHierarchy, selectedDeckId, activeDeckView?.showSubdecks]);
  const galleryImageCover = activeDeckView?.galleryImageCover ?? true;
  const galleryCoverMode = activeDeckView?.galleryCoverMode ?? "crop";
  const galleryWrapContent = activeDeckView?.galleryWrapContent ?? false;
  const galleryShowPropertyNames = activeDeckView?.galleryShowPropertyNames ?? true;
  const galleryShowFullTitle = activeDeckView?.galleryShowFullTitle ?? false;
  const galleryCompactHiddenProperties = activeDeckView?.galleryCompactHiddenProperties ?? true;
  const remainingNew = remainingNewCardAllowance(dailyNewLimit, dashboardStats?.newStudiedToday ?? 0);
  const totalDueCount = dashboardStats
    ? todayFlashcardDueCount(dashboardStats, dailyNewLimit)
    : decks.reduce((sum, deck) => sum + deck.dueCount, 0);
  useEffect(() => {
    if (dashboardStats && dailyLimitReady) onDueCountChange?.(totalDueCount);
  }, [dashboardStats, dailyLimitReady, totalDueCount, onDueCountChange]);
  const totalCardCount = useMemo(() => decks.reduce((sum, deck) => sum + deck.cardCount, 0), [decks]);
  const {plan:reviewPlan,starting:startingReview,start:beginPlannedReview}=useFlashcardStudyPlan({
    deckId:activeView === "deck" ? selectedDeckId || null : null,
    scopeName:activeView === "due" ? "今日待复习" : selectedDeck?.name ?? "闪卡",
    includeSubdecks:activeView === "deck" && Boolean(activeDeckView?.showSubdecks),sessionLimit,
    enabled:!loading && !reviewing && dailyLimitReady && (activeView === "due" || activeView === "deck"),
    quota:dailyNewLimit,refreshToken:dashboardStats,decksToken:decks,
    onStart:reviewSession.start,onError:setError,
  });
  const plannedSessionCount=reviewPlan.sessionCount ?? reviewPlan.sessionIds.length;
  const currentCard = reviewQueue[0];
  const schedulePreview = useFlashcardSchedulePreview(currentCard, reviewing && answerVisible);

  const resolveDrafts = async (draftIds: string[], accept: boolean, operationId: string, targetDeckId?: string) => {
    if (draftIds.length === 0 || resolvingDraftRef.current) return;
    resolvingDraftRef.current = true;
    draftRefreshRevisionRef.current += 1;
    setResolvingDraft(operationId);
    setError("");
    try {
      const result = await invoke<FlashcardDraftResolutionResult>("resolve_flashcard_drafts", { draftIds, accept, targetDeckId });
      await refreshDrafts();
      if (result.accepted > 0) {
        await Promise.all([refreshDecks(), refreshDashboard()]);
      }
      setMessage(accept
        ? `已将 ${result.accepted} 张闪卡移入牌组${result.skipped ? `，另有 ${result.skipped} 张因重复或状态变化被跳过` : ""}`
        : `已从收件箱移除 ${result.rejected} 张卡片${result.skipped ? `，跳过 ${result.skipped} 张` : ""}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      resolvingDraftRef.current = false;
      setResolvingDraft("");
    }
  };

  const openView = async (view: FlashcardView, deckId = selectedDeckId) => {
    cardRequests.current.select(cardViewKey(view, deckId));
    const current = cardRequests.current.guard(cardViewKey(view, deckId));
    setActiveView(view);
    setReviewing(false);
    setError("");
    try {
      if (view === "inbox") await refreshDrafts();
      else if (view === "stats") await refreshDashboard();
      else if (view === "due") await Promise.all([refreshDashboard(), refreshViewCards(view, deckId, false)]);
      else await refreshViewCards(view, deckId, false);
    } catch (reason) {
      if (current()) setError(String(reason));
    }
  };

  const changeDeckDatabaseView = (view: DeckDatabaseView) => {
    setDeckDatabaseView(view);
    saveDeckViewType(selectedDeckId, view);
  };

  const persistDeckViews = (next: DeckViewConfig[], activeId = activeDeckViewId) => {
    setDeckViews(next);
    setActiveDeckViewId(activeId);
    const active = next.find((view) => view.id === activeId) ?? next[0];
    if (active) changeDeckDatabaseView(active.type);
    saveDeckViews(selectedDeckId, next);
    saveActiveDeckViewId(selectedDeckId, activeId);
  };

  const updateActiveDeckView = (patch: Partial<DeckViewConfig>) => {
    persistDeckViews(deckViews.map((view) => view.id === activeDeckViewId ? { ...view, ...patch } : view));
  };

  const toggleCardProperty = (property: CardFieldKey) => {
    if (!activeDeckView) return;
    const hidden = new Set(activeDeckView.hiddenProperties ?? []);
    const currentlyVisible = !hidden.has(property);
    if (currentlyVisible) hidden.add(property); else hidden.delete(property);
    updateActiveDeckView({ hiddenProperties: [...hidden] });
  };

  const updateColorRule = (ruleId: string, patch: Partial<CardColorRule>) => updateActiveDeckView({ colorRules: (activeDeckView?.colorRules ?? []).map((rule) => rule.id === ruleId ? { ...rule, ...patch } : rule) });
  const addColorRule = () => {
    const id = `color-${Date.now().toString(36)}`;
    updateActiveDeckView({ colorRules: [...(activeDeckView?.colorRules ?? []), { id, field: "status", operator: "equals", value: "学习中", color: "green" }] });
    setColorPickerRuleId(null);
  };
  const removeColorRule = (ruleId: string) => {
    updateActiveDeckView({ colorRules: (activeDeckView?.colorRules ?? []).filter((rule) => rule.id !== ruleId) });
    if (colorPickerRuleId === ruleId) setColorPickerRuleId(null);
  };

  const chooseDeckViewType = (type: DeckDatabaseView) => {
    const active = deckViews.find((view) => view.id === activeDeckViewId);
    const generatedName = !active || active.name === "新视图" || Object.values(DECK_VIEW_DEFAULT_NAMES).includes(active.name) || Object.values(LEGACY_DECK_VIEW_NAMES).includes(active.name);
    updateActiveDeckView({ type, ...(generatedName ? { name: DECK_VIEW_DEFAULT_NAMES[type] } : {}) });
    setViewMenuOpen(false);
    setCardConfigOpen(false);
  };

  const selectDeckView = (view: DeckViewConfig) => {
    setActiveDeckViewId(view.id);
    changeDeckDatabaseView(view.type);
    saveActiveDeckViewId(selectedDeckId, view.id);
    setViewMenuOpen(false);
    setCardConfigOpen(false);
  };

  const addDeckView = () => {
    const id = `view-${Date.now().toString(36)}`;
    const next = [...deckViews, { id, name: "新视图", type: "table" as const, showAll: true, showCustomFields: true, hiddenProperties: [], cardLayout: "comfortable" as const, colorRules: [], columnWidths: {}, columnOrder: [], galleryImageCover: true, galleryCoverMode: "crop" as const, galleryWrapContent: false, galleryShowPropertyNames: true, galleryShowFullTitle: false, galleryCompactHiddenProperties: true }];
    persistDeckViews(next, id);
    setViewMenuOpen(true);
  };

  const duplicateActiveDeckView = () => {
    const active = deckViews.find((view) => view.id === activeDeckViewId);
    if (!active) return;
    const copy = { ...active, id: `view-${Date.now().toString(36)}`, name: `${active.name} 副本` };
    persistDeckViews([...deckViews, copy], copy.id);
    setViewMenuOpen(true);
  };

  const deleteActiveDeckView = () => {
    if (deckViews.length <= 1) return;
    const next = deckViews.filter((view) => view.id !== activeDeckViewId);
    persistDeckViews(next, next[0].id);
    setViewMenuOpen(false);
  };

  const toggleDeckFolder = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      try { userProfileStorage.setItem(DECK_FOLDER_EXPANSION_KEY, JSON.stringify([...next])); } catch { /* session-only fallback */ }
      return next;
    });
  };

  const expandDeckFolder = (folderId: string) => {
    if (!folderId) return;
    setExpandedFolderIds((current) => {
      const next = new Set(current).add(folderId);
      try { userProfileStorage.setItem(DECK_FOLDER_EXPANSION_KEY, JSON.stringify([...next])); } catch { /* session-only fallback */ }
      return next;
    });
  };

  const createDeckFolder = async () => {
    const name = newDeckFolderName.trim();
    if (!name) return;
    try {
      const folder = await invoke<FlashcardDeckFolderSummary>("create_flashcard_deck_folder", { name });
      await refreshDeckFolders();
      expandDeckFolder(folder.id);
      setCreatingDeckFolder(false);
      setNewDeckFolderName("");
      setMessage(`已创建文件夹“${folder.name}”`);
    } catch (reason) { setError(String(reason)); }
  };

  const moveDeckToFolder = async (deckId: string, folderId: string, beforeDeckId = "") => {
    setDeckDropTarget(null);
    setDeckInsertTarget(null);
    const deck = decks.find((item) => item.id === deckId);
    if (!deck || deck.id === beforeDeckId || (deck.folderId === folderId && !deck.parentDeckId && !beforeDeckId)) return;
    try {
      await invoke("move_flashcard_deck", { deckId, folderId: folderId || null, beforeDeckId: beforeDeckId || null });
      expandDeckFolder(folderId);
      await refreshDecks();
      setSelectedDeckId(deckId);
      setMessage(folderId ? `已将“${deck.name}”移入文件夹` : `已将“${deck.name}”移到根目录`);
    } catch (reason) { setError(String(reason)); }
  };

  const changeDeckParent = async (deckId: string, parentDeckId: string) => {
    setError("");
    try {
      await invoke("set_flashcard_deck_parent", { deckId, parentDeckId: parentDeckId || null });
      setDeckTreeContextMenu(null);
      await refreshDecks();
      await browser.refresh();
      setMessage("牌组层级已更新");
    } catch (reason) { setError(String(reason)); }
  };

  const openDeckTreeContextMenu = (event: React.MouseEvent, target: Omit<DeckTreeContextTarget, "x" | "y">) => {
    event.preventDefault();
    event.stopPropagation();
    deckPointerDragRef.current = null;
    setDeckDragPreview(null);
    setDeckTreeRename(null);
    setDeckTreeContextMenu({
      ...target,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - (target.kind === "deck" ? 286 : 170))),
    });
  };

  const pinDeckTreeTarget = async (target: DeckTreeContextTarget) => {
    setDeckTreeContextMenu(null);
    try {
      if (target.kind === "folder") {
        await invoke("pin_flashcard_deck_folder", { folderId: target.id });
        await refreshDeckFolders();
      } else {
        const deck = decks.find((item) => item.id === target.id);
        if (!deck) return;
        const first = decks.find((item) => (item.folderId ?? "") === (deck.folderId ?? "") && (item.parentDeckId ?? "") === (deck.parentDeckId ?? "") && item.id !== deck.id);
        if (first) await invoke("move_flashcard_deck", { deckId: deck.id, folderId: deck.folderId || null, beforeDeckId: first.id });
        await refreshDecks();
      }
      setMessage(`已置顶“${target.name}”`);
    } catch (reason) { setError(String(reason)); }
  };

  const saveDeckTreeRename = async () => {
    if (!deckTreeRename) return;
    const name = deckTreeRename.value.trim();
    if (!name) return;
    try {
      await invoke(deckTreeRename.kind === "deck" ? "rename_flashcard_deck" : "rename_flashcard_deck_folder", {
        [deckTreeRename.kind === "deck" ? "deckId" : "folderId"]: deckTreeRename.id,
        name,
      });
      if (deckTreeRename.kind === "deck") await refreshDecks(); else await refreshDeckFolders();
      setMessage(`已重命名为“${name}”`);
      setDeckTreeContextMenu(null);
      setDeckTreeRename(null);
    } catch (reason) { setError(String(reason)); }
  };

  const deleteDeckTreeTarget = async (target: DeckTreeContextTarget) => {
    const prompt = target.kind === "deck"
      ? `确定删除牌组“${target.name}”及其直属闪卡吗？子牌组及其中的卡片会保留，并移到上一级。此操作会同步到其他设备。`
      : `确定删除文件夹“${target.name}”吗？其中的牌组会移到根目录。`;
    if (!window.confirm(prompt)) return;
    setDeckTreeContextMenu(null);
    try {
      if (target.kind === "folder") {
        await invoke("delete_flashcard_deck_folder", { folderId: target.id });
        await Promise.all([refreshDeckFolders(), refreshDecks()]);
      } else {
        await invoke("delete_flashcard_deck", { deckId: target.id });
        const nextDecks = await refreshDecks();
        if (selectedDeckId === target.id) {
          const nextId = nextDecks[0]?.id ?? "";
          setSelectedDeckId(nextId);
          await refreshViewCards(activeView === "deck" ? "deck" : activeView, nextId);
        } else {
          await refreshViewCards(activeView, selectedDeckId);
        }
      }
      setMessage(`已删除“${target.name}”`);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const droppedDeckId = (event: ReactDragEvent) => event.dataTransfer.getData("application/x-hub-flashcard-deck") || event.dataTransfer.getData("text/plain") || draggedDeckIdRef.current;
  const dropDeckOnFolder = (event: ReactDragEvent, folderId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const deckId = droppedDeckId(event);
    setDeckDropTarget(null);
    if (deckId) void moveDeckToFolder(deckId, folderId);
  };
  const beginDeckPointerDrag = (event: ReactPointerEvent, deckId: string) => {
    if (event.button !== 0 || (event.pointerType === "mouse" && event.ctrlKey)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    deckPointerDragRef.current = { deckId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
  };
  const updateDeckPointerDrag = (event: ReactPointerEvent) => {
    const drag = deckPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    drag.dragging = true;
    draggedDeckIdRef.current = drag.deckId;
    const deck = decks.find((item) => item.id === drag.deckId);
    setDeckDragPreview({ name: deck?.name ?? "牌组", x: event.clientX, y: event.clientY });
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const insertTarget = hit?.closest<HTMLElement>("[data-deck-drop-before]");
    if (insertTarget?.dataset.deckDropBefore && insertTarget.dataset.deckDropBefore !== drag.deckId) {
      setDeckInsertTarget(insertTarget.dataset.deckDropBefore);
      setDeckDropTarget(insertTarget.dataset.deckFolderId ?? "");
      return;
    }
    setDeckInsertTarget(null);
    const target = hit?.closest<HTMLElement>("[data-deck-drop-folder]");
    setDeckDropTarget(target?.dataset.deckDropFolder ?? "__dragging__");
  };
  const finishDeckPointerDrag = (event: ReactPointerEvent) => {
    const drag = deckPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    deckPointerDragRef.current = null;
    draggedDeckIdRef.current = "";
    setDeckDragPreview(null);
    if (!drag.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const insertTarget = hit?.closest<HTMLElement>("[data-deck-drop-before]");
    if (insertTarget?.dataset.deckDropBefore && insertTarget.dataset.deckDropBefore !== drag.deckId) {
      const beforeDeckId = insertTarget.dataset.deckDropBefore;
      const folderId = insertTarget.dataset.deckFolderId ?? "";
      setDeckDropTarget(null);
      setDeckInsertTarget(null);
      void moveDeckToFolder(drag.deckId, folderId, beforeDeckId);
      return;
    }
    const target = hit?.closest<HTMLElement>("[data-deck-drop-folder]");
    const folderId = target?.dataset.deckDropFolder;
    setDeckDropTarget(null);
    setDeckInsertTarget(null);
    if (folderId !== undefined) void moveDeckToFolder(drag.deckId, folderId);
  };
  const mobileDeckMatches = (deck: FlashcardDeckSummary) => !mobileDeckSearch.trim() || deck.name.toLocaleLowerCase().includes(mobileDeckSearch.trim().toLocaleLowerCase());
  const renderDeckTreeItem = (deck: FlashcardDeckSummary, nested = false) => <button
    key={deck.id}
    className={`${activeView === "deck" && selectedDeckId === deck.id ? "active" : ""}${nested ? " nested" : ""}${deckInsertTarget === deck.id ? " drop-before" : ""}${inboxDropDeckId === deck.id ? " inbox-drop-target" : ""}`}
    aria-current={activeView === "deck" && selectedDeckId === deck.id ? "page" : undefined}
    data-deck-drop-before={deck.id}
    data-inbox-drop-deck={deck.id}
    data-deck-folder-id={deck.folderId}
    draggable={false}
    onPointerDown={(event) => beginDeckPointerDrag(event, deck.id)}
    onPointerMove={updateDeckPointerDrag}
    onPointerUp={finishDeckPointerDrag}
    onPointerCancel={() => { deckPointerDragRef.current = null; draggedDeckIdRef.current = ""; setDeckDropTarget(null); setDeckInsertTarget(null); setDeckDragPreview(null); }}
    onContextMenu={(event) => openDeckTreeContextMenu(event, { kind: "deck", id: deck.id, name: deck.name })}
    onDragStart={(event) => { draggedDeckIdRef.current = deck.id; setDeckDropTarget("__dragging__"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-hub-flashcard-deck", deck.id); event.dataTransfer.setData("text/plain", deck.id); }}
    onDragEnd={() => { draggedDeckIdRef.current = ""; setDeckDropTarget(null); setDeckInsertTarget(null); setDeckDragPreview(null); }}
    onDragOver={(event) => { if (!resolvingDraftRef.current && Array.from(event.dataTransfer.types).some((type) => type === "application/x-hub-flashcard-draft" || type === "application/x-hub-flashcard-drafts")) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setInboxDropDeckId(deck.id); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setInboxDropDeckId(""); }}
    onDrop={(event) => { const draftIds = inboxDraftIdsFromTransfer(event.dataTransfer, drafts); if (draftIds.length > 0) { event.preventDefault(); event.stopPropagation(); setInboxDropDeckId(""); void resolveDrafts(draftIds, true, "inbox-drop", deck.id); } }}
    onClick={() => { setSelectedDeckId(deck.id); if (isAndroid) setMobilePage("deck"); void openView("deck", deck.id); }}
  >
    <Layers3 size={15} /><span>{deck.name}</span><span className="flashcards-mobile-deck-meta">{deck.cardCount} 张卡片{deck.dueCount > 0 ? ` · ${deck.dueCount} 张待复习` : " · 今日已完成"}</span><small>{deck.dueCount > 0 ? deck.dueCount : deck.cardCount}</small>
  </button>;

  const startReview = async () => {
    if (startingReview) return;
    if (reviewQueue.length && !window.confirm("开始新一轮会替换尚未完成的复习。已保存的评分不受影响，确定重新开始？")) return;
    if(await beginPlannedReview()) setMessage("");
  };

  const reloadReviewCards = async () => {
    await reviewSession.resume(() => loadFlashcardsByIds(reviewQueue.map(card => card.id)));
    if (workspaceMounted.current) schedulePreview.refresh();
  };

  const updateDailyNewLimit = async (count: number) => {
    if (savingDailyLimit || count === dailyNewLimit) return;
    const previous = dailyNewLimit;
    setDailyNewLimit(count);
    setSavingDailyLimit(true);
    try {
      const saved = await invoke<{ dailyNewLimit: number }>("update_flashcard_study_settings", { dailyNewLimit: count });
      setDailyNewLimit(saved.dailyNewLimit);
      try { userProfileStorage.setItem(DAILY_NEW_CARD_LIMIT_KEY, String(saved.dailyNewLimit)); } catch { /* The database remains authoritative. */ }
    } catch (reason) {
      setDailyNewLimit(previous);
      setError(`无法保存每日新卡额度：${String(reason)}`);
    } finally {
      setSavingDailyLimit(false);
    }
  };

  const rate = async (rating: number) => {
    if (!schedulePreview.preview || reviewingCard) return;
    setError("");
    const expectedReviewKey = schedulePreview.preview.reviewKey;
    const saved = await reviewSession.rate(rating, (cardId, value, elapsedMs) => invoke<{ reviewId: string }>("review_flashcard", { cardId, rating: value, elapsedMs, expectedReviewKey }));
    if (!saved) { schedulePreview.refresh(); return; }
    try {
      await Promise.all([refreshDecks(), refreshDashboard()]);
    } catch (reason) {
      setError(`评分已保存，但统计刷新失败：${String(reason)}`);
    }
  };

  const undoLastRating = async () => {
    setError("");
    const undone = await reviewSession.undo((cardId, reviewId) => invoke<Flashcard>("undo_flashcard_review", { cardId, reviewId }));
    if (!undone) return;
    try {
      await Promise.all([refreshDecks(), refreshDashboard()]);
    } catch (reason) {
      setError(`评分已撤销，但统计刷新失败：${String(reason)}`);
    }
  };

  const removeCard = async (cardId: string) => {
    setDeletingCardId(cardId);
    setError("");
    try {
      await invoke("delete_flashcard", { cardId });
      if (gridModalCardId === cardId) {
        setGridModalCardId("");
        setEditingCardId("");
      }
      await Promise.all([refreshDecks(), refreshViewCards(activeView, selectedDeckId)]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setDeletingCardId("");
    }
  };

  const applyEditorValues = (values: FlashcardEditorValues) => {
    setEditQuestion(values.question);
    setEditAnswer(values.answer);
    setEditExplanation(values.explanation);
    setEditCardType(values.cardType);
    setEditDeckId(values.deckId);
    setEditSourceTitle(values.sourceTitle);
    setEditSourcePath(values.sourcePath);
    setEditOptions(values.options);
    setEditCorrectIndex(values.correctIndex);
    setEditMedia(values.media);
    setEditOcclusions(values.occlusions);
    setEditTags(values.tags);
    setEditCustomFields(values.customFields);
  };

  const currentEditorValues: FlashcardEditorValues = {
    question: editQuestion,
    answer: editAnswer,
    explanation: editExplanation,
    cardType: editCardType,
    deckId: editDeckId,
    sourceTitle: editSourceTitle,
    sourcePath: editSourcePath,
    options: editOptions,
    correctIndex: editCorrectIndex,
    media: editMedia,
    occlusions: editOcclusions,
    tags: editTags,
    customFields: editCustomFields,
  };
  const currentEditorSnapshot = serializeEditorValues(currentEditorValues);
  latestEditorSnapshotRef.current = currentEditorSnapshot;
  const editorDirty = Boolean(gridModalCardId || creatingCard) && currentEditorSnapshot !== editorBaselineRef.current;
  const editorDraftTarget: FlashcardEditorDraft["target"] | null = creatingCard
    ? { kind: "create", deckId: editDeckId }
    : gridModalCardId ? { kind: "edit", cardId: gridModalCardId } : null;
  const editorDraftTargetKey = editorDraftTarget ? `${editorDraftTarget.kind}:${editorDraftTarget.kind === "edit" ? editorDraftTarget.cardId : editorDraftTarget.deckId}` : "";

  useEffect(() => {
    if (editorSaveError && currentEditorSnapshot !== editorSaveFailureSnapshotRef.current) {
      setEditorSaveError("");
    }
  }, [currentEditorSnapshot, editorSaveError]);

  useEffect(() => {
    if (!editorDirty || !editorDraftTarget || editorRecoveryDraft) return;
    saveFlashcardEditorDraft(userProfileStorage, {
      version: 1,
      target: editorDraftTarget,
      values: JSON.parse(currentEditorSnapshot) as FlashcardEditorValues,
      updatedAt: Date.now(),
    });
  }, [currentEditorSnapshot, editorDirty, editorDraftTargetKey, editorRecoveryDraft]);

  useEffect(() => {
    if (!editorDirty || !editorDraftTarget) return;
    const saveLatestDraft = () => {
      saveFlashcardEditorDraft(userProfileStorage, {
        version: 1,
        target: editorDraftTarget,
        values: JSON.parse(latestEditorSnapshotRef.current) as FlashcardEditorValues,
        updatedAt: Date.now(),
      });
    };
    const protectUnsavedEditor = (event: BeforeUnloadEvent) => {
      saveLatestDraft();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedEditor);
    window.addEventListener(USER_PROFILE_PREPARE_FLUSH_EVENT, saveLatestDraft);
    return () => {
      window.removeEventListener("beforeunload", protectUnsavedEditor);
      window.removeEventListener(USER_PROFILE_PREPARE_FLUSH_EVENT, saveLatestDraft);
    };
  }, [editorDirty, editorDraftTargetKey]);

  const beginEditCard = (card: Flashcard) => {
    const values = editorValuesForCard(card);
    const storedDraft = loadFlashcardEditorDraft(userProfileStorage);
    const target = { kind: "edit" as const, cardId: card.id };
    if (storedDraft && !flashcardEditorDraftMatches(storedDraft, target) && !window.confirm("已有另一张卡片的本机草稿。编辑这张卡片将替换那份草稿，是否继续？")) return false;
    setInlineCell(null);
    setCreatingCard(false);
    setEditingCardId(card.id);
    applyEditorValues(values);
    setNewMediaPlacement("answer");
    setDiscardEditorConfirmOpen(false);
    setEditorValidationIssue(null);
    setEditorSaveError("");
    setEditorSaveNotice("");
    setEditorRecoveryDraft(storedDraft && flashcardEditorDraftMatches(storedDraft, target) && serializeEditorValues(storedDraft.values) !== serializeEditorValues(values) ? storedDraft : null);
    editorBaselineRef.current = serializeEditorValues(values);
  };

  const beginCreateCard = () => {
    const values = emptyEditorValues(selectedDeckId);
    const storedDraft = loadFlashcardEditorDraft(userProfileStorage);
    const target = { kind: "create" as const, deckId: selectedDeckId };
    if (storedDraft && !flashcardEditorDraftMatches(storedDraft, target) && !window.confirm("已有另一张卡片的本机草稿。新建卡片将替换那份草稿，是否继续？")) return;
    setInlineCell(null);
    setEditingCardId("");
    setGridModalCardId("");
    applyEditorValues(values);
    setNewMediaPlacement("answer");
    setDiscardEditorConfirmOpen(false);
    setEditorValidationIssue(null);
    setEditorSaveError("");
    setEditorSaveNotice("");
    setEditorRecoveryDraft(storedDraft && flashcardEditorDraftMatches(storedDraft, target) && serializeEditorValues(storedDraft.values) !== serializeEditorValues(values) ? storedDraft : null);
    editorBaselineRef.current = serializeEditorValues(values);
    setCreatingCard(true);
  };

  const forceCloseCardEditor = () => {
    setEditingCardId("");
    setGridModalCardId("");
    setCreatingCard(false);
    setDiscardEditorConfirmOpen(false);
    setEditorValidationIssue(null);
    setEditorSaveError("");
    setEditorSaveNotice("");
    setEditorRecoveryDraft(null);
  };

  const discardCardEditorChanges = () => {
    clearFlashcardEditorDraft(userProfileStorage);
    forceCloseCardEditor();
  };

  const restoreEditorDraft = () => {
    if (!editorRecoveryDraft) return;
    applyEditorValues(editorRecoveryDraft.values);
    setEditorRecoveryDraft(null);
    setMessage("已恢复上次未保存的闪卡草稿");
  };

  const discardEditorDraft = () => {
    clearFlashcardEditorDraft(userProfileStorage);
    setEditorRecoveryDraft(null);
  };

  const requestCloseCardEditor = () => {
    if (savingCard) return;
    if (editorDirty) setDiscardEditorConfirmOpen(true);
    else forceCloseCardEditor();
  };

  useModalFocus({
    active: Boolean(gridModalCardId || creatingCard),
    containerRef: cardModalRef,
    onDismiss: requestCloseCardEditor,
    suspended: Boolean(previewMedia || discardEditorConfirmOpen || qualityFeedbackOpen),
  });
  useModalFocus({
    active: Boolean(previewMedia),
    containerRef: mediaPreviewModalRef,
    onDismiss: () => setPreviewMedia(null),
  });
  useModalFocus({
    active: discardEditorConfirmOpen,
    containerRef: discardEditorConfirmRef,
    onDismiss: () => setDiscardEditorConfirmOpen(false),
  });

  const openGridCard = (card: Flashcard): boolean => {
    if (beginEditCard(card) === false) return false;
    setDetailCard(card);
    setGridModalCardId(card.id);
    return true;
  };
  useEffect(()=>{
    if(!initialCardId)return;
    let live=true;
    void loadFlashcardsByIds([initialCardId]).then(cards=>{
      if(!live)return;
      const card=cards.find(value=>value.id===initialCardId);
      if(!card)throw new Error("这张闪卡已不存在，请返回搜索更新结果。");
      if(openGridCard(card)){setActiveView("deck");setSelectedDeckId(card.deckId);if(isAndroid)setMobilePage("deck");onSearchTargetHandled?.();}
    }).catch(e=>{if(live){setError(String(e));onSearchTargetHandled?.();}});
    return()=>{live=false;};
  },[initialCardId]);

  const createDeck = async () => {
    const name = newDeckName.trim();
    if (!name || creatingDeckRef.current) return;
    creatingDeckRef.current = true;
    setSavingNewDeck(true);
    setError("");
    try {
      const id = await invoke<string>(newDeckParentId ? "create_flashcard_subdeck" : "create_flashcard_deck", { name, ...(newDeckParentId ? { parentDeckId: newDeckParentId } : {}) });
      setCreatingDeck(false);
      setNewDeckName("");
      await refreshDecks();
      setSelectedDeckId(id);
      await openView("deck", id);
      if (isAndroid) setMobilePage("deck");
      setMessage(`已创建牌组“${name}”`);
    } catch (reason) { setError(String(reason)); }
    finally { creatingDeckRef.current = false; setSavingNewDeck(false); }
  };

  useEffect(() => {
    if (!gridModalCardId && !creatingCard) setWorkspaceDraft(loadFlashcardEditorDraft(userProfileStorage));
  }, [gridModalCardId, creatingCard]);

  const recoverWorkspaceDraft = async () => {
    if (!workspaceDraft || recoveringEditor) return;
    setRecoveringEditor(true);
    setError("");
    try {
      const draft = workspaceDraft;
      if (draft.target.kind === "edit") {
        if (!decks.some(deck => deck.id === draft.values.deckId)) throw new Error("草稿所属牌组已不存在。草稿仍保留，未写入任何卡片。");
        const all = await loadFlashcardsByIds([draft.target.cardId]);
        if (!workspaceMounted.current) return;
        const card = all.find(item => draft.target.kind === "edit" && item.id === draft.target.cardId);
        if (!card) throw new Error("原卡片已不存在。草稿仍保留，未自动创建替代卡片。");
        setActiveView("deck");
        setSelectedDeckId(card.deckId);
        openGridCard(card);
      } else {
        if (!workspaceMounted.current) return;
        setActiveView("inbox");
        editorBaselineRef.current = serializeEditorValues(emptyEditorValues(draft.values.deckId));
        setCreatingCard(true);
      }
      applyEditorValues(draft.values);
      setEditorRecoveryDraft(null);
      setMessage("已找回本机草稿；确认内容后保存，不会自动提交。");
    } catch (reason) { setError(String(reason)); }
    finally { setRecoveringEditor(false); }
  };

  const beginInlineEdit = (card: Flashcard, field: EditableCardField) => {
    setEditingCardId("");
    setGridModalCardId("");
    setTagCell(null);
    setSelectedTextCell({ cardId: card.id, field });
    setInlineCell({ cardId: card.id, field });
    setInlineValue(card[field] ?? "");
  };

  const selectTableTextCell = (card: Flashcard, field: EditableCardField) => {
    if (inlineCell?.cardId === card.id && inlineCell.field === field) return;
    if (selectedTextCell?.cardId === card.id && selectedTextCell.field === field) beginInlineEdit(card, field);
    else {
      setInlineCell(null);
      setInlineValue("");
      setSelectedTextCell({ cardId: card.id, field });
    }
  };

  const tableTextCellSelected = (card: Flashcard, field: EditableCardField) => selectedTextCell?.cardId === card.id && selectedTextCell.field === field;
  const tableTextCellEditing = (card: Flashcard, field: EditableCardField) => inlineCell?.cardId === card.id && inlineCell.field === field;

  const saveInlineEdit = async (card: Flashcard) => {
    if (!inlineCell || inlineCell.cardId !== card.id || savingInlineCell) return;
    const value = inlineValue.trim();
    if (!value && inlineCell.field !== "explanation") {
      setError(inlineCell.field === "question" ? "问题不能为空" : "答案不能为空");
      return;
    }
    if (value === (card[inlineCell.field] ?? "")) {
      setInlineCell(null);
      return;
    }
    setSavingInlineCell(true);
    setError("");
    try {
      await invoke<Flashcard>("update_flashcard", {
        cardId: card.id,
        question: inlineCell.field === "question" ? value : card.question,
        answer: inlineCell.field === "answer" ? value : card.answer,
        explanation: inlineCell.field === "explanation" ? value : card.explanation ?? "",
      });
      setInlineCell(null);
      await refreshViewCards(activeView, selectedDeckId);
      setMessage("闪卡已更新");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSavingInlineCell(false);
    }
  };

  const saveCard = async () => {
    if (savingCardRef.current) return;
    const choiceOptions = editOptions.map((option) => option.trim());
    const orderingItems = editAnswer.split("\n").map((item) => item.trim()).filter(Boolean);
    const answer = editCardType === "multiple_choice" ? choiceOptions[editCorrectIndex] ?? ""
      : editCardType === "image_occlusion" ? editAnswer.trim() || "查看原图" : editAnswer;
    const cardData = editCardType === "multiple_choice"
      ? { options: choiceOptions, correctIndex: editCorrectIndex }
      : editCardType === "ordering" ? { items: orderingItems }
        : editCardType === "image_occlusion" ? { occlusions: editOcclusions } : {};
    if ((!editingCardId && !creatingCard) || !editQuestion.trim() || !answer.trim() || (!creatingCard && !editDeckId)) return;
    const submittedSnapshot = currentEditorSnapshot;
    savingCardRef.current = true;
    setSavingCard(true);
    setError("");
    setEditorSaveError("");
    setEditorSaveNotice("");
    const wasCreating = creatingCard;
    try {
      if (creatingCard) {
        await invoke<FlashcardDraft>("create_flashcard_draft", {
          question: editQuestion,
          answer,
          explanation: editExplanation,
          cardType: editCardType,
          cardData,
          media: editMedia,
          sourceTitle: editSourceTitle || null,
          sourcePath: editSourcePath || null,
          tags: editTags.split(/[,，]/).map((value) => value.trim()).filter(Boolean),
          customFields: Object.fromEntries(editCustomFields.filter((field) => field.key.trim()).map((field) => [field.key.trim(), field.value.trim()])),
        });
      } else {
        const updated = await invoke<Flashcard>("update_flashcard", {
          cardId: editingCardId,
          deckId: editDeckId,
          question: editQuestion,
          answer,
          explanation: editExplanation,
          cardType: editCardType,
          cardData,
          media: editMedia,
          sourceTitle: editSourceTitle,
          sourcePath: editSourcePath,
          tags: editTags.split(/[,，]/).map((value) => value.trim()).filter(Boolean),
          customFields: Object.fromEntries(editCustomFields.filter((field) => field.key.trim()).map((field) => [field.key.trim(), field.value.trim()])),
        });
        reviewSession.updateCard(updated);
      }
    } catch (reason) {
      editorSaveFailureSnapshotRef.current = latestEditorSnapshotRef.current;
      setEditorSaveError(editorSaveErrorDetail(reason));
      return;
    } finally {
      savingCardRef.current = false;
      setSavingCard(false);
    }

    if (latestEditorSnapshotRef.current !== submittedSnapshot) {
      editorBaselineRef.current = submittedSnapshot;
      setEditorSaveNotice("之前的版本已保存；保存期间产生的新更改仍未保存。");
      return;
    }

    clearFlashcardEditorDraft(userProfileStorage);
    forceCloseCardEditor();
    try {
      if (wasCreating) {
        await refreshDrafts();
        setActiveView("inbox");
      } else if (activeView === "deck") {
        setSelectedDeckId(editDeckId);
        await refreshViewCards("deck", editDeckId);
      } else {
        await refreshViewCards(activeView, selectedDeckId);
      }
      if (!wasCreating) await refreshDecks();
      setMessage(wasCreating ? "新闪卡已存入收件箱" : "闪卡已更新");
    } catch (reason) {
      setError(`卡片已保存，但列表刷新失败：${editorSaveErrorDetail(reason)}`);
    }
  };

  const duplicateCard = async (card: Flashcard) => {
    if (duplicatingCard) return;
    setDuplicatingCard(true);
    setError("");
    try {
      await invoke<FlashcardDraft>("create_flashcard_draft", {
        question: card.question, answer: card.answer, explanation: card.explanation ?? "",
        cardType: card.cardType, cardData: card.cardData, media: card.media,
        sourceTitle: card.sourceTitle, sourcePath: card.sourcePath,
        tags: card.tags, customFields: card.customFields,
      });
      forceCloseCardEditor();
      await refreshDrafts();
      setActiveView("inbox");
      setMessage("副本已存入收件箱");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setDuplicatingCard(false);
    }
  };

  const syncNow = async () => {
    const preserveActiveReview = reviewing && reviewQueue.length > 0;
    setError("");
    setSyncMessage("正在合并远端卡片、复习记录和媒体…");
    try {
      const currentSettings = await invoke<FlashcardSyncSettings>("get_flashcard_sync_settings");
      if (!currentSettings.configured) { setSyncMessage(""); openCloudSyncSettings(); return; }
      const result = await invoke<FlashcardSyncSummary>("sync_flashcards");
      await refreshDecks();
      await refreshViewCards(activeView, selectedDeckId);
      await Promise.all([refreshDashboard(), refreshStudySettings(), refreshDrafts()]);
      const report = result.cloudReport;
      setSyncMessage(`同步完成：${report ? `云端变更上传 ${report.uploadedChanges} / 下载 ${report.downloadedChanges}` : `已上传含 ${result.uploadedCards} 张卡片的快照`}；本次下载 ${result.downloadedCards} 张、合并 ${result.mergedReviews} 条复习记录，媒体上传 ${result.uploadedMedia} / 下载 ${result.downloadedMedia}${report?.pendingMedia ? `；${report.pendingMedia} 个附件待下载` : ""}${result.conflictRetries ? `；远端并发变化，已自动重试 ${result.conflictRetries} 次` : ""}${preserveActiveReview ? "；当前复习会话已保留，完成后再按合并结果更新计划" : ""}`);
    } catch (reason) {
      setError(String(reason));
      setSyncMessage("");
    }
  };

  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;
  useEffect(() => {
    const handleFooterSync = () => void syncNowRef.current();
    window.addEventListener("hub:flashcards-sync", handleFooterSync);
    return () => window.removeEventListener("hub:flashcards-sync", handleFooterSync);
  }, []);

  useFlashcardDataRefresh(() => Promise.all([
    refreshDecks(), refreshDeckFolders(), refreshViewCards(activeView, selectedDeckId),
    refreshDashboard(), refreshStudySettings(), refreshDrafts(),
  ]).catch(reason => setError(String(reason))));

  const runBatchUpdate = async () => {
    if (selectedCardIds.size === 0) return;
    const customFields = batchFieldKey.trim() ? { [batchFieldKey.trim()]: batchFieldValue.trim() } : null;
    if (!batchDeckId && !batchTags.trim() && !customFields) { setError("请选择目标牌组、标签或自定义字段"); return; }
    setBatchBusy(true); setError("");
    try {
      const changed = await invoke<number>("bulk_update_flashcards", {
        cardIds: [...selectedCardIds], deckId: batchDeckId || null,
        tags: batchTags.trim() ? batchTags.split(/[,，]/).map((value) => value.trim()).filter(Boolean) : null,
        customFields,
      });
      setSelectedCardIds(new Set()); setBatchDeckId(""); setBatchTags(""); setBatchFieldKey(""); setBatchFieldValue(""); setBatchEditorOpen(false);
      await Promise.all([refreshDecks(), refreshViewCards(activeView, selectedDeckId)]);
      setMessage(`已批量更新 ${changed} 张卡片`);
    } catch (reason) { setError(String(reason)); } finally { setBatchBusy(false); }
  };

  const runBatchDelete = async () => {
    if (selectedCardIds.size === 0 || !window.confirm(`确定删除选中的 ${selectedCardIds.size} 张卡片吗？`)) return;
    setBatchBusy(true); setError("");
    try {
      const changed = await invoke<number>("bulk_delete_flashcards", { cardIds: [...selectedCardIds] });
      setSelectedCardIds(new Set()); setBatchEditorOpen(false);
      await Promise.all([refreshDecks(), refreshViewCards(activeView, selectedDeckId)]);
      setMessage(`已删除 ${changed} 张卡片`);
    } catch (reason) { setError(String(reason)); } finally { setBatchBusy(false); }
  };

  const loadQualityReport = async () => {
    setQualityReportOpen(true);
    try { setQualityReport(await invoke<FlashcardQualityReport>("flashcard_quality_report", { deckId: activeView === "deck" ? selectedDeckId : null })); }
    catch (reason) { setError(String(reason)); }
  };

  const occlusionImage = editMedia.find((item) => item.mimeType.startsWith("image/"));
  const currentEditorValidationIssue = validateFlashcardEditor({
    question: editQuestion,
    deckId: creatingCard ? "inbox" : editDeckId,
    answer: editAnswer,
    cardType: editCardType,
    options: editOptions,
    correctIndex: editCorrectIndex,
    media: editMedia,
    occlusions: editOcclusions,
  });

  const requestSaveCard = () => {
    if (savingCard) return;
    if (editorRecoveryDraft) {
      cardModalRef.current?.querySelector<HTMLElement>("[data-editor-restore-draft]")?.focus();
      return;
    }
    if (currentEditorValidationIssue) {
      setEditorValidationIssue(currentEditorValidationIssue);
      cardModalRef.current?.querySelector<HTMLElement>(`[data-editor-${currentEditorValidationIssue.field}]`)?.focus();
      return;
    }
    setEditorValidationIssue(null);
    if (editorDirty) void saveCard();
  };

  useEffect(() => {
    if (editorValidationIssue && currentEditorValidationIssue?.field !== editorValidationIssue.field) {
      setEditorValidationIssue(null);
    }
  }, [currentEditorValidationIssue?.field, editorValidationIssue]);

  useEffect(() => {
    if (!gridModalCardId && !creatingCard) return;
    const saveOnShortcut = (event: KeyboardEvent) => {
      if (!isEditorSaveShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || previewMedia || discardEditorConfirmOpen || savingCard || qualityFeedbackOpen) return;
      requestSaveCard();
    };
    document.addEventListener("keydown", saveOnShortcut, true);
    return () => document.removeEventListener("keydown", saveOnShortcut, true);
  }, [qualityFeedbackOpen, creatingCard, discardEditorConfirmOpen, currentEditorValidationIssue, editorDirty, editorRecoveryDraft, gridModalCardId, previewMedia, savingCard]);

  const changeEditorCardType = (type: Flashcard["cardType"]) => {
    if (type === "multiple_choice" && editOptions.every((option) => !option.trim())) {
      setEditOptions([editAnswer, "", "", ""]);
      setEditCorrectIndex(0);
    }
    if (type === "image_occlusion" && !editAnswer.trim()) setEditAnswer("查看原图");
    setEditCardType(type);
  };

  const importOcclusionImage = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("请选择 PNG、JPEG、WebP 等图片文件"); return; }
    if (file.size > 25 * 1024 * 1024) { setError("图片不能超过 25 MB"); return; }
    setUploadingImage(true);
    setError("");
    try {
      const media = await invoke<FlashcardMedia>("import_flashcard_image", {
        fileName: file.name,
        mimeType: file.type,
        dataBase64: await fileAsBase64(file),
      });
      setEditMedia((items) => [media, ...items.filter((item) => !item.mimeType.startsWith("image/"))]);
      setEditOcclusions([]);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setUploadingImage(false);
    }
  };

  const importCardImages = async (files: File[], placement: NonNullable<FlashcardMedia["placement"]>) => {
    if (files.length === 0) return;
    const oversizedFile = files.find((file) => file.size > 64 * 1024 * 1024);
    if (oversizedFile) { setError("单个附件不能超过 64 MB"); return; }
    const availableCount = Math.max(0, 8 - editMedia.length);
    if (availableCount === 0) { setError("每张闪卡最多关联 8 个媒体文件"); return; }
    const acceptedFiles = files.slice(0, availableCount);
    setUploadingImage(true);
    setError("");
    try {
      const importedMedia: FlashcardMedia[] = [];
      for (const [index, file] of acceptedFiles.entries()) {
        const media = await invoke<FlashcardMedia>("import_flashcard_attachment", {
          fileName: file.name || `clipboard-${Date.now()}-${index + 1}.png`,
          mimeType: file.type || "application/octet-stream",
          dataBase64: await fileAsBase64(file),
        });
        importedMedia.push({ ...media, placement });
      }
      setEditMedia((items) => [...items, ...importedMedia].slice(0, 8));
      setMediaPasteNotice(`已添加 ${importedMedia.length} 个附件，将在${MEDIA_PLACEMENT_LABELS[placement]}中显示`);
      if (files.length > acceptedFiles.length) setError(`已添加前 ${acceptedFiles.length} 个；每张闪卡最多关联 8 个媒体文件`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setUploadingImage(false);
    }
  };

  const pasteCardImages = (event: ReactClipboardEvent<HTMLTextAreaElement>, placement: NonNullable<FlashcardMedia["placement"]>) => {
    if (editCardType === "image_occlusion" || uploadingImage) return;
    const itemImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const images = itemImages.length > 0
      ? itemImages
      : Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    setNewMediaPlacement(placement);
    void importCardImages(images, placement);
  };

  const pasteInlineImages = (event: ReactClipboardEvent<HTMLTextAreaElement>, card: Flashcard, placement: NonNullable<FlashcardMedia["placement"]>) => {
    if (card.cardType === "image_occlusion" || savingInlineCell) return;
    const itemImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const images = itemImages.length > 0 ? itemImages : Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    const availableCount = Math.max(0, 8 - card.media.length);
    if (availableCount === 0) { setError("每张闪卡最多关联 8 个媒体文件"); return; }
    const acceptedFiles = images.slice(0, availableCount);
    setSavingInlineCell(true);
    setError("");
    void (async () => {
      try {
        const importedMedia: FlashcardMedia[] = [];
        for (const [index, file] of acceptedFiles.entries()) {
          const media = await invoke<FlashcardMedia>("import_flashcard_image", {
            fileName: file.name || `clipboard-${Date.now()}-${index + 1}.png`,
            mimeType: file.type || "image/png",
            dataBase64: await fileAsBase64(file),
          });
          importedMedia.push({ ...media, placement });
        }
        await invoke<Flashcard>("update_flashcard", {
          cardId: card.id,
          question: card.question,
          answer: card.answer,
          explanation: card.explanation ?? "",
          media: [...card.media, ...importedMedia].slice(0, 8),
        });
        await refreshViewCards(activeView, selectedDeckId);
        setMessage(`已在${MEDIA_PLACEMENT_LABELS[placement]}中添加 ${importedMedia.length} 张图片`);
        if (images.length > acceptedFiles.length) setError(`已添加前 ${acceptedFiles.length} 张；每张闪卡最多关联 8 个媒体文件`);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setSavingInlineCell(false);
      }
    })();
  };

  const mediaPlacement = (item: FlashcardMedia): NonNullable<FlashcardMedia["placement"]> => item.placement ?? "answer";
  const mediaAt = (card: Flashcard, placement: NonNullable<FlashcardMedia["placement"]>) => card.media.filter((item) => mediaPlacement(item) === placement);
  const renderReviewMedia = (items: FlashcardMedia[], className = "flashcards-media") => items.length > 0 ? <div className={className}>
    {items.map((item, index) => <FlashcardAttachment key={`${item.url}-${index}`} item={item} />)}
  </div> : null;

  const sourcePathCanOpen = (path: string) => /^(https?:\/\/|obsidian:\/\/|craftdocs:\/\/)/i.test(path.trim());
  const canOpenCardSource = (card?: Flashcard | FlashcardDraft, path = editSourcePath) => Boolean(card?.sourceLibraryId && card.sourceDocumentId) || sourcePathCanOpen(path);
  const openCardSource = async (card?: Flashcard | FlashcardDraft, path = editSourcePath) => {
    try {
      if (card?.sourceLibraryId && card.sourceDocumentId) {
        await invoke("open_result", {
          libraryId: card.sourceLibraryId,
          documentId: card.sourceDocumentId,
          blockId: card.sourceBlockId || card.sourceDocumentId,
          resultId: null,
          openMode: sourceOpenMode,
          matchField: "content",
          matchTerms: [],
        });
      } else if (sourcePathCanOpen(path)) {
        await openExternalLink(path.trim());
        return;
      } else {
        throw new Error("当前来源没有可唤醒的 Craft 或 Obsidian 链接");
      }
      setMessage("已打开闪卡来源");
    } catch (reason) {
      setError(`无法打开闪卡来源：${String(reason)}`);
    }
  };

  const renderEditorValidationMessage = (field: FlashcardEditorValidationIssue["field"]) => editorValidationIssue?.field === field
    ? <small id="flashcards-editor-validation" className="flashcards-editor-validation" role="alert"><CircleAlert size={14} aria-hidden="true" />{editorValidationIssue.message}</small>
    : null;

  const renderCardEditor = (card?: Flashcard) => <div className="flashcards-card-editor" key={`${card?.id ?? "new"}-editor`}>
    {editorRecoveryDraft && <div className="flashcards-editor-recovery" role="status"><History size={17} aria-hidden="true" /><span><strong>发现上次未保存的草稿</strong><small>{new Date(editorRecoveryDraft.updatedAt).toLocaleString()} 自动保留，可恢复后继续编辑。</small></span><div><button type="button" onClick={discardEditorDraft}>丢弃草稿</button><button type="button" className="primary" data-editor-restore-draft onClick={restoreEditorDraft}>恢复草稿</button></div></div>}
    <div className="flashcards-card-editor-properties">
      <label><span>卡片类型</span><select value={editCardType} onChange={(event) => changeEditorCardType(event.target.value as Flashcard["cardType"])}><option value="qa">问答卡</option><option value="cloze">填空卡</option><option value="multiple_choice">选择题</option><option value="typed_answer">输入答案</option><option value="ordering">排序卡</option><option value="image_occlusion">图片遮挡卡</option></select></label>
      {creatingCard ? <label><span>保存位置</span><strong>收件箱 · 稍后拖入牌组</strong></label> : <label><span>所属牌组</span><select data-editor-deck value={editDeckId} onChange={(event) => setEditDeckId(event.target.value)} aria-invalid={editorValidationIssue?.field === "deck"} aria-describedby={editorValidationIssue?.field === "deck" ? "flashcards-editor-validation" : undefined}>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select>{renderEditorValidationMessage("deck")}</label>}
    </div>
    <label><span className="flashcards-editor-field-label"><span>问题</span>{editCardType !== "image_occlusion" && <small>可直接粘贴图片</small>}</span><textarea autoFocus={creatingCard} data-modal-initial-focus data-editor-question value={editQuestion} onChange={(event) => setEditQuestion(event.target.value)} onPaste={(event) => pasteCardImages(event, "question")} rows={2} aria-invalid={editorValidationIssue?.field === "question"} aria-describedby={editorValidationIssue?.field === "question" ? "flashcards-editor-validation" : undefined} />{renderEditorValidationMessage("question")}</label>
    {editCardType === "image_occlusion" ? <div className="flashcards-occlusion-fields">
      <label className="flashcards-image-upload"><span>遮挡图片</span><span className="flashcards-image-upload-button">{uploadingImage ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}{occlusionImage ? "更换图片" : "选择图片"}</span><input data-editor-answer type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={uploadingImage} onChange={(event) => { void importOcclusionImage(event.target.files?.[0]); event.currentTarget.value = ""; }} aria-invalid={editorValidationIssue?.field === "answer"} aria-describedby={editorValidationIssue?.field === "answer" ? "flashcards-editor-validation" : undefined} /></label>
      {renderEditorValidationMessage("answer")}
      {occlusionImage ? <Suspense fallback={<div className="flashcard-lazy-loading" role="status">正在准备内容…</div>}><ImageOcclusionCanvas imageUrl={occlusionImage.url} occlusions={editOcclusions} editable onChange={setEditOcclusions} /></Suspense> : <div className="flashcards-occlusion-empty"><ImageIcon size={24} /><span>选择图片后，在需要记忆的区域上拖动绘制遮挡框。</span></div>}
      <label><span>揭晓说明（可选）</span><textarea value={editAnswer === "查看原图" ? "" : editAnswer} onChange={(event) => setEditAnswer(event.target.value)} rows={2} placeholder="留空时揭晓原图" /></label>
    </div> : editCardType === "multiple_choice" ? <fieldset className="flashcards-choice-editor"><legend>选项（选择圆点标记正确答案）</legend>{editOptions.map((option, index) => <div key={index}>
      <input type="radio" name="correct-flashcard-option" checked={editCorrectIndex === index} onChange={() => setEditCorrectIndex(index)} aria-label={`选项 ${index + 1} 是正确答案`} />
      <input data-editor-answer={index === 0 ? "" : undefined} value={option} onChange={(event) => setEditOptions((items) => items.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`选项 ${index + 1}`} aria-invalid={editorValidationIssue?.field === "answer"} aria-describedby={editorValidationIssue?.field === "answer" ? "flashcards-editor-validation" : undefined} />
      {editOptions.length > 2 && <button type="button" onClick={() => { setEditOptions((items) => items.filter((_, itemIndex) => itemIndex !== index)); setEditCorrectIndex((current) => current === index ? 0 : current > index ? current - 1 : current); }} title="移除选项"><X size={13} /></button>}
    </div>)}{renderEditorValidationMessage("answer")}{editOptions.length < 8 && <button type="button" className="add-option" onClick={() => setEditOptions((items) => [...items, ""])}><CirclePlus size={14} />添加选项</button>}</fieldset>
      : <label><span className="flashcards-editor-field-label"><span>{editCardType === "ordering" ? "正确顺序（每行一项）" : editCardType === "typed_answer" ? "标准答案" : "答案"}</span><small>可直接粘贴图片</small></span><textarea data-editor-answer value={editAnswer} onChange={(event) => setEditAnswer(event.target.value)} onPaste={(event) => pasteCardImages(event, "answer")} rows={editCardType === "ordering" ? 5 : 3} placeholder={editCardType === "ordering" ? "第一步\n第二步\n第三步" : undefined} aria-invalid={editorValidationIssue?.field === "answer"} aria-describedby={editorValidationIssue?.field === "answer" ? "flashcards-editor-validation" : undefined} />{renderEditorValidationMessage("answer")}</label>}
    <label><span className="flashcards-editor-field-label"><span>解释（可选）</span>{editCardType !== "image_occlusion" && <small>可直接粘贴图片</small>}</span><textarea value={editExplanation} onChange={(event) => setEditExplanation(event.target.value)} onPaste={(event) => pasteCardImages(event, "explanation")} rows={2} /></label>
    <div className="flashcards-card-editor-source">
      <label><span>来源标题（可选）</span><input value={editSourceTitle} onChange={(event) => setEditSourceTitle(event.target.value)} placeholder="例如：AI API 调用限制" /></label>
      <label><span>来源路径或链接（可选）</span><span className="flashcards-source-path-input"><input value={editSourcePath} onChange={(event) => setEditSourcePath(event.target.value)} placeholder="Craft / Obsidian 链接或笔记路径" />{canOpenCardSource(card) && <button type="button" onClick={() => void openCardSource(card)} title="打开来源" aria-label="打开闪卡来源"><ExternalLink size={14} /></button>}</span></label>
    </div>
    <label><span>标签（逗号分隔）</span><input value={editTags} onChange={(event) => setEditTags(event.target.value)} placeholder="例如：物料选型, 重点" /></label>
    <div className="flashcards-custom-fields-editor">
      <div><span>自定义字段</span><button type="button" onClick={() => setEditCustomFields((items) => [...items, { key: "", value: "" }])}><CirclePlus size={13} />添加字段</button></div>
      {editCustomFields.map((field, index) => <div key={index}>
        <input value={field.key} onChange={(event) => setEditCustomFields((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} placeholder="字段名" />
        <input value={field.value} onChange={(event) => setEditCustomFields((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder="值" />
        <button type="button" onClick={() => setEditCustomFields((items) => items.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button>
      </div>)}
    </div>
    {<div className="flashcards-card-media-manager">
      <header><span><ImageIcon size={15} /><strong>附件</strong><small>支持图片、音视频、文档；单个不超过 64 MB</small></span><span><select value={newMediaPlacement} onChange={(event) => setNewMediaPlacement(event.target.value as NonNullable<FlashcardMedia["placement"]>)} aria-label="新附件显示位置">{Object.entries(MEDIA_PLACEMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><label className="flashcards-image-upload"><span>添加附件</span><span className="flashcards-image-upload-button">{uploadingImage ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}添加附件</span><input type="file" multiple disabled={uploadingImage || editMedia.length >= 8} onChange={(event) => { void importCardImages(Array.from(event.target.files ?? []), newMediaPlacement); event.currentTarget.value = ""; }} /></label></span></header>
      {mediaPasteNotice && <div className="flashcards-media-paste-notice"><Check size={13} />{mediaPasteNotice}</div>}
      {editMedia.length > 0 && <div className="flashcards-card-media-list">{editMedia.map((item, index) => <article key={`${item.url}-${index}`}>
        {item.mimeType.startsWith("image/") ? <img src={item.url} alt={item.title} /> : <Play size={18} />}
        <span><strong>{item.title || `媒体 ${index + 1}`}</strong><small>{MEDIA_PLACEMENT_LABELS[mediaPlacement(item)]}中显示</small></span>
        <select value={mediaPlacement(item)} onChange={(event) => setEditMedia((items) => items.map((media, mediaIndex) => mediaIndex === index ? { ...media, placement: event.target.value as NonNullable<FlashcardMedia["placement"]> } : media))} aria-label={`${item.title || "媒体"}显示位置`}>{Object.entries(MEDIA_PLACEMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <button type="button" onClick={() => setEditMedia((items) => items.filter((_, mediaIndex) => mediaIndex !== index))} title="移除图片" aria-label={`移除 ${item.title || "图片"}`}><Trash2 size={14} /></button>
      </article>)}</div>}
    </div>}
    {editorSaveNotice && <div id="flashcards-editor-save-notice" className="flashcards-editor-save-notice" role="status"><CircleAlert size={16} aria-hidden="true" /><span><strong>保存期间检测到新更改</strong><small>{editorSaveNotice}</small></span><button type="button" onClick={requestSaveCard} disabled={savingCard}><Save size={13} />保存最新更改</button></div>}
    {editorSaveError && <div id="flashcards-editor-save-error" className="flashcards-editor-save-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><span><strong>未能保存，内容仍保留</strong><small>{editorSaveError}</small></span><button type="button" onClick={requestSaveCard} disabled={savingCard}><RotateCcw size={13} />重试</button></div>}
    <div className="flashcards-card-editor-actions"><button onClick={requestCloseCardEditor} disabled={savingCard}><X size={14} />取消</button><button className="primary" title={editorRecoveryDraft ? "请先恢复或丢弃上次草稿" : `${creatingCard ? "创建卡片" : "保存修改"}（Ctrl+S）`} onClick={requestSaveCard} disabled={savingCard || Boolean(editorRecoveryDraft)} aria-describedby={editorSaveError ? "flashcards-editor-save-error" : editorSaveNotice ? "flashcards-editor-save-notice" : undefined}>{savingCard ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{creatingCard ? "创建卡片" : "保存修改"}</button></div>
  </div>;

  const renderCardActions = (card: Flashcard, editInModal = false) => <div className="flashcards-database-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <AgentFlashcardMaterial title={card.question} text={`问题：${card.question}\n答案：${card.answer}\n解释：${card.explanation||""}`}/>
    <button onClick={(event) => { event.stopPropagation(); editInModal ? openGridCard(card) : beginEditCard(card); }} title="编辑闪卡"><Pencil size={14} /></button>
    <button onClick={(event)=>{event.stopPropagation();openQuality({card,draft:false});}} title="反馈卡片质量" aria-label="反馈卡片质量"><Pencil size={14}/></button>
    <button disabled={savingPropertyCell} onClick={(event) => { event.stopPropagation(); void changeCardStage(card, card.status === "suspended" ? "resume" : "suspended"); }} title={card.status === "suspended" ? "恢复学习" : "暂停学习"} aria-label={card.status === "suspended" ? `恢复学习 ${card.question}` : `暂停学习 ${card.question}`}>{card.status === "suspended" ? <Play size={14} /> : <Pause size={14} />}</button>
    <button className="danger" disabled={deletingCardId === card.id} onClick={(event) => { event.stopPropagation(); void removeCard(card.id); }} title="删除闪卡"><Trash2 size={14} /></button>
  </div>;
  const renderCardSource = (card: Flashcard, fallback = "—") => {
    const label = card.sourceTitle || card.sourcePath || fallback;
    return canOpenCardSource(card, card.sourcePath)
      ? <button type="button" className={`flashcards-source-link ${card.sourceChanged ? "changed" : ""}`} onClick={(event) => { event.stopPropagation(); void openCardSource(card, card.sourcePath); }} title={`打开来源：${label}`}><span>{label}</span></button>
      : <span className={card.sourceChanged ? "changed" : ""}>{label}</span>;
  };
  const renderSourceField = (card: Flashcard, value: string) => value
    ? canOpenCardSource(card, card.sourcePath)
      ? <button type="button" className={`flashcards-source-link ${card.sourceChanged ? "changed" : ""}`} onClick={(event) => { event.stopPropagation(); void openCardSource(card, card.sourcePath); }} title={`打开来源：${value}`}><span>{value}</span></button>
      : <span className={card.sourceChanged ? "changed" : ""}>{value}</span>
    : <span>—</span>;

  const renderInlineCell = (card: Flashcard, field: EditableCardField) => {
    const value = card[field] || (field === "explanation" ? "" : "—");
    return <span className="flashcards-inline-cell-shell">{inlineCell?.cardId === card.id && inlineCell.field === field
      ? <><span className="flashcards-inline-cell-sizer" aria-hidden="true">{value || " "}</span><textarea
        className="flashcards-inline-cell-editor"
        autoFocus
        value={inlineValue}
        readOnly={savingInlineCell}
        aria-busy={savingInlineCell}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setInlineValue(event.target.value)}
        onPaste={(event) => pasteInlineImages(event, card, field)}
        onBlur={() => { if (!savingInlineCell) void saveInlineEdit(card); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setInlineCell(null);
            setInlineValue("");
          }
        }}
      /></>
      : <span className="flashcards-inline-cell-value">{value}</span>}</span>;
  };

  const renderMediaIndicator = (card: Flashcard) => card.media.some((item) => item.mimeType.startsWith("video/"))
    ? <Play size={14} />
    : card.media.length > 0 ? <ImageIcon size={14} /> : null;

  const visibleCards = cards;
  const databaseCards = visibleCards;
  const linearProgressiveView = !databaseViewActive
    || deckDatabaseView === "list"
    || deckDatabaseView === "table"
    || (isAndroid && deckDatabaseView !== "grid");

  const allExistingTags = browser.page.tags ?? [];
  const saveTagCell = async (card: Flashcard, tags: string[]) => {
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    setSavingTagCell(true);
    setError("");
    try {
      await invoke<Flashcard>("update_flashcard", { cardId: card.id, question: card.question, answer: card.answer, explanation: card.explanation ?? "", tags: normalized });
      setTagCell(null);
      await refreshViewCards(activeView, selectedDeckId);
      setMessage("标签已更新");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSavingTagCell(false);
    }
  };
  const openTagCell = (card: Flashcard) => {
    setInlineCell(null);
    setStatusCellId("");
    setDeckCell(null);
    if (tagCell?.cardId !== card.id) setTagCell({ cardId: card.id, tags: [...(card.tags ?? [])], input: "" });
  };
  const renderTagCell = (card: Flashcard) => tagCell?.cardId === card.id ? <div className="flashcards-tag-cell-editor" onClick={(event) => event.stopPropagation()}>
    <div className="flashcards-tag-cell-selected">{tagCell.tags.map((tag) => <button className="flashcards-tag-chip" style={flashcardTagStyle(tag)} key={tag} onClick={() => setTagCell((current) => current ? { ...current, tags: current.tags.filter((item) => item !== tag) } : current)}>{tag}<X size={10} /></button>)}</div>
    <input autoFocus value={tagCell.input} onChange={(event) => setTagCell((current) => current ? { ...current, input: event.target.value } : current)} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); setTagCell(null); }
      if (event.key === "Enter" && tagCell.input.trim()) { event.preventDefault(); const next = tagCell.input.trim(); setTagCell({ ...tagCell, tags: [...new Set([...tagCell.tags, next])], input: "" }); }
    }} placeholder="搜索或新增标签" />
    <div className="flashcards-tag-cell-options">{tagCell.input.trim() && !allExistingTags.some((tag) => tag.toLowerCase() === tagCell.input.trim().toLowerCase()) && !tagCell.tags.some((tag) => tag.toLowerCase() === tagCell.input.trim().toLowerCase()) && <button className="create" onClick={() => setTagCell({ ...tagCell, tags: [...tagCell.tags, tagCell.input.trim()], input: "" })}><Plus size={11} />新增“{tagCell.input.trim()}”</button>}{allExistingTags.filter((tag) => tag.toLowerCase().includes(tagCell.input.trim().toLowerCase())).map((tag) => <button key={tag} className={tagCell.tags.includes(tag) ? "selected" : ""} onClick={() => setTagCell((current) => current ? { ...current, tags: current.tags.includes(tag) ? current.tags.filter((item) => item !== tag) : [...current.tags, tag] } : current)}>{tagCell.tags.includes(tag) && <Check size={11} />}<span className="flashcards-tag-chip" style={flashcardTagStyle(tag)}>{tag}</span></button>)}</div>
    <footer><button onClick={() => setTagCell(null)}>取消</button><button className="primary" disabled={savingTagCell} onClick={() => void saveTagCell(card, tagCell.tags)}>{savingTagCell ? "保存中…" : "完成"}</button></footer>
  </div> : <button className="flashcards-tag-cell-value" onClick={(event) => { event.stopPropagation(); openTagCell(card); }}>{card.tags?.length ? card.tags.map((tag) => <span className="flashcards-tag-chip" style={flashcardTagStyle(tag)} key={tag}>{tag}</span>) : <span className="empty">添加标签</span>}</button>;
  const changeCardStage = async (card: Flashcard, stage: ReturnType<typeof cardStage> | "resume") => {
    if (savingPropertyCell || cardStage(card) === stage) return;
    setSavingPropertyCell(true);
    setError("");
    try {
      await invoke<Flashcard>("set_flashcard_stage", { cardId: card.id, stage });
      setStatusCellId("");
      await Promise.all([refreshDecks(), refreshViewCards(activeView, selectedDeckId), refreshDashboard()]);
      setMessage(stage === "resume" ? "已恢复学习，原复习时间保留" : stage === "suspended" ? "已暂停学习，卡片仍保留在牌库" : `状态已改为“${CARD_STAGE_LABELS[stage]}”`);
    } catch (reason) { setError(String(reason)); }
    finally { setSavingPropertyCell(false); }
  };
  const boardStageAtPoint = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-board-stage]")?.dataset.boardStage as ReturnType<typeof cardStage> | undefined;
  const beginBoardPointerDrag = (event: ReactPointerEvent<HTMLElement>, cardId: string) => {
    if (event.button !== 0 || (event.target as Element | null)?.closest("button,input,a,select,textarea")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    boardPointerDragRef.current = { cardId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
  };
  const updateBoardPointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = boardPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    drag.dragging = true;
    event.preventDefault();
    const card = cards.find((item) => item.id === drag.cardId);
    setBoardDragCardId(drag.cardId);
    setBoardDragPreview({ title: card ? flashcardFrontPreview(card) : "卡片", x: event.clientX, y: event.clientY });
    setBoardDropStage(boardStageAtPoint(event.clientX, event.clientY) ?? null);
  };
  const finishBoardPointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = boardPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    boardPointerDragRef.current = null;
    setBoardDragPreview(null);
    setBoardDragCardId("");
    const targetStage = boardStageAtPoint(event.clientX, event.clientY);
    setBoardDropStage(null);
    if (!drag.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    suppressBoardClickRef.current = true;
    window.setTimeout(() => { suppressBoardClickRef.current = false; }, 0);
    const card = cards.find((item) => item.id === drag.cardId);
    if (card && targetStage && cardStage(card) !== targetStage) void changeCardStage(card, targetStage);
  };
  const cancelBoardPointerDrag = () => {
    boardPointerDragRef.current = null;
    setBoardDragPreview(null);
    setBoardDragCardId("");
    setBoardDropStage(null);
  };
  const moveCardToDeck = async (card: Flashcard, deckId: string) => {
    if (deckId === card.deckId) { setDeckCell(null); return; }
    setSavingPropertyCell(true);
    setError("");
    try {
      await invoke<Flashcard>("update_flashcard", { cardId: card.id, question: card.question, answer: card.answer, explanation: card.explanation ?? "", deckId });
      setDeckCell(null);
      await Promise.all([refreshDecks(), refreshViewCards(activeView, selectedDeckId)]);
      setMessage("所属牌组已更新");
    } catch (reason) { setError(String(reason)); }
    finally { setSavingPropertyCell(false); }
  };
  const renderStatusCell = (card: Flashcard) => {
    const stage = cardStage(card);
    return <div className="flashcards-property-cell-editor"><button className="flashcards-property-cell-value" onClick={() => { setDeckCell(null); setStatusCellId((current) => current === card.id ? "" : card.id); }}><span className={`flashcards-status ${stage}`}>{CARD_STAGE_LABELS[stage]}</span><ChevronDown size={12} /></button>{statusCellId === card.id && <div className="flashcards-property-cell-popover status-options">{stage === "suspended" && <button disabled={savingPropertyCell} onClick={() => void changeCardStage(card, "resume")}><Play size={12} />恢复学习，保留复习时间</button>}{(Object.keys(CARD_STAGE_LABELS) as ReturnType<typeof cardStage>[]).map((value) => <button key={value} className={value === stage ? "selected" : ""} disabled={savingPropertyCell} onClick={() => void changeCardStage(card, value)}><span className={`flashcards-status ${value}`}>{CARD_STAGE_LABELS[value]}</span>{value === stage && <Check size={12} />}</button>)}</div>}</div>;
  };
  const renderDeckCell = (card: Flashcard) => {
    const currentDeck = decks.find((deck) => deck.id === card.deckId);
    const editor = deckCell?.cardId === card.id ? deckCell : null;
    const matchingDecks = decks.filter((deck) => !editor?.query.trim() || deck.name.toLowerCase().includes(editor.query.trim().toLowerCase()));
    return <div className="flashcards-property-cell-editor"><button className="flashcards-property-cell-value deck" onClick={(event) => { event.stopPropagation(); setStatusCellId(""); setTagCell(null); setDeckCell(editor ? null : { cardId: card.id, query: "" }); }}><span>{currentDeck?.name ?? "—"}</span><ChevronDown size={12} /></button>{editor && <div className="flashcards-property-cell-popover deck-options" onClick={(event) => event.stopPropagation()}><label><Search size={13} /><input autoFocus value={editor.query} onChange={(event) => setDeckCell({ ...editor, query: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") setDeckCell(null); }} placeholder="搜索牌组" /></label><div>{matchingDecks.map((deck) => <button key={deck.id} className={deck.id === card.deckId ? "selected" : ""} disabled={savingPropertyCell} onClick={() => void moveCardToDeck(card, deck.id)}><Layers3 size={13} /><span>{deck.name}</span>{deck.id === card.deckId && <Check size={12} />}</button>)}</div></div>}</div>;
  };
  const openDeckCell = (card: Flashcard) => {
    setInlineCell(null);
    setTagCell(null);
    setStatusCellId("");
    setDeckCell((current) => current?.cardId === card.id ? current : { cardId: card.id, query: "" });
  };

  const presentationView = databaseViewActive ? activeDeckView : undefined;
  const hiddenCardProperties = new Set(presentationView?.hiddenProperties ?? []);
  const cardPropertyVisible = (property: CardFieldKey) => !hiddenCardProperties.has(property);
  const cardLayout = presentationView?.cardLayout ?? "comfortable";
  const cardPresentationClass = `layout-${cardLayout}`;
  useEffect(() => {
    const grid = galleryGridRef.current;
    if (!grid || deckDatabaseView !== "grid") return;
    const pendingCards = new Set<HTMLElement>();
    let measurementFrame = 0;
    const measurePendingCards = () => {
      measurementFrame = 0;
      const cards = [...pendingCards];
      pendingCards.clear();
      const titleExtras = cards.map((card) => {
        const title = card.querySelector<HTMLElement>(".flashcards-grid-title");
        return galleryShowFullTitle && title ? Math.max(0, Math.ceil(title.scrollHeight - 40)) : 0;
      });
      cards.forEach((card, index) => {
        const next = `${titleExtras[index]}px`;
        if (card.style.getPropertyValue("--gallery-title-extra") !== next) card.style.setProperty("--gallery-title-extra", next);
      });
      const spans = cards.map((card) => {
        const marginBottom = Number.parseFloat(window.getComputedStyle(card).marginBottom) || 0;
        return Math.max(1, Math.ceil((card.getBoundingClientRect().height + marginBottom) / 4));
      });
      cards.forEach((card, index) => {
        const next = `span ${spans[index]}`;
        if (card.style.gridRowEnd !== next) card.style.gridRowEnd = next;
      });
    };
    const scheduleMeasurement = (elements: Element[]) => {
      elements.forEach((element) => pendingCards.add(element as HTMLElement));
      if (!measurementFrame) measurementFrame = window.requestAnimationFrame(measurePendingCards);
    };
    const observer = new ResizeObserver((entries) => scheduleMeasurement(entries.map((entry) => entry.target)));
    const cards = Array.from(grid.querySelectorAll(":scope > article"));
    cards.forEach((card) => {
      observer.observe(card);
    });
    scheduleMeasurement(cards);
    return () => {
      observer.disconnect();
      if (measurementFrame) window.cancelAnimationFrame(measurementFrame);
    };
  }, [deckDatabaseView, galleryShowFullTitle, visibleCards]);
  useEffect(() => {
    const sentinel = galleryLoadSentinelRef.current;
    if (!sentinel || deckDatabaseView !== "grid" || visibleCards.length >= browser.page.total) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      void browser.more();
    }, {
      root: sentinel.closest(".flashcards-main"),
      rootMargin: "0px 0px 480px",
      threshold: 0,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [deckDatabaseView, visibleCards.length, browser.page.total, browser.more]);
  useEffect(() => {
    const sentinel = databaseLoadSentinelRef.current;
    if (!sentinel || !linearProgressiveView || visibleCards.length >= browser.page.total) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      void browser.more();
    }, {
      root: sentinel.closest(".flashcards-main"),
      rootMargin: "0px 0px 640px",
      threshold: 0,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [linearProgressiveView, visibleCards.length, browser.page.total, browser.more]);
  const allCustomFieldKeys = browser.page.customFieldKeys ?? [];
  const cardFieldLabel = (field: CardFieldKey) => field.startsWith("custom:") ? field.slice(7) : CARD_PROPERTY_LABELS[field as CardPropertyKey];
  const availableCardFields = [...ALL_CARD_PROPERTY_KEYS, ...allCustomFieldKeys.map((key) => `custom:${key}` as CardFieldKey)];
  const searchedCardFields = availableCardFields.filter((field) => cardFieldLabel(field).toLowerCase().includes(cardPropertySearch.trim().toLowerCase()));
  const colorRuleValueOptions = (field: CardFieldKey): string[] => {
    if (field === "type") return Object.values(CARD_TYPE_LABELS);
    if (field === "status") return Object.values(CARD_STAGE_LABELS);
    if (field === "tags") return allExistingTags;
    return [];
  };
  const cardFieldValue = (card: Flashcard, field: CardFieldKey): string => {
    if (field.startsWith("custom:")) return String(card.customFields?.[field.slice(7)] ?? "");
    if (field === "answer") return card.answer;
    if (field === "explanation") return card.explanation ?? "";
    if (field === "type") return CARD_TYPE_LABELS[card.cardType];
    if (field === "status") return CARD_STAGE_LABELS[cardStage(card)];
    if (field === "deck") return decks.find((deck) => deck.id === card.deckId)?.name ?? "";
    if (field === "sourceTitle") return card.sourceTitle ?? "";
    if (field === "sourcePath") return card.sourcePath ?? "";
    if (field === "tags") return (card.tags ?? []).join(", ");
    if (field === "confidence") return card.confidence === undefined ? "" : String(Math.round(card.confidence * 100));
    if (field === "media") return card.media.length ? String(card.media.length) : "";
    return "";
  };
  const matchingColorRule = (card: Flashcard) => (presentationView?.colorRules ?? []).find((rule) => {
    const actual = cardFieldValue(card, rule.field).trim().toLocaleLowerCase();
    const expected = rule.value.trim().toLocaleLowerCase();
    if (rule.operator === "is_empty") return !actual;
    if (rule.operator === "is_not_empty") return Boolean(actual);
    if (rule.operator === "equals") return actual === expected;
    if (rule.operator === "not_contains") return !actual.includes(expected);
    return actual.includes(expected);
  });
  const cardConditionClass = (card: Flashcard) => matchingColorRule(card) ? "condition-color" : "";
  const cardConditionStyle = (card: Flashcard): CSSProperties => {
    const rule = matchingColorRule(card);
    if (!rule) return {};
    const colors = CARD_COLOR_STYLES[rule.color];
    return { "--condition-accent": colors.accent, "--condition-bg": colors.background } as CSSProperties;
  };
  const tableCustomFieldKeys = allCustomFieldKeys.filter((key) => cardPropertyVisible(`custom:${key}`));
  const tableOptionalProperties: CardPropertyKey[] = ["answer", "explanation", "type", "status", "deck", "sourceTitle", "sourcePath", "tags", "confidence"];
  const defaultTableColumnKeys = ["question", ...tableOptionalProperties.filter(cardPropertyVisible), ...tableCustomFieldKeys.map((key) => `custom:${key}`)];
  const orderedTableColumnKeys = [...(activeDeckView?.columnOrder ?? []).filter((key) => defaultTableColumnKeys.includes(key)), ...defaultTableColumnKeys.filter((key) => !(activeDeckView?.columnOrder ?? []).includes(key))];
  const tableColumnCount = 1 + orderedTableColumnKeys.length;
  const tableWidthByProperty: Record<CardPropertyKey, number> = { answer: 290, explanation: 290, type: 100, status: 100, deck: 170, sourceTitle: 180, sourcePath: 220, tags: 160, confidence: 100, media: 0 };
  const tableColumnWidth = (key: string, fallback: number) => Math.max(72, Math.min(720, activeDeckView?.columnWidths?.[key] ?? fallback));
  const tableMinWidth = 64 + tableColumnWidth("question", 290)
    + tableOptionalProperties.filter(cardPropertyVisible).reduce((sum, property) => sum + tableColumnWidth(property, tableWidthByProperty[property]), 0)
    + tableCustomFieldKeys.reduce((sum, key) => sum + tableColumnWidth(`custom:${key}`, 170), 0);
  const beginTableColumnResize = (event: ReactPointerEvent<HTMLElement>, key: string, fallback: number) => {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.parentElement as HTMLElement | null;
    const startX = event.clientX;
    const startWidth = header?.getBoundingClientRect().width ?? tableColumnWidth(key, fallback);
    const initialWidths = { ...(activeDeckView?.columnWidths ?? {}) };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: PointerEvent) => updateActiveDeckView({ columnWidths: { ...initialWidths, [key]: Math.max(72, Math.min(720, Math.round(startWidth + moveEvent.clientX - startX))) } });
    const finish = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish, { once: true });
  };
  const beginTableColumnReorder = (event: ReactPointerEvent<HTMLTableCellElement>, key: string) => {
    if (event.button !== 0 || (event.target as Element | null)?.closest("input, button, .flashcards-column-resizer")) return;
    const startX = event.clientX;
    const headerRect = event.currentTarget.getBoundingClientRect();
    const rowRect = event.currentTarget.parentElement?.getBoundingClientRect() ?? headerRect;
    const viewportRect = event.currentTarget.closest(".flashcards-database-table-wrap")?.getBoundingClientRect() ?? rowRect;
    let active = false;
    let liveOrder = [...orderedTableColumnKeys];
    const sourceWidth = headerRect.width;
    const fixedY = headerRect.top + headerRect.height / 2;
    const minX = Math.max(rowRect.left, viewportRect.left) + sourceWidth / 2;
    const maxX = Math.min(rowRect.right, viewportRect.right) - sourceWidth / 2;
    const grabOffsetX = startX - headerRect.left;
    const dragCenterX = (pointerX: number) => {
      const projectedCenter = pointerX - grabOffsetX + sourceWidth / 2;
      return Math.max(minX, Math.min(Math.max(minX, maxX), projectedCenter));
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    setTableColumnPressKey(key);
    const timer = window.setTimeout(() => {
      active = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      setTableColumnPressKey("");
      setTableColumnDrag({ key, target: key, after: false, x: dragCenterX(startX), y: fixedY, width: sourceWidth });
    }, 360);
    const move = (moveEvent: PointerEvent) => {
      if (!active) {
        if (Math.abs(moveEvent.clientX - startX) > 5 || Math.abs(moveEvent.clientY - fixedY) > headerRect.height / 2 + 5) {
          window.clearTimeout(timer);
          setTableColumnPressKey("");
        }
        return;
      }
      moveEvent.preventDefault();
      const constrainedX = dragCenterX(moveEvent.clientX);
      setTableColumnDrag((current) => current ? { ...current, x: constrainedX, y: fixedY } : current);
      const headers = Array.from(document.querySelectorAll<HTMLElement>("th[data-table-column-key]"))
        .filter((header) => header.dataset.tableColumnKey && header.dataset.tableColumnKey !== key)
        .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
      const insertAt = headers.filter((header) => {
        const rect = header.getBoundingClientRect();
        return rect.left + rect.width / 2 < constrainedX;
      }).length;
      const next = headers.map((header) => header.dataset.tableColumnKey as string);
      next.splice(insertAt, 0, key);
      if (next.every((item, index) => item === liveOrder[index])) return;
      const nearestTarget = headers.reduce<{ key: string; center: number; distance: number } | null>((nearest, header) => {
        const rect = header.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        const distance = Math.abs(center - constrainedX);
        return !nearest || distance < nearest.distance ? { key: header.dataset.tableColumnKey as string, center, distance } : nearest;
      }, null);
      const previousRects = new Map(Array.from(document.querySelectorAll<HTMLElement>("th[data-table-column-key]")).map((header) => [header.dataset.tableColumnKey ?? "", header.getBoundingClientRect()]));
      liveOrder = next;
      setTableColumnDrag((current) => current ? { ...current, target: nearestTarget?.key ?? key, after: nearestTarget ? constrainedX > nearestTarget.center : false, x: constrainedX, y: fixedY } : current);
      updateActiveDeckView({ columnOrder: next });
      window.requestAnimationFrame(() => {
        document.querySelectorAll<HTMLElement>("th[data-table-column-key]").forEach((header) => {
          const previous = previousRects.get(header.dataset.tableColumnKey ?? "");
          if (!previous) return;
          const current = header.getBoundingClientRect();
          const deltaX = previous.left - current.left;
          if (Math.abs(deltaX) > 1) header.animate([{ transform: `translateX(${deltaX}px)` }, { transform: "translateX(0)" }], { duration: 180, easing: "ease-out" });
        });
      });
    };
    const finish = () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setTableColumnPressKey("");
      setTableColumnDrag(null);
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  };
  const renderResizableHeader = (label: ReactNode, key: string, fallback: number, className: string) => <th key={key} data-table-column-key={key} className={`${className} flashcards-resizable-header${tableColumnPressKey === key ? " column-pressing" : ""}${tableColumnDrag?.key === key ? " column-dragging" : ""}${tableColumnDrag?.target === key && tableColumnDrag.key !== key ? " column-shifting" : ""}`} style={{ width: tableColumnWidth(key, fallback) }} onPointerDown={(event) => beginTableColumnReorder(event, key)}>{label}<span className="flashcards-column-resizer" role="separator" aria-orientation="vertical" aria-label={`调整${typeof label === "string" ? label : "列"}宽度`} onPointerDown={(event) => beginTableColumnResize(event, key, fallback)} /></th>;

  const removeCardMedia = async (card: Flashcard, target: FlashcardMedia) => {
    setSavingPropertyCell(true);
    setError("");
    try {
      await invoke<Flashcard>("update_flashcard", { cardId: card.id, question: card.question, answer: card.answer, explanation: card.explanation ?? "", media: card.media.filter((item) => item.url !== target.url) });
      if (previewMedia?.url === target.url) setPreviewMedia(null);
      await refreshViewCards(activeView, selectedDeckId);
      setMessage("附件已删除");
    } catch (reason) { setError(String(reason)); }
    finally { setSavingPropertyCell(false); }
  };

  const renderTableMedia = (card: Flashcard, placement: NonNullable<FlashcardMedia["placement"]>) => {
    const items = mediaAt(card, placement);
    return items.length ? <div className="flashcards-media flashcards-table-attachments">{items.map((item,index)=><div key={`${item.url}-${index}`}><FlashcardAttachment item={item}/><button disabled={savingPropertyCell} onClick={(event)=>{event.stopPropagation();void removeCardMedia(card,item);}}>删除附件</button></div>)}</div> : null;
  };

  const renderTableFieldValue = (value: string | number | boolean | undefined) => {
    if (value === undefined || value === "") return <span>—</span>;
    const text = String(value);
    const markdownImage = text.match(/^!\[[^\]]*\]\((.+)\)$/)?.[1];
    const imageUrl = markdownImage || (/^data:image\//i.test(text) || /^(?:https?:\/\/|asset:|file:).+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(text) ? text : "");
    return imageUrl ? <img className="flashcards-table-field-image" src={imageUrl} alt="字段图片" title={text} loading="lazy" decoding="async" /> : <span>{text}</span>;
  };
  const renderTagChips = (tags: string[]) => tags.length > 0 ? <span className="flashcards-tag-chips">{tags.map((tag) => <span className="flashcards-tag-chip" style={flashcardTagStyle(tag)} key={tag}>{tag}</span>)}</span> : <span>—</span>;

  const tableColumnLabel = (key: string) => {
    if (key === "question") return "正面";
    if (key.startsWith("custom:")) return key.slice(7);
    const property = key as CardPropertyKey;
    return property === "answer" ? "背面" : property === "type" ? "类型" : property === "status" ? "状态" : property === "sourcePath" ? "来源路径或链接" : CARD_PROPERTY_LABELS[property];
  };
  const tableLeadingColumnKey = orderedTableColumnKeys[0] ?? "question";
  const tableSelectAll = <input className="flashcards-select-all" type="checkbox" aria-label="全选当前卡片" disabled={browser.selectionBusy || browser.busy} checked={browser.page.matchedTotal > 0 && selectedCardIds.size === browser.page.matchedTotal} onChange={() => {
    if (selectedCardIds.size === browser.page.matchedTotal) setSelectedCardIds(new Set());
    else void browser.selectAll().then(ids => { if (ids) setSelectedCardIds(new Set(ids)); });
  }} />;
  const tableHeaderLabel = (key: string, label: ReactNode) => key === tableLeadingColumnKey ? <>{tableSelectAll}<span>{label}</span></> : label;
  const tablePrimaryClass = (key: string) => key === tableLeadingColumnKey ? " flashcards-table-primary-cell" : "";
  const tableLeadingSelection = (card: Flashcard, key: string) => key === tableLeadingColumnKey ? renderSelection(card) : null;
  const tableColumnMeta = (key: string): { label: ReactNode; width: number; className: string } => {
    const primaryClass = key === tableLeadingColumnKey ? " flashcards-table-primary-header" : "";
    if (key === "question") return { label: tableHeaderLabel(key, "正面"), width: 290, className: `column-content${primaryClass}` };
    if (key.startsWith("custom:")) return { label: tableHeaderLabel(key, key.slice(7)), width: 170, className: `column-custom${primaryClass}` };
    const property = key as CardPropertyKey;
    const className = property === "answer" || property === "explanation" ? "column-content"
      : property === "deck" ? "column-deck"
        : property === "sourceTitle" ? "column-source"
          : property === "sourcePath" ? "column-path"
            : property === "tags" ? "column-tags" : "column-compact";
    return { label: tableHeaderLabel(key, tableColumnLabel(key)), width: tableWidthByProperty[property], className: `${className}${primaryClass}` };
  };

  const renderTableCell = (card: Flashcard, key: string) => {
    if (key === "question") return <td key={key} tabIndex={0} className={`editable flashcards-table-text-cell${tablePrimaryClass(key)}${tableTextCellSelected(card, "question") ? " cell-selected" : ""}${tableTextCellEditing(card, "question") ? " cell-editing" : ""}`} onClick={(event) => { event.currentTarget.focus(); selectTableTextCell(card, "question"); }} onDoubleClick={() => beginInlineEdit(card, "question")} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); beginInlineEdit(card, "question"); } }}>{tableLeadingSelection(card, key)}<div className="flashcards-table-edit-surface">{renderInlineCell(card, "question")}{renderTableMedia(card, "question")}</div></td>;
    if (key === "answer") return <td key={key} tabIndex={0} className={`editable flashcards-table-text-cell${tablePrimaryClass(key)}${tableTextCellSelected(card, "answer") ? " cell-selected" : ""}${tableTextCellEditing(card, "answer") ? " cell-editing" : ""}`} onClick={(event) => { event.currentTarget.focus(); card.cardType === "multiple_choice" || card.cardType === "ordering" ? openGridCard(card) : selectTableTextCell(card, "answer"); }} onDoubleClick={() => card.cardType === "multiple_choice" || card.cardType === "ordering" ? openGridCard(card) : beginInlineEdit(card, "answer")} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); card.cardType === "multiple_choice" || card.cardType === "ordering" ? openGridCard(card) : beginInlineEdit(card, "answer"); } }}>{tableLeadingSelection(card, key)}<div className="flashcards-table-edit-surface">{renderInlineCell(card, "answer")}{renderTableMedia(card, "answer")}</div></td>;
    if (key === "explanation") return <td key={key} tabIndex={0} className={`editable flashcards-table-text-cell${tablePrimaryClass(key)}${tableTextCellSelected(card, "explanation") ? " cell-selected" : ""}${tableTextCellEditing(card, "explanation") ? " cell-editing" : ""}`} onClick={(event) => { event.currentTarget.focus(); selectTableTextCell(card, "explanation"); }} onDoubleClick={() => beginInlineEdit(card, "explanation")} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); beginInlineEdit(card, "explanation"); } }}>{tableLeadingSelection(card, key)}<div className="flashcards-table-edit-surface">{renderInlineCell(card, "explanation")}{renderTableMedia(card, "explanation")}</div></td>;
    if (key === "type") return <td key={key} className={tablePrimaryClass(key)}>{tableLeadingSelection(card, key)}<span className="flashcards-property">{CARD_TYPE_LABELS[card.cardType]}</span></td>;
    if (key === "status") return <td key={key} className={`flashcards-table-property-cell${tablePrimaryClass(key)}`}>{tableLeadingSelection(card, key)}{renderStatusCell(card)}</td>;
    if (key === "deck") return <td key={key} className={`flashcards-table-property-cell flashcards-whole-cell-trigger${tablePrimaryClass(key)}`} onClick={() => openDeckCell(card)}>{tableLeadingSelection(card, key)}{renderDeckCell(card)}</td>;
    if (key === "sourceTitle") return <td key={key} className={tablePrimaryClass(key)}>{tableLeadingSelection(card, key)}{renderSourceField(card, card.sourceTitle)}</td>;
    if (key === "sourcePath") return <td key={key} className={tablePrimaryClass(key)}>{tableLeadingSelection(card, key)}{renderSourceField(card, card.sourcePath)}</td>;
    if (key === "tags") return <td key={key} className={`flashcards-table-tags-cell flashcards-whole-cell-trigger${tablePrimaryClass(key)}`} onClick={() => openTagCell(card)}>{tableLeadingSelection(card, key)}{renderTagCell(card)}</td>;
    if (key === "confidence") return <td key={key} className={tablePrimaryClass(key)} title="生成或导入时对卡片内容可靠性的评分">{tableLeadingSelection(card, key)}{card.confidence === undefined ? "—" : <span className="flashcards-confidence-chip">{Math.round(card.confidence * 100)}%</span>}</td>;
    if (key.startsWith("custom:")) return <td key={key} className={`flashcards-table-custom-field${tablePrimaryClass(key)}`}>{tableLeadingSelection(card, key)}{renderTableFieldValue(card.customFields?.[key.slice(7)])}</td>;
    return null;
  };

  const renderCardVisibleProperties = (card: Flashcard) => {
    const fields: Array<{ key: string; label: string; value: ReactNode }> = [];
    if (cardPropertyVisible("explanation")) fields.push({ key: "explanation", label: "解释", value: card.explanation || "—" });
    if (cardPropertyVisible("deck")) fields.push({ key: "deck", label: "所属牌组", value: decks.find((deck) => deck.id === card.deckId)?.name ?? "—" });
    if (cardPropertyVisible("sourcePath")) fields.push({ key: "sourcePath", label: "来源路径", value: card.sourcePath ? renderSourceField(card, card.sourcePath) : "—" });
    if (cardPropertyVisible("tags")) fields.push({ key: "tags", label: "标签", value: renderTagChips(card.tags ?? []) });
    if (cardPropertyVisible("confidence")) fields.push({ key: "confidence", label: "置信度", value: card.confidence === undefined ? "—" : `${Math.round(card.confidence * 100)}%` });
    tableCustomFieldKeys.forEach((key) => fields.push({ key: `custom:${key}`, label: key, value: renderTableFieldValue(card.customFields?.[key]) }));
    return fields.length > 0 ? <div className="flashcards-view-custom-fields">{fields.map((field) => <span key={field.key}><b>{field.label}</b>{field.value}</span>)}</div> : null;
  };

  const renderGalleryVisibleProperties = (card: Flashcard) => {
    const fields: Array<{ key: string; label: string; value: ReactNode }> = [];
    if (cardPropertyVisible("answer")) fields.push({ key: "answer", label: "答案", value: card.answer || "—" });
    if (cardPropertyVisible("explanation")) fields.push({ key: "explanation", label: "解释", value: card.explanation || "—" });
    if (cardPropertyVisible("type")) fields.push({ key: "type", label: "卡片类型", value: <span className="flashcards-property">{CARD_TYPE_LABELS[card.cardType]}</span> });
    if (cardPropertyVisible("status")) fields.push({ key: "status", label: "学习状态", value: <span className={`flashcards-status ${cardStage(card)}`}>{CARD_STAGE_LABELS[cardStage(card)]}</span> });
    if (cardPropertyVisible("deck")) fields.push({ key: "deck", label: "所属牌组", value: decks.find((deck) => deck.id === card.deckId)?.name ?? "—" });
    if (cardPropertyVisible("sourceTitle")) fields.push({ key: "sourceTitle", label: "来源标题", value: (card.sourceTitle || card.sourcePath) ? renderCardSource(card) : "—" });
    if (cardPropertyVisible("sourcePath")) fields.push({ key: "sourcePath", label: "来源路径", value: card.sourcePath ? renderSourceField(card, card.sourcePath) : "—" });
    if (cardPropertyVisible("tags")) fields.push({ key: "tags", label: "标签", value: renderTagChips(card.tags ?? []) });
    if (cardPropertyVisible("confidence")) fields.push({ key: "confidence", label: "置信度", value: card.confidence === undefined ? "—" : <span className="flashcards-confidence-chip" title="生成或导入时对卡片内容可靠性的评分">{Math.round(card.confidence * 100)}%</span> });
    tableCustomFieldKeys.forEach((key) => fields.push({ key: `custom:${key}`, label: key, value: renderTableFieldValue(card.customFields?.[key]) }));
    return fields.length > 0 ? <div className={`flashcards-gallery-properties${galleryShowPropertyNames ? "" : " hide-property-names"}${!galleryShowPropertyNames && galleryCompactHiddenProperties ? " compact-hidden-properties" : ""}`}>{fields.map((field) => <div className={`gallery-field-${field.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`} key={field.key} title={field.label}>{galleryShowPropertyNames && <b>{field.label}</b>}<span>{field.value}</span></div>)}</div> : null;
  };

  const columnGroups = (Object.entries(CARD_STAGE_LABELS) as Array<[FlashcardStage, string]>).map(([stage, label]) => ({ stage, label, cards: browser.columns[stage]?.items ?? [], total: browser.page.stageCounts?.[stage] ?? 0 }));
  const boardHasMore = columnGroups.some((group) => group.cards.length < group.total);
  useEffect(() => {
    const sentinel = boardLoadSentinelRef.current;
    if (!sentinel || deckDatabaseView !== "column" || !boardHasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      void Promise.all((Object.keys(CARD_STAGE_LABELS) as FlashcardStage[]).map(stage => browser.more(stage)));
    }, {
      root: sentinel.closest(".flashcards-main"),
      rootMargin: "0px 0px 640px",
      threshold: 0,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [boardHasMore, cards.length, deckDatabaseView, browser.more]);


  const toggleCardSelection = (cardId: string) => setSelectedCardIds((current) => {
    const next = new Set(current); if (next.has(cardId)) next.delete(cardId); else next.add(cardId); return next;
  });
  const renderSelection = (card: Flashcard) => <input className="flashcards-card-select" type="checkbox" checked={selectedCardIds.has(card.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleCardSelection(card.id)} aria-label={`选择 ${card.question}`} />;

  const moveOrderingItem = (index: number, direction: -1 | 1) => {
    setOrderingResponse((items) => {
      const target = index + direction;
      if (target < 0 || target >= items.length) return items;
      const next = [...items];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const typedAnswerMatches = Boolean(currentCard)
    && typedReviewAnswerMatches(typedResponse, currentCard.answer);
  const correctOrderingItems = currentCard ? correctReviewOrdering(currentCard) : [];
  const orderingMatches = reviewOrderingMatches(orderingResponse, correctOrderingItems);
  const recommendedRating = currentCard ? recommendedReviewRating({
    cardType: currentCard.cardType,
    selectedChoice,
    correctChoice: currentCard.cardData.correctIndex,
    typedAnswerMatches,
    orderingMatches,
  }) : null;
  const currentOcclusionImage = currentCard?.media.find((item) => item.mimeType.startsWith("image/"));
  const mobileReviewProgress = reviewSessionTotal > 0 ? `${reviewSessionTotal - reviewQueue.length + 1}/${reviewSessionTotal}` : "0/0";

  return <section
    className={`flashcards-workspace${isAndroid ? ` flashcards-android mobile-page-${mobilePage}` : ""}${reviewing ? " is-reviewing" : ""}${resizingDeckSidebar ? " is-resizing-decks" : ""}`}
    style={{ "--flashcards-decks-width": `${deckSidebarWidth}px` } as CSSProperties}
  >
    <header className="flashcards-header">
      <div className="flashcards-header-identity">
        {!desktopSidebarVisible && onToggleDesktopSidebar && <button className="flashcards-sidebar-restore" onClick={onToggleDesktopSidebar} title="展开左侧边栏" aria-label="展开左侧边栏"><PanelLeftOpen size={18} /></button>}
        <button className="flashcards-back" onClick={onClose} title="返回搜索"><ArrowLeft size={20} /></button>
        <span className="flashcards-title"><BookOpenCheck size={20} /><strong>闪卡复习</strong></span>
      </div>
      {isAndroid && <label className="flashcards-global-search">
        <Search size={17} />
        <input ref={cardSearchRef} value={cardSearch} onChange={(event) => setCardSearch(event.target.value)} placeholder="搜索卡片内容…" aria-label="搜索卡片内容" />
        {cardSearch && <button onClick={() => setCardSearch("")} title="清除搜索" aria-label="清除搜索"><X size={14} /></button>}
      </label>}
      <div className="flashcards-header-actions">
        <button className="flashcards-sync-settings-toggle" onClick={() => setBackupOpen(true)} title="闪卡备份与恢复" aria-label="闪卡备份与恢复"><History size={18} /></button>
        <button className="flashcards-sync-settings-toggle" onClick={openCloudSyncSettings} title="云同步设置" aria-label="云同步设置"><Cloud size={18} /></button>
      </div>
    </header>

    {isAndroid && !reviewing && mobilePage !== "library" && <header className="flashcards-mobile-topbar">
      <button onClick={() => { if (mobilePage === "stats") { setMobilePage("review"); void openView("due"); } else { setMobilePage("library"); setReviewing(false); } }} aria-label={mobilePage === "stats" ? "返回今日" : "返回牌库"}><ArrowLeft size={21} /></button>
      <span><strong>{mobilePage === "deck" ? selectedDeck?.name ?? "牌组" : mobilePage === "review" ? "今日" : mobilePage === "stats" ? "学习统计" : "收件箱"}</strong>{mobilePage === "deck" && <small>{selectedDeckCounts.cardCount} 张卡片</small>}</span>
      {mobilePage === "deck" ? <button onClick={beginCreateCard} aria-label="新建卡片"><CirclePlus size={21} /></button> : <div className="flashcards-mobile-utilities"><button onClick={() => setBackupOpen(true)} aria-label="闪卡备份与恢复"><History size={20} /></button><button onClick={openCloudSyncSettings} aria-label="云同步设置"><Cloud size={20} /></button></div>}
    </header>}

    {!isAndroid && chromeActions && createPortal(<><button type="button" onClick={() => setBackupOpen(true)} title="闪卡备份与恢复" aria-label="闪卡备份与恢复" aria-haspopup="dialog"><History size={18} /></button><button className="flashcards-chrome-sync" type="button" onClick={openCloudSyncSettings} title="云同步设置" aria-label="云同步设置" aria-haspopup="dialog"><Cloud size={18} /></button></>, chromeActions)}
    {loading ? <div className="flashcards-loading"><LoaderCircle className="spin" size={24} />正在准备闪卡库…</div> : <div className="flashcards-body" ref={flashcardsBodyRef} inert={backupOpen}>
      <aside className="flashcards-decks">
        {!isAndroid && <div className="flashcards-sidebar-toolbar">
          <label className="flashcards-global-search flashcards-sidebar-search">
            <Search size={16} />
            <input ref={cardSearchRef} value={cardSearch} onChange={(event) => setCardSearch(event.target.value)} placeholder="搜索卡片…" aria-label="搜索卡片内容" />
            {cardSearch && <button onClick={() => setCardSearch("")} title="清除搜索" aria-label="清除搜索"><X size={14} /></button>}
          </label>
        </div>}
        {isAndroid && <div className="flashcards-mobile-library-intro">
          <div className="flashcards-mobile-library-heading"><strong>牌库</strong><button onClick={() => { setNewDeckParentId(""); setCreatingDeck(true); setCreatingDeckFolder(false); }} title="新建牌组" aria-label="新建牌组"><Plus size={20} /></button><button onClick={() => { setCreatingDeckFolder(true); setCreatingDeck(false); }} title="新建文件夹" aria-label="新建牌组文件夹"><Folder size={20} /></button></div>
          <label><Search size={18} /><input value={mobileDeckSearch} onChange={(event) => setMobileDeckSearch(event.target.value)} placeholder="搜索牌组" />{mobileDeckSearch && <button onClick={() => setMobileDeckSearch("")} aria-label="清除搜索"><X size={15} /></button>}</label>
          <small>{decks.length} 个牌组 · {totalDueCount} 张待复习</small>
          <div className="flashcards-mobile-utilities flashcards-mobile-library-utilities" role="group" aria-label="牌库管理"><button onClick={() => setBackupOpen(true)} aria-label="闪卡备份与恢复"><History size={18} /><span>备份与恢复</span></button><button onClick={openCloudSyncSettings} aria-label="云同步设置"><Cloud size={18} /><span>云同步</span></button></div>
        </div>}
        <button className={`flashcards-nav-item ${activeView === "due" ? "active" : ""}`} aria-current={activeView === "due" ? "page" : undefined} onClick={() => void openView("due")}>
          <RotateCcw size={16} /><span>今日</span><small>{totalDueCount || ""}</small>
        </button>
        <button className={`flashcards-nav-item ${activeView === "cards" ? "active" : ""}`} aria-current={activeView === "cards" ? "page" : undefined} onClick={() => void openView("cards")}>
          <BookPlus size={16} /><span>牌库</span><small>{totalCardCount}</small>
        </button>
        <button className={`flashcards-nav-item ${activeView === "inbox" ? "active" : ""}`} aria-current={activeView === "inbox" ? "page" : undefined} onClick={() => void openView("inbox")}>
          <Inbox size={16} /><span>收件箱</span><small>{drafts.length || ""}</small>
        </button>
        <button className={`flashcards-nav-item ${activeView === "stats" ? "active" : ""}`} aria-current={activeView === "stats" ? "page" : undefined} onClick={() => void openView("stats")}>
          <BarChart3 size={16} /><span>统计</span><small />
        </button>
        <button className="flashcards-nav-item flashcards-quality-entry" onClick={()=>openQuality()}><Pencil size={16}/><span>质量与制卡偏好</span></button>
        <div className="flashcards-decks-heading flashcards-decks-section"><strong>牌组</strong><button onClick={() => { setNewDeckParentId(""); setCreatingDeck(true); setCreatingDeckFolder(false); }} title="新建牌组" aria-label="新建牌组"><Plus size={14} /></button><button onClick={() => { setCreatingDeckFolder(true); setCreatingDeck(false); }} title="新建文件夹" aria-label="新建牌组文件夹"><Folder size={14} /></button></div>
        {creatingDeck && <label className="flashcards-parent-picker">父牌组<select aria-label="新牌组的父牌组" value={newDeckParentId} disabled={savingNewDeck} onChange={event => setNewDeckParentId(event.target.value)}><option value="">无（根目录）</option>{decks.map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label>}
        {creatingDeck && <div className="flashcards-new-folder-editor">
          <Layers3 size={15} /><input autoFocus aria-label="牌组名称" value={newDeckName} disabled={savingNewDeck} maxLength={80} placeholder="牌组名称" onChange={(event) => setNewDeckName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void createDeck(); if (event.key === "Escape" && !savingNewDeck) { setCreatingDeck(false); setNewDeckName(""); } }} />
          <button disabled={!newDeckName.trim() || savingNewDeck} onClick={() => void createDeck()} title="创建牌组" aria-label="创建牌组"><Check size={13} /></button><button disabled={savingNewDeck} onClick={() => { setCreatingDeck(false); setNewDeckName(""); }} title="取消" aria-label="取消新建牌组"><X size={13} /></button>
        </div>}
        {creatingDeckFolder && <div className="flashcards-new-folder-editor">
          <Folder size={15} /><input autoFocus value={newDeckFolderName} maxLength={80} placeholder="文件夹名称" onChange={(event) => setNewDeckFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createDeckFolder(); if (event.key === "Escape") { setCreatingDeckFolder(false); setNewDeckFolderName(""); } }} />
          <button disabled={!newDeckFolderName.trim()} onClick={() => void createDeckFolder()} title="保存"><Check size={13} /></button><button onClick={() => { setCreatingDeckFolder(false); setNewDeckFolderName(""); }} title="取消"><X size={13} /></button>
        </div>}
        <div className={`flashcards-deck-tree ${deckDropTarget === "" ? "root-drop-target" : ""}`}
          onDragOver={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDeckDropTarget(""); } }}
          onDrop={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); const deckId = droppedDeckId(event); if (deckId) void moveDeckToFolder(deckId, ""); } }}>
          {decks.length === 0 && deckFolders.length === 0 ? <div className="flashcards-tree-empty">暂无牌组</div> : <>
            <FlashcardDeckTree matchingIds={matchingDeckIds} onMenu={(event,deck) => openDeckTreeContextMenu(event,{kind: "deck",id:deck.id,name:deck.name})} hierarchy={deckHierarchy} decks={decks} folderId="" selectedDeckId={selectedDeckId} search={mobileDeckSearch} renderRow={renderDeckTreeItem} />
            {deckFolders.map((folder) => {
              const allFolderDecks = deckHierarchy.decksByFolder.get(folder.id) ?? [];
              const folderMatches = !mobileDeckSearch.trim() || folder.name.toLocaleLowerCase().includes(mobileDeckSearch.trim().toLocaleLowerCase());
              const folderDecks = folderMatches ? allFolderDecks : allFolderDecks.filter(mobileDeckMatches);
              if (mobileDeckSearch.trim() && folderDecks.length === 0 && !folderMatches) return null;
              const expanded = Boolean(mobileDeckSearch.trim()) || expandedFolderIds.has(folder.id);
              return <div className={`flashcards-deck-folder ${deckDropTarget === folder.id ? "drop-target" : ""}`} key={folder.id} data-deck-drop-folder={folder.id}
                onDragEnter={(event) => { event.preventDefault(); setDeckDropTarget(folder.id); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDeckDropTarget(folder.id); }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDeckDropTarget(null); }}
                onDrop={(event) => dropDeckOnFolder(event, folder.id)}>
                <button className="flashcards-folder-row" onClick={() => toggleDeckFolder(folder.id)} aria-expanded={expanded}
                  onContextMenu={(event) => openDeckTreeContextMenu(event, { kind: "folder", id: folder.id, name: folder.name })}
                  onDragEnter={(event) => { event.preventDefault(); setDeckDropTarget(folder.id); }}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDeckDropTarget(folder.id); }}
                  onDrop={(event) => dropDeckOnFolder(event, folder.id)}>
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{expanded ? <FolderOpen size={16} /> : <Folder size={16} />}<span>{folder.name}</span><small>{folderDecks.length}</small>
                </button>
                {expanded && <div className="flashcards-folder-decks" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDeckDropTarget(folder.id); }} onDrop={(event) => dropDeckOnFolder(event, folder.id)}>{folderDecks.length ? <FlashcardDeckTree matchingIds={matchingDeckIds} onMenu={(event,deck) => openDeckTreeContextMenu(event,{kind: "deck",id:deck.id,name:deck.name})} hierarchy={deckHierarchy} decks={decks} folderId={folder.id} selectedDeckId={selectedDeckId} search={folderMatches ? "" : mobileDeckSearch} renderRow={renderDeckTreeItem} /> : <span>拖入牌组</span>}</div>}
              </div>;
            })}
          </>}
          {deckDropTarget !== null && <div className="flashcards-root-drop-zone" data-deck-drop-folder="" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDeckDropTarget(""); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const deckId = droppedDeckId(event); if (deckId) void moveDeckToFolder(deckId, ""); }}>移到牌组根目录</div>}
        </div>
      </aside>

      <div
        className="flashcards-decks-resizer"
        role="separator"
        aria-label="调整牌组侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_DECK_SIDEBAR_WIDTH}
        aria-valuemax={Math.round(availableDeckSidebarMaximum(flashcardsBodyWidth))}
        aria-valuenow={Math.round(deckSidebarWidth)}
        aria-valuetext={`${Math.round(deckSidebarWidth)} 像素`}
        tabIndex={0}
        title="拖动调整宽度，双击或按 Enter 恢复默认"
        onPointerDown={resizeDeckSidebar}
        onDoubleClick={resetDeckSidebarWidth}
        onKeyDown={resizeDeckSidebarWithKeyboard}
      />

      <main className={`flashcards-main${!reviewing && activeView === "inbox" ? " flashcards-main-inbox" : ""}`} ref={mainScrollRef} onScroll={rememberMainScroll} inert={Boolean(gridModalCardId || creatingCard)}>
        {reviewError && <p role="alert">{reviewError}</p>}
        {!reviewing && workspaceDraft && !gridModalCardId && !creatingCard && <section className="flashcards-editor-recovery" aria-label="未保存的闪卡草稿">
          <Pencil size={18} /><span><strong>有一份未保存的闪卡草稿</strong><small>{workspaceDraft.values.question || "新建卡片"} · 仅保存在本机</small></span>
          <div><button disabled={recoveringEditor} onClick={() => { if (window.confirm("丢弃这份未保存的草稿？原卡片不会改变。")) { clearFlashcardEditorDraft(userProfileStorage); setWorkspaceDraft(null); } }}>丢弃草稿</button>
          <button className="primary" disabled={loading || recoveringEditor} onClick={() => void recoverWorkspaceDraft()}>{recoveringEditor ? "正在找回…" : "找回草稿"}</button></div>
        </section>}
        {reviewing ? <div className="flashcards-review">
          {!currentCard ? <div className="flashcards-review-complete">
            <BrainCircuit size={44} />
            <h2>本轮复习完成</h2>
            <p>本轮已无待复习卡片。已提交的评分已保存；已删除或在其他位置复习的卡片会自动跳过。</p>
            <div>{lastRated && <button className="secondary" disabled={reviewingCard} onClick={() => void undoLastRating()}><RotateCcw size={15} />撤销上一次评分</button>}<button onClick={() => setReviewing(false)}>返回列表</button></div>
          </div> : <>
            <div className="flashcards-review-progress">
              {isAndroid && <button onClick={() => setReviewing(false)} aria-label="退出复习"><ArrowLeft size={20} /></button>}
              <span>{reviewLabel}</span><small>{isAndroid ? mobileReviewProgress : `还剩 ${reviewQueue.length} 张`}</small>
            </div>
            <div className="flashcards-review-actions">
              <button disabled={reviewingCard} onClick={()=>openQuality({card:currentCard,draft:false})}><Pencil size={15}/>反馈</button>
              <button disabled={reviewingCard} onClick={() => openGridCard(currentCard)}><Pencil size={15} />编辑</button>
              <button disabled={reviewingCard || reviewQueue.length < 2} onClick={() => reviewSession.postpone()} title={reviewQueue.length < 2 ? "本轮只剩这一张" : "把当前卡片移到本轮末尾"}><SkipForward size={15} />稍后再看</button>
              {lastRated && <button disabled={reviewingCard} onClick={() => void undoLastRating()}><RotateCcw size={15} />撤销评分</button>}
              <button disabled={reviewingCard} onClick={() => reviewSession.pause()}>暂停复习</button>
            </div>
            <article className={`flashcards-review-card ${answerVisible ? "revealed" : ""} ${!answerVisible && (currentCard.cardType === "qa" || currentCard.cardType === "cloze" || currentCard.cardType === "image_occlusion") ? "tap-to-reveal" : ""}`} onClick={() => { if (!answerVisible && (currentCard.cardType === "qa" || currentCard.cardType === "cloze" || currentCard.cardType === "image_occlusion")) setAnswerVisible(true); }}>
              <small>{CARD_TYPE_LABELS[currentCard.cardType]}卡</small>
              <h2>{flashcardFrontPreview(currentCard)}</h2>
              {renderReviewMedia(mediaAt(currentCard, "question").filter(item => currentCard.cardType !== "image_occlusion" || !item.mimeType.startsWith("image/")), "flashcards-media flashcards-question-media")}
              {currentCard.cardType === "image_occlusion" && currentOcclusionImage && <Suspense fallback={<div className="flashcard-lazy-loading" role="status">正在准备内容…</div>}><ImageOcclusionCanvas imageUrl={currentOcclusionImage.url} occlusions={currentCard.cardData.occlusions ?? []} revealed={answerVisible} /></Suspense>}
              {currentCard.cardType === "multiple_choice" && <div className="flashcards-review-choices">
                {(currentCard.cardData.options ?? []).map((option, index) => <button key={`${option}-${index}`} disabled={answerVisible} className={answerVisible ? index === currentCard.cardData.correctIndex ? "correct" : index === selectedChoice ? "wrong" : "" : selectedChoice === index ? "selected" : ""} onClick={() => { setSelectedChoice(index); setAnswerVisible(true); }}><span>{String.fromCharCode(65 + index)}</span>{option}{answerVisible && index === currentCard.cardData.correctIndex && <Check size={16} />}{answerVisible && index === selectedChoice && index !== currentCard.cardData.correctIndex && <X size={16} />}</button>)}
              </div>}
              {currentCard.cardType === "typed_answer" && !answerVisible && <div className="flashcards-typed-response"><input value={typedResponse} onChange={(event) => setTypedResponse(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && typedResponse.trim()) setAnswerVisible(true); }} placeholder="输入答案后检查" autoFocus /><button disabled={!typedResponse.trim()} onClick={() => setAnswerVisible(true)}>检查答案</button></div>}
              {currentCard.cardType === "ordering" && !answerVisible && <div className="flashcards-ordering-response">{orderingResponse.map((item, index) => <div key={`${item}-${index}`}><span>{index + 1}</span><strong>{item}</strong><button disabled={index === 0} onClick={() => moveOrderingItem(index, -1)} title="上移"><ChevronUp size={15} /></button><button disabled={index === orderingResponse.length - 1} onClick={() => moveOrderingItem(index, 1)} title="下移"><ChevronDown size={15} /></button></div>)}<button className="check-order" onClick={() => setAnswerVisible(true)}>检查顺序</button></div>}
              {!answerVisible && isAndroid && (currentCard.cardType === "qa" || currentCard.cardType === "cloze" || currentCard.cardType === "image_occlusion") && <div className="flashcards-mobile-reveal-hint">点击卡片显示答案</div>}
              {answerVisible && <div className="flashcards-answer">
                <div className="flashcards-answer-label">答案</div>
                {currentCard.cardType === "ordering" ? <ol>{correctOrderingItems.map((item) => <li key={item}>{item}</li>)}</ol> : <p>{currentCard.answer}</p>}
                {renderReviewMedia(mediaAt(currentCard, "answer").filter(item => currentCard.cardType !== "image_occlusion" || !item.mimeType.startsWith("image/")))}
                {currentCard.cardType === "typed_answer" && <div className={`flashcards-response-result ${typedAnswerMatches ? "correct" : "wrong"}`}>{typedAnswerMatches ? <Check size={15} /> : <X size={15} />}{typedAnswerMatches ? "输入正确" : `你的答案：${typedResponse}`}</div>}
                {currentCard.cardType === "ordering" && <div className={`flashcards-response-result ${orderingMatches ? "correct" : "wrong"}`}>{orderingMatches ? <Check size={15} /> : <X size={15} />}{orderingMatches ? "顺序正确" : "顺序不正确，请对照正确顺序"}</div>}
                {currentCard.explanation && <blockquote>{currentCard.explanation}</blockquote>}
                {renderReviewMedia(mediaAt(currentCard, "explanation").filter(item => currentCard.cardType !== "image_occlusion" || !item.mimeType.startsWith("image/")))}
                {(currentCard.sourceTitle || currentCard.sourcePath) && <div className="flashcards-source"><span>来源：</span>{renderCardSource(currentCard, "来源")}</div>}
                {currentCard.sourceChanged && <div className="flashcards-source-changed">来源笔记已变化，这张卡片可能需要更新。</div>}
              </div>}
            </article>
            {!answerVisible && (currentCard.cardType === "qa" || currentCard.cardType === "cloze" || currentCard.cardType === "image_occlusion" || (currentCard.cardType === "multiple_choice" && (currentCard.cardData.options?.length ?? 0) < 2)) ? <button className="flashcards-reveal" onClick={() => setAnswerVisible(true)}>{currentCard.cardType === "image_occlusion" ? "揭晓原图" : "显示答案"}</button> : answerVisible ? <div className="flashcards-ratings">
              {schedulePreview.error && <p className="flashcards-rating-recommendation" role="alert">{schedulePreview.error} <button disabled={reviewingCard} onClick={() => void reloadReviewCards()}>重新加载卡片</button></p>}
              {recommendedRating && <p className={`flashcards-rating-recommendation rating-${recommendedRating}`}>客观题判定：建议{recommendedRating === 1 ? "重来" : "记得"}</p>}
              {[
                { rating: 1, label: "重来" },
                { rating: 2, label: "困难" },
                { rating: 3, label: "记得" },
                { rating: 4, label: "轻松" },
              ].map((item) => <button key={item.rating} disabled={reviewingCard || !schedulePreview.preview} className={`rating-${item.rating} ${recommendedRating === item.rating ? "recommended" : ""}`} onClick={() => void rate(item.rating)}>
                <strong>{item.label}</strong><small>{schedulePreview.preview ? formatReviewInterval(schedulePreview.preview.choices.find(choice => choice.rating === item.rating)!.intervalSeconds) : "加载间隔…"}</small>
              </button>)}
            </div> : null}
          </>}
        </div> : <>
          {activeView !== "inbox" && <section className={`flashcards-overview${activeView === "due" ? " flashcards-overview-due" : ""}`}>
            {activeView === "due" ? <div><div className="flashcards-overview-eyebrow"><span>闪卡</span><ChevronRight size={13} aria-hidden="true" /><strong>今日</strong><span className="flashcard-today-date">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</span></div><h1>{loading ? "正在读取复习进度…" : totalDueCount > 0 ? <>今天还有 <strong className="flashcard-today-remaining">{totalDueCount}</strong> 张</> : dailyNewLimit > 0 && remainingNew === 0 && (dashboardStats?.newDueCards ?? 0) > 0 ? "今日新卡已达上限" : "今天已完成"}</h1><p>{dashboardStats?.reviewedToday ? `今天已复习 ${dashboardStats.reviewedToday} 次，可以继续保持节奏` : totalDueCount > 0 ? "完成一轮短复习，保持知识活跃" : dailyNewLimit > 0 && remainingNew === 0 && (dashboardStats?.newDueCards ?? 0) > 0 ? "已到期的新卡明天继续，已学卡片到期后仍可复习" : "没有到期卡片，可以浏览牌库或查看学习统计"}</p><div className="flashcards-daily-new-progress" role="status">{dashboardStats && dailyNewLimit > 0 ? <>今日新卡 {Math.min(dailyNewLimit, dashboardStats.newStudiedToday ?? 0)} / {dailyNewLimit}{(dashboardStats.newDueCards ?? 0) > 0 && remainingNew === 0 ? " · 其余新卡明天继续" : ""}</> : loading ? "正在准备今日学习计划" : "按自己的节奏学习新卡"}</div></div>
                : activeView === "stats" ? <div><div className="flashcards-overview-eyebrow"><span>闪卡</span><ChevronRight size={13} /><strong>统计</strong></div><h1>学习统计</h1><p>回顾学习节奏、卡片状态和评分分布</p></div>
                : activeView === "cards" ? <div><div className="flashcards-overview-eyebrow"><span>闪卡</span><ChevronRight size={13} /><strong>牌库</strong></div><h1>全部卡片</h1><p><span>{browser.page.scopeTotal ?? 0} 张卡片</span><i /><span>使用视图、排序和筛选组织数据库</span></p></div>
                  : <div><div className="flashcards-overview-eyebrow"><span>当前牌组</span><ChevronRight size={13} /><strong>{selectedDeck?.name ?? "闪卡"}</strong></div><h1>{selectedDeck?.name ?? "闪卡"}</h1><p><span>{selectedDeckCounts.cardCount} 张卡片</span><i /> <span>{selectedDeckCounts.dueCount} 张已到期</span>{selectedDeckCounts.newCount > 0 && <><i /><span>{selectedDeckCounts.newCount} 张新卡片</span></>}{selectedDeckCounts.suspendedCount > 0 && <><i /><span>{selectedDeckCounts.suspendedCount} 张已暂停</span></>}</p></div>}
            {activeView === "due" && reviewQueue.length > 0 ? <div className="flashcards-resume-panel" aria-label="未完成的复习">
              <div className="flashcards-resume-copy"><History size={17} /><span><strong>{reviewLabel} · 复习已暂停</strong><small>还剩 {reviewQueue.length} 张，进度已保存在本机</small></span></div>
              <button className="primary" disabled={reviewingCard || loading} onClick={() => void reviewSession.resume(() => loadFlashcardsByIds(reviewQueue.map(card => card.id)))}>{reviewingCard ? "正在处理…" : "继续复习"}</button>
              <button className="secondary" disabled={reviewingCard} onClick={() => { if (window.confirm("结束本轮复习？已保存的评分会保留，当前未提交答案将丢弃。")) reviewSession.discard(); }}>结束本轮</button>
            </div> : (activeView === "due" || activeView === "deck") && <div className="flashcards-session-actions"><label>本次<select aria-label="本次复习张数" value={sessionLimit} onChange={event => { const count=Number(event.target.value); setSessionLimit(count); try { userProfileStorage.setItem("hub.flashcards.session-limit", String(count)); } catch { /* Keep this session preference. */ } }}>{[10,20,50,100].map(count => <option key={count} value={count}>{count} 张</option>)}<option value={0}>全部</option></select></label><label>每天新卡<select aria-label="每日新卡额度" value={dailyNewLimit} disabled={!dailyLimitReady || savingDailyLimit} onChange={event => void updateDailyNewLimit(Number(event.target.value))}>{DAILY_NEW_CARD_LIMIT_OPTIONS.map(count => <option key={count} value={count}>{count === 0 ? "不限" : `${count} 张`}</option>)}</select></label><button className="flashcards-start" disabled={!dailyLimitReady || startingReview || plannedSessionCount === 0} onClick={() => void startReview()}><Play size={16} />{plannedSessionCount > 0 ? `开始复习 ${plannedSessionCount} 张` : reviewPlan.newWaiting > 0 ? "今日新卡已达上限" : "今天已完成"}</button></div>}
            {activeView === "stats" && <button className="flashcards-overview-back" onClick={() => void openView("due")}><ArrowLeft size={15} />返回今日</button>}
          </section>}

          {activeView === "due" && dashboardStats && <FlashcardTodayProgress stats={dashboardStats} dailyNewLimit={dailyNewLimit} onOpenStats={() => { if (isAndroid) setMobilePage("stats"); void openView("stats"); }} />}

          {activeView === "inbox" && <Suspense fallback={<div className="flashcard-lazy-loading" role="status">正在准备内容…</div>}><FlashcardInbox drafts={drafts} decks={decks} isAndroid={isAndroid} resolving={Boolean(resolvingDraft)} onCreate={beginCreateCard} onResolve={resolveDrafts} onFeedback={(draft) => openQuality({ card: draft, draft: true })} onDragEnd={() => setInboxDropDeckId("")} onDragTarget={setInboxDropDeckId} onOpenLink={openExternalLink} onOpenSource={(draft) => void openCardSource(draft, draft.sourcePath)} /></Suspense>}

          {activeView === "stats" && dashboardStats && <Suspense fallback={<div className="flashcard-lazy-loading" role="status">正在准备内容…</div>}><StudyDashboard stats={dashboardStats} decks={decks} dueCount={totalDueCount} dailyNewLimit={dailyNewLimit} onOpenDeck={(id) => { setSelectedDeckId(id); if (isAndroid) setMobilePage("deck"); void openView("deck", id); }} /></Suspense>}

          {activeView !== "inbox" && activeView !== "due" && activeView !== "stats" && <section className="flashcards-library">
            <div className="flashcards-library-heading">
              <div className="flashcards-view-switcher" role="group" aria-label="牌组视图">
                {databaseViewActive ? <>{deckViews.map((view) => {
                  const Icon = view.type === "table" ? Table2 : view.type === "column" ? Columns3 : view.type === "grid" ? Grid2X2 : List;
                  const active = view.id === activeDeckViewId;
                  return <div className="flashcards-view-tab-wrap" key={view.id}>
                    <button className={active ? "active" : ""} onClick={() => { setCardConfigOpen(false); if (active) setViewMenuOpen((value) => !value); else selectDeckView(view); }} title={active ? "配置当前视图" : `切换到 ${view.name}`}><Icon size={15} /><span>{view.name}</span>{active && <ChevronDown size={13} />}</button>
                    {active && viewMenuOpen && <div ref={viewSettingsRef} className="flashcards-view-settings" role="dialog" aria-label="配置当前视图">
                      <input value={view.name} maxLength={60} aria-label="视图名称" title="重命名视图" onFocus={(event) => event.currentTarget.select()} onChange={(event) => updateActiveDeckView({ name: event.target.value })} onBlur={() => { if (!view.name.trim()) updateActiveDeckView({ name: DECK_VIEW_DEFAULT_NAMES[view.type] }); }} onKeyDown={(event) => { if (event.key === "Enter") setViewMenuOpen(false); }} />
                      <label><span>显示所有卡片</span><input type="checkbox" checked={view.showAll} onChange={(event) => updateActiveDeckView({ showAll: event.target.checked })} /></label>
                      <div className="flashcards-view-type-list">{([ ["table", "表格", Table2], ["column", "看板", Columns3], ["grid", "画廊", Grid2X2], ["list", "列表", List] ] as const).map(([type, label, TypeIcon]) => <button key={type} className={view.type === type ? "selected" : ""} onClick={() => chooseDeckViewType(type)}><TypeIcon size={16} /><span>{label}</span>{view.type === type && <Check size={13} />}</button>)}</div>
                      <div className="flashcards-view-settings-actions"><button onClick={duplicateActiveDeckView}><Copy size={15} />复制视图</button><button className="danger" disabled={deckViews.length <= 1} onClick={deleteActiveDeckView}><Trash2 size={15} />删除视图</button></div>
                    </div>}
                  </div>;
                })}<button className="flashcards-add-view-button" onClick={addDeckView} title="添加新视图" aria-label="添加新视图"><Plus size={16} /></button></> : null}
              </div>
              <div className="flashcards-library-tools">
                {databaseViewActive && activeDeckView?.type === "grid" && <div className="flashcards-density-toolbar" role="group" aria-label="画廊卡片大小">
                  {([["compact", "小"], ["comfortable", "中"], ["spacious", "大"]] as const).map(([layout, label]) => <button key={layout} type="button" className={(activeDeckView.cardLayout ?? "comfortable") === layout ? "selected" : ""} aria-label={`${label}卡片`} aria-pressed={(activeDeckView.cardLayout ?? "comfortable") === layout} title={`${label}卡片`} onClick={() => updateActiveDeckView({ cardLayout: layout })}><CardSizeIcon size={layout} /></button>)}
                </div>}
                {databaseViewActive && activeDeckView && <div className="flashcards-card-config-wrap" ref={cardConfigRef}>
                  <button className={`flashcards-icon-tool ${cardConfigOpen ? "active" : ""}`} onClick={() => { setViewMenuOpen(false); setCardConfigPage("root"); setColorPickerRuleId(null); setCardConfigOpen((open) => !open); }} title="卡片配置" aria-label="卡片配置"><Settings2 size={17} /></button>
                  {cardConfigOpen && <section className="flashcards-card-config" role="dialog" aria-label={`${activeDeckView.name}卡片配置`}>
                    <header>{cardConfigPage !== "root" && <button className="flashcards-card-config-back" onClick={() => { setCardConfigPage("root"); setColorPickerRuleId(null); }} aria-label="返回卡片配置"><ArrowLeft size={16} /></button>}<span><strong>{({ root: "卡片配置", colors: "条件颜色", properties: "属性是否可见", layout: "布局", gallery: "展示设置" } as Record<CardConfigPage,string>)[cardConfigPage]}</strong><small>{activeDeckView.name} · {DECK_VIEW_DEFAULT_NAMES[activeDeckView.type]}</small></span><button onClick={() => setCardConfigOpen(false)} aria-label="关闭卡片配置"><X size={15} /></button></header>
                    {cardConfigPage === "root" && <div className="flashcards-card-config-menu">
                      {<button onClick={() => setCardConfigPage("layout")}><LayoutDashboard size={16} /><span><strong>布局</strong><small>{activeDeckView.type === "grid" ? "调整卡片大小和间距" : "调整卡片密度和间距"}</small></span><em>{(activeDeckView.type === "grid" ? { compact: "小", comfortable: "中", spacious: "大" } : { compact: "紧凑", comfortable: "标准", spacious: "宽松" })[activeDeckView.cardLayout ?? "comfortable"]}</em><ChevronRight size={15} /></button>}
                      {(activeDeckView.type === "grid" || activeDeckView.type === "column") && <button onClick={() => setCardConfigPage("gallery")}><ImageIcon size={16} /><span><strong>{activeDeckView.type === "column" ? "看板设置" : "画廊设置"}</strong><small>封面、标题、换行和属性名称</small></span><em>{galleryImageCover ? (galleryCoverMode === "fit" ? "适应" : "裁剪") : "无封面"}</em><ChevronRight size={15} /></button>}
                      {activeView === "deck" && <button onClick={() => updateActiveDeckView({ showSubdecks: !activeDeckView.showSubdecks })}><Layers3 size={16} /><span><strong>包含子牌组</strong><small>列表、全选、看板和复习使用相同范围</small></span><em>{activeDeckView.showSubdecks ? "开启" : "关闭"}</em></button>}
                      <button onClick={() => setCardConfigPage("properties")}><Eye size={16} /><span><strong>属性是否可见</strong><small>每个属性均可独立设置</small></span><em>{availableCardFields.filter(cardPropertyVisible).length + 1}/{availableCardFields.length + 1}</em><ChevronRight size={15} /></button>
                      <button onClick={() => setCardConfigPage("colors")}><Palette size={16} /><span><strong>条件颜色</strong><small>根据字段条件突出显示</small></span><em>{activeDeckView.colorRules?.length ? `${activeDeckView.colorRules.length} 条` : "未设置"}</em><ChevronRight size={15} /></button>
                    </div>}
                    {cardConfigPage === "colors" && <div className="flashcards-card-config-section secondary">
                      <div className="flashcards-color-rules">{(activeDeckView.colorRules ?? []).length === 0 ? <div className="flashcards-color-empty"><Palette size={18} /><span>根据字段条件突出显示卡片</span></div> : (activeDeckView.colorRules ?? []).map((rule, index) => <div key={rule.id} className="flashcards-color-rule">
                        <header><span>条件 {index + 1}</span><button className="danger" onClick={() => removeColorRule(rule.id)} aria-label={`删除条件 ${index + 1}`}><Trash2 size={13} /></button></header>
                        <div className="flashcards-color-condition">
                          <select aria-label="条件字段" value={rule.field} onChange={(event) => { const field = event.target.value as CardFieldKey; const options = colorRuleValueOptions(field); updateColorRule(rule.id, { field, operator: field === "tags" ? "contains" : "equals", value: options[0] ?? "" }); }}>{availableCardFields.map((field) => <option key={field} value={field}>{cardFieldLabel(field)}</option>)}</select>
                          <select aria-label="条件运算符" value={rule.operator} onChange={(event) => updateColorRule(rule.id, { operator: event.target.value as CardColorOperator })}><option value="equals">等于</option><option value="contains">包含</option><option value="not_contains">不包含</option><option value="is_empty">为空</option><option value="is_not_empty">不为空</option></select>
                          {rule.operator !== "is_empty" && rule.operator !== "is_not_empty" && (colorRuleValueOptions(rule.field).length > 0 || rule.field === "tags" ? <select className="flashcards-color-value-select" aria-label="条件值" value={rule.value} onChange={(event) => updateColorRule(rule.id, { value: event.target.value })}><option value="" disabled>{rule.field === "tags" ? "选择标签" : "选择选项"}</option>{rule.value && !colorRuleValueOptions(rule.field).includes(rule.value) && <option value={rule.value}>{rule.value}</option>}{colorRuleValueOptions(rule.field).map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input aria-label="条件值" value={rule.value} onChange={(event) => updateColorRule(rule.id, { value: event.target.value })} placeholder="输入比较值" />)}
                        </div>
                        <div className="flashcards-color-result"><span>卡片背景</span><div className="flashcards-color-picker-wrap"><button className="flashcards-color-trigger" onClick={() => setColorPickerRuleId((current) => current === rule.id ? null : rule.id)} aria-expanded={colorPickerRuleId === rule.id}><i style={{ background: CARD_COLOR_STYLES[rule.color].background, borderColor: CARD_COLOR_STYLES[rule.color].accent }} />{CARD_COLOR_LABELS[rule.color]}<ChevronDown size={13} /></button>{colorPickerRuleId === rule.id && <div className="flashcards-color-palette" role="listbox" aria-label="选择卡片背景颜色">{(Object.keys(CARD_COLOR_STYLES) as CardColorName[]).map((color) => <button key={color} className={rule.color === color ? "selected" : ""} style={{ background: CARD_COLOR_STYLES[color].background, borderColor: CARD_COLOR_STYLES[color].accent }} onClick={() => { updateColorRule(rule.id, { color }); setColorPickerRuleId(null); }} title={CARD_COLOR_LABELS[color]} aria-label={CARD_COLOR_LABELS[color]} aria-selected={rule.color === color}>{rule.color === color && <Check size={13} />}</button>)}</div>}</div></div>
                      </div>)}</div>
                      <button className="flashcards-add-color-rule" onClick={addColorRule}><Plus size={15} />继续添加</button>
                    </div>}
                    {cardConfigPage === "properties" && <div className="flashcards-card-config-section secondary">
                      <div className="flashcards-card-config-title"><Eye size={15} /><span><strong>属性是否可见</strong><small>仅影响当前视图</small></span><button onClick={() => updateActiveDeckView({ hiddenProperties: availableCardFields.every((field) => !cardPropertyVisible(field)) ? [] : availableCardFields })}>{availableCardFields.every((field) => !cardPropertyVisible(field)) ? "全部显示" : "全部隐藏"}</button></div>
                      <label className="flashcards-property-search"><Search size={13} /><input value={cardPropertySearch} onChange={(event) => setCardPropertySearch(event.target.value)} placeholder="搜索字段" /></label>
                      <div className="flashcards-card-property-list">
                        {(!cardPropertySearch.trim() || "问题主字段".includes(cardPropertySearch.trim())) && <label className="required"><span>问题 <small>主字段</small></span><input type="checkbox" checked disabled /></label>}
                        {searchedCardFields.map((property) => <label key={property}><span>{cardFieldLabel(property)}</span><input type="checkbox" checked={cardPropertyVisible(property)} onChange={() => toggleCardProperty(property)} /></label>)}
                      </div>
                    </div>}
                    {cardConfigPage === "layout" && <div className="flashcards-card-config-section secondary"><div className="flashcards-card-config-title"><LayoutDashboard size={15} /><span><strong>{activeDeckView.type === "grid" ? "卡片大小" : "卡片密度"}</strong><small>仅应用于当前视图</small></span></div><div className="flashcards-card-layout-options">{([ ["compact", "紧凑"], ["comfortable", "标准"], ["spacious", "宽松"] ] as const).map(([layout, label]) => <button key={layout} className={(activeDeckView.cardLayout ?? "comfortable") === layout ? "selected" : ""} onClick={() => updateActiveDeckView({ cardLayout: layout })}><CardSizeIcon size={layout} /><span>{activeDeckView.type === "grid" ? ({ compact: "小", comfortable: "中", spacious: "大" } as const)[layout] : label}</span>{(activeDeckView.cardLayout ?? "comfortable") === layout && <Check size={13} />}</button>)}</div></div>}
                    {cardConfigPage === "gallery" && (activeDeckView.type === "grid" || activeDeckView.type === "column") && <div className="flashcards-card-config-section secondary flashcards-gallery-config">
                      <div className="flashcards-card-config-title"><ImageIcon size={15} /><span><strong>{activeDeckView.type === "column" ? "看板展示" : "画廊展示"}</strong><small>仅应用于当前{activeDeckView.type === "column" ? "看板" : "画廊"}视图</small></span></div>
                      <label><span><strong>图片作为封面</strong><small>卡片有图片时显示在顶部</small></span><input type="checkbox" checked={galleryImageCover} onChange={(event) => updateActiveDeckView({ galleryImageCover: event.target.checked })} /></label>
                      {galleryImageCover && <div className="flashcards-gallery-cover-modes"><span>封面显示方式</span><div><button className={galleryCoverMode === "fit" ? "selected" : ""} onClick={() => updateActiveDeckView({ galleryCoverMode: "fit" })}><i className="fit" /><span>适应</span>{galleryCoverMode === "fit" && <Check size={12} />}</button><button className={galleryCoverMode === "crop" ? "selected" : ""} onClick={() => updateActiveDeckView({ galleryCoverMode: "crop" })}><i className="crop" /><span>裁剪</span>{galleryCoverMode === "crop" && <Check size={12} />}</button></div></div>}
                      <label><span><strong>完整显示标题</strong><small>关闭时标题最多显示两行</small></span><input type="checkbox" checked={galleryShowFullTitle} onChange={(event) => updateActiveDeckView({ galleryShowFullTitle: event.target.checked })} /></label>
                      <label><span><strong>属性内容换行显示</strong><small>完整显示每个属性的内容</small></span><input type="checkbox" checked={galleryWrapContent} onChange={(event) => updateActiveDeckView({ galleryWrapContent: event.target.checked })} /></label>
                      <label><span><strong>隐藏属性名</strong><small>仅显示属性值，不显示字段名称</small></span><input type="checkbox" checked={!galleryShowPropertyNames} onChange={(event) => updateActiveDeckView({ galleryShowPropertyNames: !event.target.checked })} /></label>
                      {!galleryShowPropertyNames && <label><span><strong>紧凑排列属性</strong><small>短属性按卡片宽度合并排列</small></span><input type="checkbox" checked={galleryCompactHiddenProperties} onChange={(event) => updateActiveDeckView({ galleryCompactHiddenProperties: event.target.checked })} /></label>}
                    </div>}
                  </section>}
                </div>}
                {(browser.page.scopeTotal ?? 0) > 0 && <button className="flashcards-icon-tool" onClick={() => void loadQualityReport()} title="质量报告" aria-label="质量报告"><BarChart3 size={17} /></button>}
                {(browser.page.scopeTotal ?? 0) > 0 && <button className="flashcards-icon-tool flashcards-refresh" onClick={() => void refreshViewCards()} title="刷新" aria-label="刷新"><RotateCcw size={17} /></button>}
                {(browser.page.scopeTotal ?? 0) > 0 && <button className={`flashcards-icon-tool flashcards-filter-toggle ${queryToolsOpen ? "active" : ""}`} onClick={() => setQueryToolsOpen((value) => !value)} title={queryToolsOpen ? "隐藏排序和筛选" : "显示排序和筛选"} aria-label={queryToolsOpen ? "隐藏排序和筛选" : "显示排序和筛选"}><ListFilter size={18} /></button>}
                {(browser.page.scopeTotal ?? 0) > 0 && (databaseSearchOpen ? <label className="flashcards-toolbar-search"><Search size={14} /><input autoFocus value={cardSearch} onChange={(event) => setCardSearch(event.target.value)} placeholder="搜索卡片" /><button onClick={() => { setDatabaseSearchOpen(false); setCardSearch(""); }} title="关闭搜索" aria-label="关闭搜索"><X size={13} /></button></label> : <button className="flashcards-icon-tool" onClick={() => setDatabaseSearchOpen(true)} title="搜索卡片" aria-label="搜索卡片"><Search size={17} /></button>)}
                {databaseViewActive && <button className="flashcards-icon-tool flashcards-new-card" onClick={beginCreateCard} title="新建卡片" aria-label="新建卡片"><CirclePlus size={18} /></button>}
              </div>
            </div>
            <WorkspaceFilterSummary filters={[
              ...(cardSearch ? [{ label: `搜索：${cardSearch}`, clear: () => setCardSearch("") }] : []),
              ...(cardTypeFilter !== "all" ? [{ label: CARD_TYPE_LABELS[cardTypeFilter], clear: () => setCardTypeFilter("all") }] : []),
              ...(cardStageFilter !== "all" ? [{ label: CARD_STAGE_LABELS[cardStageFilter], clear: () => setCardStageFilter("all") }] : []),
            ]} onReset={resetCardFilters} />
            {(browser.page.scopeTotal ?? 0) > 0 && queryToolsOpen && <div className="flashcards-query-tools">
              <div className="flashcards-query-group">
                <span className="flashcards-query-tool-label"><ArrowUpDown size={14} />排序</span>
                <select value={cardSort} onChange={(event) => setCardSort(event.target.value as CardSort)}><option value="updated">更新时间</option><option value="created">创建时间</option><option value="due">复习时间</option><option value="question">问题</option><option value="type">卡型</option></select>
                <button onClick={() => setCardSortAscending((value) => !value)} title="切换排序方向"><ArrowUpDown size={14} />{cardSortAscending ? "升序" : "降序"}</button>
              </div>
              <div className="flashcards-query-group flashcards-filter-group">
                <span className="flashcards-query-tool-label"><Filter size={14} />筛选</span>
                <select value={cardTypeFilter} onChange={(event) => setCardTypeFilter(event.target.value as typeof cardTypeFilter)}><option value="all">全部卡型</option>{Object.entries(CARD_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                <select value={cardStageFilter} onChange={(event) => setCardStageFilter(event.target.value as typeof cardStageFilter)}><option value="all">全部状态</option>{Object.entries(CARD_STAGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              </div>
            </div>}
            {qualityReportOpen && qualityReport && <div className="flashcards-quality-report">
              <header><span><BarChart3 size={17} /><strong>生成质量报告</strong></span><button onClick={() => setQualityReportOpen(false)}><X size={14} /></button></header>
              <div className="flashcards-quality-metrics"><article><strong>{Math.round(qualityReport.sourceCoverage * 100)}%</strong><span>来源覆盖率</span><small>{qualityReport.sourceCoveredCards}/{qualityReport.totalCards} 张 · {qualityReport.sourceCount} 个来源</small></article><article><strong>{Math.round(qualityReport.duplicateRate * 100)}%</strong><span>重复率</span><small>{qualityReport.duplicateCards} 张重复</small></article><article><strong>{qualityReport.lowConfidenceCards}</strong><span>低置信度卡片</span><small>{qualityReport.unknownConfidenceCards} 张未提供置信度</small></article></div>
              <div className="flashcards-quality-types">{Object.entries(CARD_TYPE_LABELS).map(([type, label]) => <span key={type}><i style={{ width: `${qualityReport.totalCards ? ((qualityReport.cardTypeDistribution[type as Flashcard["cardType"]] ?? 0) / qualityReport.totalCards) * 100 : 0}%` }} />{label} <b>{qualityReport.cardTypeDistribution[type as Flashcard["cardType"]] ?? 0}</b></span>)}</div>
            </div>}
            {browser.busy && cards.length === 0 ? <div className="flashcards-empty" role="status">正在读取卡片…</div> : browser.page.scopeTotal === 0 ? <div className="flashcards-empty"><BookOpenCheck size={32} /><strong>{activeView === "cards" ? "还没有卡片" : "这个牌组还是空的"}</strong><span>新建和 Codex 提交的卡片会先进入收件箱，再由你移入牌组。</span><button onClick={beginCreateCard}><CirclePlus size={15} />新建第一张卡片</button></div>
              : visibleCards.length === 0 ? <div className="flashcards-empty"><Search size={28} /><strong>没有符合条件的卡片</strong><span>调整搜索、卡型或状态筛选条件。</span><button onClick={resetCardFilters}>清除筛选</button></div>
              : !databaseViewActive || deckDatabaseView === "list" || (isAndroid && deckDatabaseView !== "grid") ? <div className={`flashcards-list flashcards-database-list ${cardPresentationClass}`}>
                {databaseCards.map((card) => <article key={card.id} style={cardConditionStyle(card)} className={editingCardId === card.id ? "editing" : `${selectedCardIds.has(card.id) ? "selected " : ""}${cardConditionClass(card)}`}>
                  {editingCardId === card.id ? renderCardEditor(card) : <>
                    <div className="flashcards-list-leading"><div className="flashcards-list-type-icon" aria-hidden="true">{cardPropertyVisible("media") && card.media.some((item) => item.mimeType.startsWith("image/")) ? <ImageIcon size={17} /> : <BookOpenCheck size={17} />}</div>{renderSelection(card)}</div>
                    <div className="flashcards-list-copy"><strong>{card.question}</strong>{cardPropertyVisible("answer") && <p>{card.answer}</p>}{renderCardVisibleProperties(card)}</div>
                    {(cardPropertyVisible("type") || cardPropertyVisible("status")) && <div className="flashcards-list-meta">{cardPropertyVisible("type") && <span className="flashcards-property">{CARD_TYPE_LABELS[card.cardType]}</span>}{cardPropertyVisible("status") && <><span className={`flashcards-status ${cardStage(card)}`}>{CARD_STAGE_LABELS[cardStage(card)]}</span>{card.status !== "suspended" && <small>{dueLabel(card.dueAt)}</small>}</>}</div>}
                    {cardPropertyVisible("sourceTitle") && <div className="flashcards-list-source">{(card.sourceTitle || card.sourcePath) ? renderCardSource(card) : <span>—</span>}{card.sourceChanged && <small>来源已更新</small>}</div>}
                    {cardPropertyVisible("media") && <div className="flashcards-list-media">{renderMediaIndicator(card)}</div>}
                    {renderCardActions(card, true)}
                  </>}
                </article>)}
                {visibleCards.length < browser.page.total && <div ref={databaseLoadSentinelRef} className="flashcards-grid-load-sentinel" aria-hidden="true" />}
              </div>
                : deckDatabaseView === "table" ? <div className={`flashcards-database-table-wrap ${cardPresentationClass}`}><table className="flashcards-database-table" style={{ minWidth: tableMinWidth }}>
                  <thead><tr>
                    {orderedTableColumnKeys.map((key) => { const meta = tableColumnMeta(key); return renderResizableHeader(meta.label, key, meta.width, meta.className); })}
                    <th className="column-actions" aria-label="操作" />
                  </tr></thead>
                  <tbody>{databaseCards.map((card) => editingCardId === card.id && !gridModalCardId
                    ? <tr className="editing" key={card.id}><td colSpan={tableColumnCount}>{renderCardEditor(card)}</td></tr>
                    : <tr key={card.id} style={cardConditionStyle(card)} className={`${selectedCardIds.has(card.id) ? "selected " : ""}${inlineCell?.cardId === card.id ? "editing-inline " : ""}${cardConditionClass(card)}`}>{orderedTableColumnKeys.map((key) => renderTableCell(card, key))}<td>{renderCardActions(card, true)}</td></tr>)}</tbody>
                </table>{visibleCards.length < browser.page.total && <div ref={databaseLoadSentinelRef} className="flashcards-grid-load-sentinel" aria-hidden="true" />}</div>
                  : deckDatabaseView === "grid" ? <>
                    <div ref={galleryGridRef} className={`flashcards-database-grid ${cardPresentationClass} gallery-cover-${galleryImageCover ? galleryCoverMode : "none"}${galleryWrapContent ? " gallery-wrap-content" : ""}${galleryShowFullTitle ? " gallery-title-expanded" : ""}`}>
                    {visibleCards.map((card) => {
                      const previewImages = card.media.filter((item) => item.mimeType.startsWith("image/"));
                      const previewIndex = previewImages.length > 0 ? (galleryCoverIndexes[card.id] ?? 0) % previewImages.length : 0;
                      const previewImage = previewImages[previewIndex];
                      const cycleGalleryCover = (event: ReactMouseEvent<HTMLButtonElement>) => {
                        if (previewImages.length <= 1) return;
                        event.stopPropagation();
                        setGalleryCoverIndexes((current) => ({ ...current, [card.id]: (previewIndex + 1) % previewImages.length }));
                      };
                      const hasGalleryCover = galleryImageCover && cardPropertyVisible("media") && Boolean(previewImage);
                      return <article key={card.id} style={cardConditionStyle(card)} className={`${selectedCardIds.has(card.id) ? "selected " : ""}${hasGalleryCover ? "has-gallery-cover " : ""}${cardConditionClass(card)}`} role="button" tabIndex={0} onClick={() => openGridCard(card)} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") openGridCard(card); }}>
                        {galleryImageCover && cardPropertyVisible("media") && previewImage && <button type="button" className="flashcards-grid-cover-button" onClick={cycleGalleryCover} title={previewImages.length > 1 ? `切换封面（${previewIndex + 1}/${previewImages.length}）` : previewImage.title || "闪卡配图"}>
                          {card.cardType === "image_occlusion" ? <Suspense fallback={<div className="flashcard-lazy-loading" role="status">正在准备内容…</div>}><ImageOcclusionCanvas imageUrl={previewImage.url} occlusions={card.cardData.occlusions ?? []} loading="lazy" /></Suspense> : <img className="flashcards-grid-cover" src={previewImage.url} alt={previewImage.title || "闪卡配图"} loading="lazy" decoding="async" />}
                          {previewImages.length > 1 && <span className="flashcards-grid-cover-count">{previewIndex + 1}/{previewImages.length}</span>}
                        </button>}
                        {cardPropertyVisible("media") && (!galleryImageCover || !previewImage) && <div className="flashcards-grid-card-head">{renderMediaIndicator(card)}</div>}
                        <strong className="flashcards-grid-title">{flashcardFrontPreview(card)}</strong>
                        {renderGalleryVisibleProperties(card)}
                        <footer><small>{card.sourceChanged ? "来源已更新" : ""}</small><span className="flashcards-gallery-footer-actions">{renderSelection(card)}{renderCardActions(card, true)}</span></footer>
                      </article>;
                    })}
                    </div>
                    {visibleCards.length < browser.page.total && <div ref={galleryLoadSentinelRef} className="flashcards-grid-load-sentinel" aria-hidden="true" />}
                  </>
                    : <>
                    <div className={`flashcards-database-columns ${cardPresentationClass} gallery-cover-${galleryImageCover ? galleryCoverMode : "none"}${galleryWrapContent ? " gallery-wrap-content" : ""}${galleryShowFullTitle ? " gallery-title-expanded" : ""}`}>
                      {columnGroups.map((group) => <section key={group.stage} data-board-stage={group.stage} className={`flashcards-column stage-${group.stage}${boardDropStage === group.stage ? " drop-target" : ""}`}>
                        <header><span className={`flashcards-status ${group.stage}`}><i />{group.label}</span><small>{group.total}</small></header>
                        <div>{group.cards.map((card) => {
                          const previewImage = card.media.find((item) => item.mimeType.startsWith("image/"));
                          return <article key={card.id} draggable={false} role="button" tabIndex={0} aria-label={`打开闪卡：${flashcardFrontPreview(card)}`} style={cardConditionStyle(card)} className={`${editingCardId === card.id ? "editing " : ""}${selectedCardIds.has(card.id) ? "selected " : ""}${boardDragCardId === card.id ? "dragging " : ""}${cardConditionClass(card)}`}
                            onPointerDown={(event) => beginBoardPointerDrag(event, card.id)}
                            onPointerMove={updateBoardPointerDrag}
                            onPointerUp={finishBoardPointerDrag}
                            onPointerCancel={cancelBoardPointerDrag}
                            onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openGridCard(card); } }}
                            onClick={(event) => { if (!suppressBoardClickRef.current && !(event.target as Element).closest("button,input,a,select,textarea")) openGridCard(card); }}>
                            {editingCardId === card.id ? renderCardEditor(card) : <>
                              {galleryImageCover && cardPropertyVisible("media") && previewImage && <div className="flashcards-board-cover">{card.cardType === "image_occlusion" ? <Suspense fallback={<div className="flashcard-lazy-loading" role="status">正在准备内容…</div>}><ImageOcclusionCanvas imageUrl={previewImage.url} occlusions={card.cardData.occlusions ?? []} loading="lazy" /></Suspense> : <img src={previewImage.url} alt={previewImage.title || "闪卡配图"} loading="lazy" decoding="async" />}</div>}
                              <div className="flashcards-board-card-head"><GripVertical size={14} /><span className="flashcards-property">{CARD_TYPE_LABELS[card.cardType]}</span>{renderSelection(card)}</div>
                              <strong>{flashcardFrontPreview(card)}</strong>
                              {renderGalleryVisibleProperties(card)}
                              <footer><small>{(card.sourceTitle || card.sourcePath) ? renderCardSource(card, "来源") : ""}</small><span className="flashcards-gallery-footer-actions">{renderCardActions(card, true)}</span></footer>
                            </>}
                          </article>;
                        })}</div>
                        {group.stage === "new" && <button className="flashcards-column-new-card" onClick={beginCreateCard}><Plus size={15} />新建卡片</button>}
                      </section>)}
                    </div>
                    {boardHasMore && <div ref={boardLoadSentinelRef} className="flashcards-grid-load-sentinel" aria-hidden="true" />}
                    </>}
          </section>}
        </>}
      </main>
      {(gridModalCardId || creatingCard) && (() => {
        const modalCard = reviewing
          ? reviewQueue.find((card) => card.id === gridModalCardId) ?? cards.find((card) => card.id === gridModalCardId) ?? (detailCard?.id === gridModalCardId ? detailCard : undefined)
          : cards.find((card) => card.id === gridModalCardId) ?? reviewQueue.find((card) => card.id === gridModalCardId) ?? (detailCard?.id === gridModalCardId ? detailCard : undefined);
        return creatingCard || modalCard ? <div className="flashcards-card-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) requestCloseCardEditor(); }}>
          <section ref={cardModalRef} tabIndex={-1} className="flashcards-card-modal" role="dialog" aria-modal="true" aria-label={creatingCard ? "新建闪卡" : "编辑闪卡"}>
            <header><span><small><span>{creatingCard ? `保存到 ${selectedDeck?.name ?? "当前牌组"}` : `${modalCard ? CARD_TYPE_LABELS[modalCard.cardType] : ""}卡 · ${modalCard ? CARD_STAGE_LABELS[cardStage(modalCard)] : ""}`}</span>{savingCard ? <i className="saving" role="status">正在保存</i> : editorSaveError ? <i className="error" role="status">保存失败</i> : editorSaveNotice ? <i className="attention" role="status">有新更改</i> : editorDirty ? <i role="status">未保存</i> : null}</small><strong>{creatingCard ? "新建闪卡" : "编辑闪卡"}</strong></span><div className="flashcards-card-modal-header-actions"><button className="flashcards-card-modal-save" onClick={requestSaveCard} disabled={savingCard || Boolean(editorRecoveryDraft)} aria-describedby={editorSaveError ? "flashcards-editor-save-error" : editorSaveNotice ? "flashcards-editor-save-notice" : undefined} title={editorRecoveryDraft ? "请先恢复或丢弃上次草稿" : `${creatingCard ? "创建卡片" : "保存修改"}（Ctrl+S）`}>{savingCard ? <LoaderCircle className="spin" size={18} /> : <Save size={18} />}</button><button onClick={requestCloseCardEditor} title="关闭"><X size={18} /></button></div></header>
            <div className="flashcards-card-modal-content">{renderCardEditor(modalCard)}</div>
            {!creatingCard && !reviewing && modalCard && <footer className="flashcards-card-modal-management">
              <div><button disabled={duplicatingCard || savingCard} onClick={() => void duplicateCard(modalCard)}>{duplicatingCard ? <LoaderCircle className="spin" size={14} /> : <Copy size={14} />}复制为新卡</button><button disabled={savingPropertyCell || savingCard || editorDirty} title={editorDirty ? "请先保存卡片修改" : undefined} onClick={() => void changeCardStage(modalCard, modalCard.status === "suspended" ? "resume" : "suspended")}>{modalCard.status === "suspended" ? <Play size={14} /> : <Pause size={14} />}{modalCard.status === "suspended" ? "恢复学习" : "暂停学习"}</button><button className="danger" disabled={deletingCardId === modalCard.id || savingCard} onClick={() => { if (window.confirm("确定删除这张闪卡吗？复习记录不会再显示。")) void removeCard(modalCard.id); }}><Trash2 size={14} />删除</button></div>
              <small>{modalCard.sourceChanged ? "来源内容已更新，建议核对卡片" : "来源证据与媒体会随卡片同步"}</small>
            </footer>}
          </section>
        </div> : null;
      })()}
    </div>}
    {backupOpen && createPortal(<div className="flashcards-sync-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setBackupOpen(false); }}><section ref={backupModalRef} tabIndex={-1} role="dialog" aria-modal="true" className="flashcards-sync-page" aria-label="闪卡备份与恢复">
      <header className="flashcards-sync-page-header"><button type="button" data-modal-initial-focus onClick={() => setBackupOpen(false)} aria-label="关闭备份与恢复"><X size={18} /></button><strong>闪卡备份与恢复</strong></header>
      <div className="flashcards-sync-page-scroll"><div className="flashcards-sync-page-content">
        <Suspense fallback={<div className="flashcard-lazy-loading" role="status">正在准备内容…</div>}><FlashcardBackup disabled={reviewingCard} onRestored={async () => {
          reviewSession.discard();
          await Promise.all([refreshDecks(), refreshViewCards(activeView, selectedDeckId), refreshDashboard(), refreshDrafts()]);
        }} /></Suspense>
      </div></div>
    </section></div>, document.body)}
    {qualityFeedbackOpen && <Suspense fallback={<div className="flashcard-lazy-loading" role="status">正在准备内容…</div>}><FlashcardQuality target={qualityTarget} decks={decks} onChanged={async(id)=>{await Promise.all([refreshDecks(),refreshViewCards(activeView,selectedDeckId),refreshDashboard()]);if(id){const cards=await loadFlashcardsByIds([id]);const card=cards.find(c=>c.id===id);if(card){reviewSession.updateCard(card);reviewSession.suspendTiming();}}}} onClose={()=>setQualityFeedbackOpen(false)} onSaved={(action,target)=>{
      setMessage(action==="pause"?"反馈已记录，卡片已暂停；可在牌库恢复学习":"质量反馈已保存");
      if(!target.draft){if(action==="pause")reviewSession.removeCard(target.card.id);if(action==="edit")openGridCard(target.card as Flashcard);}
      void Promise.all([refreshDecks(),refreshViewCards(activeView,selectedDeckId),refreshDashboard()]).catch(e=>setError(String(e)));
    }} onOpenCard={(id) => {
      void loadFlashcardsByIds([id]).then(all => {
        if (!workspaceMounted.current) return;
        const card = all.find(item => item.id === id);
        if (!card) { setError("原卡片已删除，质量记录中的快照仍保留"); return; }
        if (!openGridCard(card)) return;
        setActiveView("deck");
        setSelectedDeckId(card.deckId);
        if (isAndroid) setMobilePage("deck");
        setQualityFeedbackOpen(false);
      }).catch(e => setError(String(e)));
    }} /></Suspense>}
    {previewMedia && <div className="flashcards-image-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewMedia(null); }}><section ref={mediaPreviewModalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="图片预览"><button data-modal-initial-focus onClick={() => setPreviewMedia(null)} aria-label="关闭图片预览"><X size={19} /></button><img src={previewMedia.url} alt={previewMedia.title || "闪卡图片预览"} /></section></div>}
    {discardEditorConfirmOpen && <div className="flashcards-discard-confirm-backdrop" role="presentation"><section ref={discardEditorConfirmRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="flashcards-discard-title" aria-describedby="flashcards-discard-description">
      <span><strong id="flashcards-discard-title">如何处理未保存的更改？</strong><small id="flashcards-discard-description">可以保留本机草稿，稍后继续；原卡片不会改变。</small></span>
      <div><button className="danger" onClick={discardCardEditorChanges}>放弃更改</button><button onClick={() => {
        if (!editorDraftTarget) return;
        const saved = saveFlashcardEditorDraft(userProfileStorage, { version: 1, target: editorDraftTarget, values: currentEditorValues, updatedAt: Date.now() });
        if (saved) { forceCloseCardEditor(); requestAnimationFrame(() => cardSearchRef.current?.focus()); }
        else { editorSaveFailureSnapshotRef.current = currentEditorSnapshot; setDiscardEditorConfirmOpen(false); setEditorSaveError("本机草稿保存失败，请保持编辑器打开并保存卡片。"); }
      }}>保留草稿</button><button className="primary" data-modal-initial-focus onClick={() => setDiscardEditorConfirmOpen(false)}>继续编辑</button></div>
    </section></div>}
    {selectedCardIds.size > 0 && <div className="flashcards-batch-bar" role="toolbar" aria-label="批量操作">
      {batchEditorOpen && <section className="flashcards-batch-editor" aria-label="批量编辑所选卡片">
        <header><span><strong>批量编辑</strong><small>只会修改已填写的项目</small></span><button onClick={() => setBatchEditorOpen(false)} aria-label="收起批量编辑"><X size={15} /></button></header>
        <label><span>移动到牌组</span><select value={batchDeckId} onChange={(event) => setBatchDeckId(event.target.value)}><option value="">保持原牌组</option>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label>
        <label><span>添加标签</span><input value={batchTags} onChange={(event) => setBatchTags(event.target.value)} placeholder="多个标签用逗号分隔" /></label>
        <label><span>自定义字段</span><input value={batchFieldKey} onChange={(event) => setBatchFieldKey(event.target.value)} placeholder="字段名" /></label>
        <label><span>字段值</span><input value={batchFieldValue} onChange={(event) => setBatchFieldValue(event.target.value)} placeholder="要写入的值" /></label>
        <footer><button onClick={() => setBatchEditorOpen(false)}>取消</button><button className="primary" disabled={batchBusy} onClick={() => void runBatchUpdate()}>{batchBusy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}应用修改</button></footer>
      </section>}
      <strong>已选 {selectedCardIds.size} 张</strong>
      <button className={batchEditorOpen ? "active" : ""} aria-expanded={batchEditorOpen} onClick={() => setBatchEditorOpen((open) => !open)}><Pencil size={14} /><span>批量编辑</span></button>
      <button className="danger" disabled={batchBusy} onClick={() => void runBatchDelete()}><Trash2 size={14} /><span>删除</span></button>
      <button className="flashcards-batch-close" onClick={() => { setSelectedCardIds(new Set()); setBatchEditorOpen(false); }} aria-label="退出批量选择"><X size={15} /></button>
    </div>}
    {isAndroid && !reviewing && <MobileTabBar
      className="flashcards-mobile-nav"
      label="闪卡导航"
      active={mobilePage === "stats" ? "review" : mobilePage === "deck" ? "library" : mobilePage}
      items={[
        { key: "review", label: "今日", icon: RotateCcw, count: totalDueCount },
        { key: "library", label: "牌库", icon: Layers3 },
        { key: "inbox", label: "收件箱", icon: Inbox, count: drafts.length },
      ]}
      onSelect={(key) => {
        if (key === "review") { setMobilePage("review"); void openView("due"); }
        else if (key === "library") setMobilePage("library");
        else { setMobilePage("inbox"); void openView("inbox"); }
      }}
    />}
    {tableColumnDrag && <div className="flashcards-table-column-drag-preview" style={{ left: tableColumnDrag.x, top: tableColumnDrag.y, width: tableColumnDrag.width }}>{tableColumnLabel(tableColumnDrag.key)}</div>}
    {deckDragPreview && <div className="flashcards-deck-drag-preview" style={{ left: deckDragPreview.x + 14, top: deckDragPreview.y + 14 }}><Layers3 size={14} /><span>{deckDragPreview.name}</span></div>}
    {boardDragPreview && <div className="flashcards-board-drag-preview" style={{ left: boardDragPreview.x + 14, top: boardDragPreview.y + 14 }}><GripVertical size={14} /><span>{boardDragPreview.title}</span></div>}
    {deckTreeContextMenu && <div className="flashcards-deck-context-menu" role="menu" style={{ left: deckTreeContextMenu.x, top: deckTreeContextMenu.y }} onContextMenu={(event) => event.preventDefault()}>
      {deckTreeRename?.id === deckTreeContextMenu.id && deckTreeRename.kind === deckTreeContextMenu.kind ? <div className="flashcards-deck-context-rename">
        <input autoFocus maxLength={80} value={deckTreeRename.value} onChange={(event) => setDeckTreeRename({ ...deckTreeRename, value: event.target.value })} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") void saveDeckTreeRename(); if (event.key === "Escape") { setDeckTreeRename(null); setDeckTreeContextMenu(null); } }} />
        <div><button onClick={() => { setDeckTreeRename(null); setDeckTreeContextMenu(null); }}>取消</button><button className="primary" disabled={!deckTreeRename.value.trim()} onClick={() => void saveDeckTreeRename()}>保存</button></div>
      </div> : <>
        {deckTreeContextMenu.kind === "deck" && <>
          <button role="menuitem" onClick={() => { setNewDeckParentId(deckTreeContextMenu.id); setNewDeckName(""); setCreatingDeck(true); setCreatingDeckFolder(false); setDeckTreeContextMenu(null); }}><Plus size={15}/><span>新建子牌组</span></button>
          <label className="flashcards-parent-picker">父牌组<select aria-label="移动到父牌组" value={decks.find(deck => deck.id === deckTreeContextMenu.id)?.parentDeckId ?? ""} onChange={event => void changeDeckParent(deckTreeContextMenu.id, event.target.value)}><option value="">无（根目录）</option>{decks.filter(deck => !blockedParentIds.has(deck.id)).map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label>
        </>}
        <button role="menuitem" onClick={() => void pinDeckTreeTarget(deckTreeContextMenu)}><Pin size={15} /><span>置顶</span></button>
        <button role="menuitem" onClick={() => setDeckTreeRename({ kind: deckTreeContextMenu.kind, id: deckTreeContextMenu.id, value: deckTreeContextMenu.name })}><Pencil size={15} /><span>重命名</span></button>
        <div className="flashcards-deck-context-separator" />
        <button role="menuitem" className="danger" onClick={() => void deleteDeckTreeTarget(deckTreeContextMenu)}><Trash2 size={15} /><span>删除</span></button>
      </>}
    </div>}
  </section>;
}
