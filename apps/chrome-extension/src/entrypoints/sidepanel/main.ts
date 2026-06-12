import type { BgToPanel } from "../../lib/panel-contracts";
import {
  defaultSettings,
  loadSettings,
  patchSettings,
  type SlidesLayout,
} from "../../lib/settings";
import { generateToken } from "../../lib/token";
import { createAppearanceControls } from "./appearance-controls";
import { createSidepanelBgMessageRuntime } from "./bg-message-runtime";
import { bindSidepanelUiEvents } from "./bindings";
import { bootstrapSidepanel } from "./bootstrap-runtime";
import { createSidepanelDom } from "./dom";
import { createSidepanelInteractionRuntime } from "./interaction-runtime";
import { createMetricsController } from "./metrics-controller";
import type { PanelCachePayload } from "./panel-cache";
import { createPanelMessagingRuntime } from "./panel-messaging";
import { createPanelStateStore } from "./panel-state-store";
import { createSidepanelPresentationRuntime } from "./presentation-runtime";
import { selectRetainedSlideSummaryMarkdown } from "./retained-slide-summary";
import { createSidepanelRunRuntime } from "./run-runtime";
import { createSidepanelSessionRuntime } from "./session-runtime";
import { createSetupControlsRuntime } from "./setup-controls-runtime";
import { friendlyFetchError } from "./setup-runtime";
import { resolveSlidesInputMode } from "./slides-session-state";
import { registerSidepanelTestHooks } from "./test-hooks";
import type { UiState } from "./types";
import { createTypographyController } from "./typography-controller";
import { createUiStateRuntime } from "./ui-state-runtime";

const dom = createSidepanelDom();
const {
  advancedBtn,
  advancedSettingsBodyEl,
  advancedSettingsEl,
  advancedSettingsSummaryEl,
  autoToggleRoot,
  chatInputEl,
  chatMetricsSlotEl,
  chatSendBtn,
  clearBtn,
  drawerEl,
  drawerToggleBtn,
  inlineErrorEl,
  inlineErrorMessageEl,
  lengthRoot,
  lineLooseBtn,
  lineTightBtn,
  metricsEl,
  metricsHomeEl,
  modelCustomEl,
  modelPresetEl,
  modelRefreshBtn,
  modelRowEl,
  modelStatusEl,
  pickersRoot,
  refreshBtn,
  renderMarkdownHostEl,
  setupEl,
  sizeLgBtn,
  sizeSmBtn,
  slidesLayoutEl,
} = dom;

const metricsController = createMetricsController({
  metricsEl,
  metricsHomeEl,
  chatMetricsSlotEl,
});

const typographyController = createTypographyController({
  sizeSmBtn,
  sizeLgBtn,
  lineTightBtn,
  lineLooseBtn,
  defaultFontSize: defaultSettings.fontSize,
  defaultLineHeight: defaultSettings.lineHeight,
});

const panelStateStore = createPanelStateStore();
const panelState = panelStateStore.state;
const getActiveTabId = () => panelState.navigation.activeTabId;
const getActiveTabUrl = () => panelState.navigation.activeTabUrl;
const getSlidesState = () => panelState.slidesSession;
const updateSlidesState = (value: Partial<typeof panelState.slidesSession>) => {
  panelStateStore.dispatch({ type: "slides-session-update", value });
};
const getPanelSession = () => panelState.panelSession;
const updatePanelSession = (value: Partial<typeof panelState.panelSession>) => {
  panelStateStore.dispatch({ type: "panel-session-update", value });
};

const panelMessagingRuntime = createPanelMessagingRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  onMessage: (msg) => {
    handleBgMessage(msg);
  },
});
const { handleLocalSlidesResponse, resolveLocalSlides, send } = panelMessagingRuntime;

const LINE_HEIGHT_STEP = 0.1;

const appearanceControls = createAppearanceControls({
  autoToggleRoot,
  pickersRoot,
  lengthRoot,
  patchSettings,
  sendSetAuto: (checked) => {
    updatePanelSession({ autoSummarize: checked });
    void send({ type: "panel:setAuto", value: checked });
  },
  sendSetLength: (value) => {
    void send({ type: "panel:setLength", value });
  },
  applyTypography: (fontFamily, fontSize, lineHeight) => {
    typographyController.apply(fontFamily, fontSize, lineHeight);
    typographyController.setCurrentFontSize(fontSize);
    typographyController.setCurrentLineHeight(lineHeight);
  },
});

const presentationRuntime = createSidepanelPresentationRuntime({
  dom,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  appearanceControls,
  metricsController,
  resolveLocalSlides,
  send,
});
const {
  isStreaming,
  panelCacheController,
  feedback: {
    bindActions: bindFeedbackActions,
    errorController,
    headerController,
    hideSlideNotice,
    showSlideNotice,
  },
  phase: { setPhase },
  summary: { renderMarkdown, sendSummarize },
  slides: {
    applySlidesPayload,
    controlRuntime: summarizeControlRuntime,
    refreshSummarizeControl,
    renderInlineSlides,
    runtime: slidesRuntime,
    setSlidesTranscriptTimedText,
    textController: slidesTextController,
    updateSlideSummaryFromMarkdown,
    viewRuntime: slidesViewRuntime,
  },
} = presentationRuntime;
const {
  maybeApplyPendingSlidesSummary,
  maybeStartPendingSlidesForUrl,
  rememberPendingSlidesRun,
  resolveActiveSlidesRunId,
  startSlidesStreamForRunId,
  startSlidesSummaryStreamForRunId,
} = slidesRuntime;
const {
  queueSlidesRender,
  rebuildSlideDescriptions,
  renderMarkdownDisplay,
  setSlidesBusy,
  updateSlidesTextState,
} = slidesViewRuntime;
const { applySlidesLayout, setSlidesLayout } = summarizeControlRuntime;

const {
  applyPanelCache,
  bindRunActions,
  chatRuntime,
  clearCurrentView,
  navigationRuntime,
  resetPanelView,
  syncWithActiveTab,
} = createSidepanelSessionRuntime({
  dom,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  metricsController,
  presentationRuntime,
  send,
});

const { autoSummarizeRuntime, plannedSlidesRuntime, streamController, summaryRunRuntime } =
  createSidepanelRunRuntime({
    panelState,
    dispatchPanelState: panelStateStore.dispatch,
    getActiveTabId,
    getActiveTabUrl,
    appearanceControls,
    chatRuntime,
    navigationRuntime,
    metricsController,
    headerController,
    panelCacheController,
    presentationRuntime,
    send,
    syncWithActiveTab,
  });

bindRunActions({ abortSummaryStream: streamController.abort });

registerSidepanelTestHooks({
  applySlidesPayload,
  getRunId: () => panelState.runId,
  getSummaryMarkdown: () => panelState.summaryMarkdown ?? "",
  getRetainedSlideSummaryMarkdown: () => selectRetainedSlideSummaryMarkdown(panelState) ?? "",
  getSlideDescriptions: () => slidesTextController.getDescriptionEntries(),
  getSlideSummaryEntries: () => slidesTextController.getSummaryEntries(),
  getSlideTitleEntries: () => Array.from(slidesTextController.getTitles().entries()),
  getPhase: () => panelState.phase,
  getModel: () => panelState.lastMeta.model ?? null,
  getSlidesTimeline: () =>
    panelState.slides?.slides.map((slide) => ({
      index: slide.index,
      timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : null,
    })) ?? [],
  getTranscriptTimedText: () => slidesTextController.getTranscriptTimedText(),
  getSlidesSummaryMarkdown: () => panelState.slidesSummary.markdown,
  getSlidesSummaryComplete: () => panelState.slidesSummary.complete,
  getSlidesSummaryModel: () => panelState.slidesSummary.model,
  getChatEnabled: () => getPanelSession().chatEnabled,
  getSettingsHydrated: () => getPanelSession().settingsHydrated,
  setTranscriptTimedText: (value) => {
    setSlidesTranscriptTimedText(value);
    updateSlidesTextState();
  },
  setSummarizeMode: async (payload) => {
    await summarizeControlRuntime.handleSummarizeControlChange(payload);
    refreshSummarizeControl();
  },
  getSummarizeMode: () => ({
    mode: resolveSlidesInputMode(getSlidesState()),
    slides: getSlidesState().slidesEnabled,
    mediaAvailable: getSlidesState().mediaAvailable,
  }),
  getSlidesState: () => ({
    slidesCount: panelState.slides?.slides.length ?? 0,
    layout: getSlidesState().slidesLayout,
    hasSlides: Boolean(panelState.slides),
  }),
  renderSlidesNow: () => {
    queueSlidesRender();
  },
  applyUiState: (state) => {
    panelStateStore.dispatch({ type: "ui", ui: state });
    updateControls(state);
  },
  applyBgMessage: (message) => {
    handleBgMessage(message);
  },
  applySummarySnapshot: (payload) => {
    summaryRunRuntime.applySnapshot(payload);
  },
  applySummaryMarkdown: (markdown) => {
    renderMarkdown(markdown);
    setPhase("idle");
  },
  applySlidesSummaryMarkdown: (markdown) => {
    updateSlideSummaryFromMarkdown(markdown, {
      preserveIfEmpty: true,
      source: "slides-partial",
    });
    setPhase("idle");
  },
  forceRenderSlides: () => {
    updateSlidesState({
      slidesEnabled: true,
      inputMode: "video",
      inputModeOverride: "video",
    });
    return slidesViewRuntime.slidesRenderer.forceRender();
  },
  showInlineError: (message) => {
    errorController.showInlineError(message);
  },
  isInlineErrorVisible: () => !inlineErrorEl.classList.contains("hidden"),
  getInlineErrorMessage: () => inlineErrorMessageEl.textContent ?? "",
});

const setupControlsRuntime = createSetupControlsRuntime({
  advancedSettingsBodyEl,
  advancedSettingsEl,
  defaultModel: defaultSettings.model,
  drawerEl,
  drawerToggleBtn,
  friendlyFetchError,
  generateToken,
  getStatusResetText: () => panelState.ui?.status ?? "",
  headerSetStatus: (text) => {
    headerController.setStatus(text);
  },
  loadSettings,
  modelCustomEl,
  modelPresetEl,
  modelRefreshBtn,
  modelRowEl,
  modelStatusEl,
  patchSettings,
  setupEl,
});
const {
  drawerControls,
  isRefreshFreeRunning,
  maybeShowSetup,
  readCurrentModelValue,
  refreshModelsIfStale,
  runRefreshFree,
  setDefaultModelPresets,
  setModelPlaceholderFromDiscovery,
  setModelValue,
  updateModelRowUI,
} = setupControlsRuntime;

const uiStateRuntime = createUiStateRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  appearanceControls,
  typographyController,
  navigationRuntime,
  panelCacheController,
  headerController,
  clearInlineError: () => {
    errorController.clearInlineError();
  },
  requestAgentAbort: chatRuntime.requestAbort,
  clearChatHistoryForActiveTab: chatRuntime.clearHistoryForActiveTab,
  migrateChatHistory: chatRuntime.migrateHistory,
  maybeStartPendingSummaryRunForUrl: summaryRunRuntime.maybeStartPendingForUrl,
  maybeStartPendingSlidesForUrl,
  requestSlidesCapture: () => {
    void send({ type: "panel:slides-capture" });
  },
  resolveActiveSlidesRunId,
  applyPanelCache,
  resetSummaryView: resetPanelView,
  abortSummaryStream: () => {
    streamController.abort();
  },
  hideAutomationNotice: chatRuntime.hideAutomationNotice,
  hideSlideNotice,
  maybeApplyPendingSlidesSummary,
  applyChatEnabled: chatRuntime.applyEnabled,
  restoreChatHistory: chatRuntime.restoreHistory,
  rebuildSlideDescriptions,
  renderInlineSlides,
  setSlidesLayout: (value) => {
    setSlidesLayout(value as SlidesLayout);
  },
  maybeSeedPlannedSlidesForPendingRun: plannedSlidesRuntime.maybeSeedPendingRun,
  refreshSummarizeControl,
  maybeShowSetup,
  setPhase,
  renderMarkdownDisplay,
  readCurrentModelValue,
  setModelValue,
  updateModelRowUI,
  isRefreshFreeRunning,
  setModelRefreshDisabled: (value) => {
    modelRefreshBtn.disabled = value;
  },
  renderMarkdownHostEl,
  isStreaming,
  onSlidesOcrChanged: updateSlidesTextState,
});

function updateControls(state: UiState) {
  uiStateRuntime.apply(state);
}

const bgMessageRuntime = createSidepanelBgMessageRuntime({
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  applyUiState: updateControls,
  setStatus: (text) => {
    headerController.setStatus(text);
  },
  isStreaming,
  setPhase,
  finishStreamingMessage: chatRuntime.finishStreamingMessage,
  setSlidesBusy,
  showSlideNotice,
  getActiveTabUrl,
  rememberPendingSlidesRun: (value) => {
    rememberPendingSlidesRun(value);
  },
  startSlidesStreamForRunId,
  startSlidesSummaryStreamForRunId: (runId, url) => {
    startSlidesSummaryStreamForRunId(runId, url ?? null);
  },
  handleSlidesLocal: handleLocalSlidesResponse,
  getSlidesContextRequestId: () => getSlidesState().slidesContextRequestId,
  setSlidesContextPending: (value) => {
    updateSlidesState({ slidesContextPending: value });
  },
  setSlidesTranscriptTimedText,
  updateSlidesTextState,
  updateSlideSummaryFromMarkdown,
  renderInlineSlidesFallback: () => {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true });
  },
  schedulePanelCacheSync: () => {
    panelCacheController.scheduleSync();
  },
  consumeUiCache: (cacheMessage) => panelCacheController.consumeResponse(cacheMessage),
  clearPanelCache: () => {
    panelCacheController.clear();
  },
  getActiveTabId,
  applyPanelCache: (cache, opts) => {
    applyPanelCache(cache as PanelCachePayload, opts);
  },
  rememberPendingSummaryRun: (run) => {
    summaryRunRuntime.rememberPendingRun(run);
  },
  rememberPendingSummarySnapshot: (payload) => {
    summaryRunRuntime.rememberPendingSnapshot(payload);
  },
  attachSummaryRun: summaryRunRuntime.attachRun,
  applySummarySnapshot: (payload) => {
    summaryRunRuntime.applySnapshot(payload);
  },
  handleChatHistory: chatRuntime.handleHistory,
  handleAgentChunk: chatRuntime.handleAgentChunk,
  handleAgentResponse: chatRuntime.handleAgentResponse,
});

function handleBgMessage(msg: BgToPanel) {
  bgMessageRuntime.handle(msg);
}

const interactionRuntime = createSidepanelInteractionRuntime({
  chatEnabled: () => getPanelSession().chatEnabled,
  getRawChatInput: () => chatInputEl.value,
  clearChatInput: () => {
    chatInputEl.value = "";
    chatInputEl.style.height = "auto";
  },
  restoreChatInput: (value) => {
    chatInputEl.value = value;
  },
  getChatInputScrollHeight: () => chatInputEl.scrollHeight,
  setChatInputHeight: (value) => {
    chatInputEl.style.height = value;
  },
  isChatStreaming: () => panelState.chat.streaming,
  getQueuedChatCount: chatRuntime.getQueueLength,
  enqueueChatMessage: chatRuntime.enqueueMessage,
  maybeSendQueuedChat: chatRuntime.maybeSendQueuedMessage,
  startChatMessage: chatRuntime.startMessage,
  typographyController,
  patchSettings,
  updateModelRowUI,
  isCustomModelHidden: () => modelCustomEl.hidden,
  focusCustomModel: () => {
    modelCustomEl.focus();
  },
  blurCustomModel: () => {
    modelCustomEl.blur();
  },
  readCurrentModelValue,
});
const { sendChatMessage, bumpFontSize, bumpLineHeight, persistCurrentModel } = interactionRuntime;

function retryLastAction() {
  if (getPanelSession().lastAction === "chat") {
    chatRuntime.retry();
    return;
  }
  sendSummarize({ refresh: true });
}

bindFeedbackActions(retryLastAction);

bindSidepanelUiEvents({
  refreshBtn,
  clearBtn,
  drawerToggleBtn,
  advancedBtn,
  advancedSettingsSummaryEl,
  chatSendBtn,
  chatInputEl,
  sizeSmBtn,
  sizeLgBtn,
  lineTightBtn,
  lineLooseBtn,
  modelPresetEl,
  modelCustomEl,
  slidesLayoutEl,
  modelRefreshBtn,
  advancedSettingsEl,
  lineHeightStep: LINE_HEIGHT_STEP,
  sendSummarize,
  clearCurrentView,
  toggleDrawer: () => drawerControls.toggleDrawer(),
  openOptions: () => send({ type: "panel:openOptions" }),
  toggleAdvancedSettings: drawerControls.toggleAdvancedSettings,
  sendChatMessage,
  bumpFontSize,
  bumpLineHeight,
  persistCurrentModel,
  setSlidesLayout: (next) => {
    setSlidesLayout(next);
    void (async () => {
      await patchSettings({ slidesLayout: next });
    })();
  },
  refreshModelsIfStale: () => {
    if (drawerControls.hasAdvancedSettingsAnimation() && advancedSettingsEl.open) return;
    refreshModelsIfStale();
  },
  runRefreshFree,
});

bootstrapSidepanel({
  ensurePanelPort: () => panelMessagingRuntime.ensure(),
  loadSettings,
  panelState,
  dispatchPanelState: panelStateStore.dispatch,
  typographyController,
  setSlidesLayoutInputValue: (value) => {
    slidesLayoutEl.value = value;
  },
  hideAutomationNotice: chatRuntime.hideAutomationNotice,
  appearanceControls,
  applyChatEnabled: chatRuntime.applyEnabled,
  applySlidesLayout,
  setDefaultModelPresets,
  setModelValue,
  setModelPlaceholderFromDiscovery,
  updateModelRowUI,
  setModelRefreshDisabled: (value) => {
    modelRefreshBtn.disabled = value;
  },
  toggleDrawerClosed: () => {
    drawerControls.toggleDrawer(false, { animate: false });
  },
  renderMarkdownDisplay,
  sendReady: () => {
    void send({ type: "panel:ready" });
  },
  scheduleAutoSummarize: autoSummarizeRuntime.schedule,
  sendPing: () => {
    void send({ type: "panel:ping" });
  },
  bindSidepanelLifecycle: {
    sendReady: () => {
      void send({ type: "panel:ready" });
    },
    sendClosed: () => {
      autoSummarizeRuntime.cancel();
      void send({ type: "panel:closed" });
    },
    scheduleAutoSummarize: autoSummarizeRuntime.schedule,
    syncWithActiveTab,
    clearInlineError: () => {
      errorController.clearInlineError();
    },
    sendSummarize,
  },
});
