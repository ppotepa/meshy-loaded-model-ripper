(function installMeshyLoadedModelRipperContentScript() {
  const INSTALL_KEY = "__MESHY_LOADED_MODEL_RIPPER_CONTENT_0_3_0__";
  if (globalThis[INSTALL_KEY]) {
    return;
  }
  globalThis[INSTALL_KEY] = true;

  const PAGE_SOURCE = "MESHY_LOADED_MODEL_RIPPER_PAGE";
  const EXTENSION_SOURCE = "MESHY_LOADED_MODEL_RIPPER_EXTENSION";
  const AUTO_REFRESH_INTERVAL_MS = 2000;
  const TRACK_DEBOUNCE_MS = 1500;

  const state = {
    pageHookReady: false,
    currentTask: null,
    tasks: [],
    latestRequest: null,
    latestLoadedModel: null,
    latestSceneRoot: null,
    latestWorkerEvent: null,
    modelRequests: [],
    loadedModels: [],
    sceneRoots: [],
    workerEvents: [],
    lastError: ""
  };

  const pendingPageRequests = new Map();
  let extensionContextAlive = true;
  let lastTrackedTaskId = "";
  let lastTrackedAt = 0;

  init();

  function init() {
    ensurePageHook();
    window.addEventListener("message", handleWindowMessage);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    window.setInterval(() => {
      if (!extensionContextAlive) {
        return;
      }
      refreshPageState({ soft: true });
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  function handleRuntimeMessage(message, sender, sendResponse) {
    runRuntimeAction(message)
      .then((result) => safeSendResponse(sendResponse, { ok: true, ...result }))
      .catch((error) => safeSendResponse(sendResponse, { ok: false, error: error.message || String(error) }));

    return true;
  }

  async function runRuntimeAction(message) {
    switch (message?.type) {
      case "GET_PAGE_STATE":
      case "REFRESH_PAGE_STATE":
        await ensurePageHook();
        await refreshPageState({ soft: true });
        return { state: getSerializableState() };
      case "SAVE_LOADED_MODEL":
        return saveLoadedModel(message.payload || {});
      case "GET_CAPTURED_MODEL_META":
        return getCapturedModelMeta(message.payload || {});
      case "GET_CAPTURED_MODEL_CHUNK":
        return getCapturedModelChunk(message.payload || {});
      case "TASK_STATUS_UPDATED":
        mergeTasks([normalizeTask(message.task)].filter(Boolean));
        return { state: getSerializableState() };
      default:
        throw new Error(`Unknown content message: ${message?.type || "missing"}`);
    }
  }

  async function ensurePageHook() {
    if (!extensionContextAlive) {
      return;
    }

    try {
      const response = await safeRuntimeSendMessage({ type: "INJECT_PAGE_HOOK" });
      if (response?.ok === false) {
        state.lastError = response.error || "Could not inject page hook.";
      }
    } catch (error) {
      markExtensionContextError(error);
    }
  }

  function handleVisibilityChange() {
    if (!document.hidden) {
      ensurePageHook();
      refreshPageState({ soft: true });
    }
  }

  function handleWindowMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.source !== PAGE_SOURCE) {
      return;
    }

    if (data.requestId && pendingPageRequests.has(data.requestId)) {
      const pending = pendingPageRequests.get(data.requestId);
      pendingPageRequests.delete(data.requestId);
      window.clearTimeout(pending.timeout);
      data.ok ? pending.resolve(data) : pending.reject(new Error(data.error || "Page hook request failed."));
      return;
    }

    switch (data.type) {
      case "HOOK_READY":
        state.pageHookReady = true;
        break;
      case "RIPPER_STATE":
        mergePageState(data.state);
        break;
      case "TASKS":
        mergeTasks((data.tasks || []).map(normalizeTask).filter(Boolean));
        break;
      case "MODEL_REQUEST":
        state.latestRequest = normalizeModelRequest(data.request);
        break;
      case "LOADED_MODEL":
        state.latestLoadedModel = normalizeLoadedModel(data.model);
        break;
      case "SCENE_ROOT":
        state.latestSceneRoot = normalizeSceneRoot(data.sceneRoot);
        break;
      case "WORKER_EVENT":
        state.latestWorkerEvent = normalizeWorkerEvent(data.event);
        break;
      default:
        break;
    }

    trackCurrentTask();
  }

  async function refreshPageState({ soft = false } = {}) {
    try {
      const response = await requestPageHook("GET_RIPPER_STATE", {}, soft ? 1200 : 5000);
      mergePageState(response.state);
      trackCurrentTask();
    } catch (error) {
      if (!soft) {
        throw error;
      }
    }
  }

  async function saveLoadedModel(payload = {}) {
    await refreshPageState({ soft: true });

    if (!state.latestLoadedModel?.objectUrl) {
      throw new Error("No decrypted loaded GLB is available yet. Open the Meshy viewer and wait for the model to finish loading.");
    }

    const task = state.currentTask || {};
    const model = state.latestLoadedModel;
    const filename = sanitizeFilename(
      payload.filename ||
      model.filename ||
      `${task.name || model.taskId || "meshy-loaded-model"}.${model.kind === "gltf" ? "gltf" : "glb"}`
    );

    const response = await requestPageHook("DOWNLOAD_LATEST_LOADED_MODEL", { filename }, 5000);
    if (!response?.filename) {
      throw new Error("The page hook did not start the loaded model download.");
    }

    return {
      state: getSerializableState(),
      filename: response.filename,
      model: normalizeLoadedModel(response.model)
    };
  }

  async function getCapturedModelMeta(payload = {}) {
    await ensurePageHook();
    await refreshPageState({ soft: true });
    const response = await requestPageHook("GET_CAPTURED_MODEL_META", payload, 5000);
    return {
      state: getSerializableState(),
      model: normalizeLoadedModel(response.model)
    };
  }

  async function getCapturedModelChunk(payload = {}) {
    await ensurePageHook();
    const response = await requestPageHook("GET_CAPTURED_MODEL_CHUNK", payload, 30000);
    return {
      state: getSerializableState(),
      chunk: response.chunk
    };
  }

  function requestPageHook(type, payload = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeout = window.setTimeout(() => {
        pendingPageRequests.delete(requestId);
        reject(new Error("Timed out waiting for the page hook."));
      }, timeoutMs);

      pendingPageRequests.set(requestId, { resolve, reject, timeout });
      window.postMessage({
        source: EXTENSION_SOURCE,
        type,
        requestId,
        payload
      }, window.location.origin);
    });
  }

  function mergePageState(nextState) {
    if (!nextState || typeof nextState !== "object") {
      return;
    }

    state.pageHookReady = nextState.hookReady === true || state.pageHookReady;
    state.currentTask = normalizeTask(nextState.currentTask) || state.currentTask;
    state.latestRequest = normalizeModelRequest(nextState.latestRequest) || state.latestRequest;
    state.latestLoadedModel = normalizeLoadedModel(nextState.latestLoadedModel) || state.latestLoadedModel;
    state.latestSceneRoot = normalizeSceneRoot(nextState.latestSceneRoot) || state.latestSceneRoot;
    state.latestWorkerEvent = normalizeWorkerEvent(nextState.latestWorkerEvent) || state.latestWorkerEvent;
    state.modelRequests = Array.isArray(nextState.modelRequests)
      ? nextState.modelRequests.map(normalizeModelRequest).filter(Boolean)
      : state.modelRequests;
    state.loadedModels = Array.isArray(nextState.loadedModels)
      ? nextState.loadedModels.map(normalizeLoadedModel).filter(Boolean)
      : state.loadedModels;
    state.sceneRoots = Array.isArray(nextState.sceneRoots)
      ? nextState.sceneRoots.map(normalizeSceneRoot).filter(Boolean)
      : state.sceneRoots;
    state.workerEvents = Array.isArray(nextState.workerEvents)
      ? nextState.workerEvents.map(normalizeWorkerEvent).filter(Boolean)
      : state.workerEvents;

    if (Array.isArray(nextState.tasks)) {
      mergeTasks(nextState.tasks.map(normalizeTask).filter(Boolean));
    }
  }

  function mergeTasks(tasks) {
    if (!tasks.length) {
      return;
    }

    const byId = new Map(state.tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      byId.set(task.id, {
        ...byId.get(task.id),
        ...task,
        seenAt: Date.now()
      });
    }

    state.tasks = [...byId.values()].sort((a, b) => scoreTask(b) - scoreTask(a)).slice(0, 30);
    state.currentTask = chooseCurrentTask();
  }

  function chooseCurrentTask() {
    const loadedTaskId = state.latestLoadedModel?.taskId;
    const requestTaskId = state.latestRequest?.taskId;
    const wantedId = loadedTaskId || requestTaskId || state.currentTask?.id || "";
    if (wantedId) {
      const matching = state.tasks.find((task) => task.id === wantedId);
      if (matching) {
        return matching;
      }
    }

    return state.tasks[0] || state.currentTask || null;
  }

  function trackCurrentTask() {
    const task = state.currentTask;
    if (!task?.id || !extensionContextAlive) {
      return;
    }

    const now = Date.now();
    if (task.id === lastTrackedTaskId && now - lastTrackedAt < TRACK_DEBOUNCE_MS) {
      return;
    }

    lastTrackedTaskId = task.id;
    lastTrackedAt = now;
    safeRuntimeSendMessage({
      type: "TRACK_TASK",
      payload: { task }
    });
  }

  function getSerializableState() {
    return {
      pageUrl: window.location.href,
      pageHookReady: state.pageHookReady,
      currentTask: state.currentTask,
      tasks: state.tasks,
      latestRequest: state.latestRequest,
      latestLoadedModel: state.latestLoadedModel,
      latestSceneRoot: state.latestSceneRoot,
      latestWorkerEvent: state.latestWorkerEvent,
      modelRequests: state.modelRequests,
      loadedModels: state.loadedModels,
      sceneRoots: state.sceneRoots,
      workerEvents: state.workerEvents,
      lastError: state.lastError
    };
  }

  function normalizeTask(raw) {
    if (!raw || typeof raw !== "object" || !(raw.id || raw.taskId)) {
      return null;
    }

    const texture = raw.result?.texture || raw.texture || null;
    const generate = raw.result?.generate || raw.generate || null;
    const modelUrl = texture?.modelUrl || generate?.modelUrl || raw.modelUrl || "";
    const taskId = raw.taskId || raw.id || "";

    return {
      id: taskId,
      taskId,
      name: raw.name || "Meshy model",
      status: raw.status || "",
      phase: raw.phase || "",
      modelUrl,
      textureUrls: texture?.textureUrls || raw.textureUrls || [],
      triangleCount: raw.triangleCount || 0,
      vertexCount: raw.vertexCount || 0,
      updatedAt: raw.updatedAt || raw.createdAt || 0,
      seenAt: raw.seenAt || Date.now()
    };
  }

  function normalizeModelRequest(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    return {
      url: raw.url || "",
      source: raw.source || "",
      stage: raw.stage || "",
      mode: raw.mode || "",
      inputBytes: raw.inputBytes || 0,
      taskId: raw.taskId || extractTaskId(raw.url),
      detectedAt: raw.detectedAt || Date.now()
    };
  }

  function normalizeLoadedModel(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const kind = raw.kind === "gltf" ? "gltf" : "glb";
    return {
      id: raw.id || "",
      kind,
      filename: raw.filename || `meshy-loaded-model.${kind}`,
      mimeType: raw.mimeType || (kind === "gltf" ? "model/gltf+json" : "model/gltf-binary"),
      size: raw.size || 0,
      objectUrl: raw.objectUrl || "",
      encryptedUrl: raw.encryptedUrl || "",
      sourceUrl: raw.sourceUrl || "",
      taskId: raw.taskId || extractTaskId(raw.encryptedUrl || raw.sourceUrl),
      taskName: raw.taskName || "",
      mode: raw.mode || "",
      source: raw.source || "",
      detectedAt: raw.detectedAt || Date.now(),
      expiresAt: raw.expiresAt || 0
    };
  }

  function normalizeSceneRoot(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    return {
      source: raw.source || "",
      url: raw.url || "",
      name: raw.name || "",
      triangleCount: raw.triangleCount || 0,
      vertexCount: raw.vertexCount || 0,
      meshCount: raw.meshCount || 0,
      detectedAt: raw.detectedAt || Date.now()
    };
  }

  function normalizeWorkerEvent(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    return {
      source: raw.source || "",
      scriptURL: raw.scriptURL || "",
      isDecryptWorker: raw.isDecryptWorker === true,
      event: raw.event || "",
      id: raw.id || "",
      mode: raw.mode || "",
      inputBytes: raw.inputBytes || 0,
      outputBytes: raw.outputBytes || 0,
      encryptedUrl: raw.encryptedUrl || "",
      error: raw.error || "",
      detectedAt: raw.detectedAt || Date.now()
    };
  }

  function scoreTask(task) {
    let score = Number(task.updatedAt || task.seenAt || 0) / 1000;
    if (task.modelUrl) score += 100000000;
    if (String(task.status).toUpperCase() === "SUCCEEDED") score += 10000000;
    if (task.phase === "texture") score += 1000000;
    if (task.phase === "generate") score += 500000;
    return score;
  }

  function safeRuntimeSendMessage(message) {
    if (!extensionContextAlive || !hasRuntimeContext()) {
      return Promise.resolve({ ok: false, error: "Extension context invalidated." });
    }

    try {
      return chrome.runtime.sendMessage(message).catch((error) => {
        markExtensionContextError(error);
        return { ok: false, error: error?.message || String(error) };
      });
    } catch (error) {
      markExtensionContextError(error);
      return Promise.resolve({ ok: false, error: error?.message || String(error) });
    }
  }

  function safeSendResponse(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch (error) {
      markExtensionContextError(error);
    }
  }

  function markExtensionContextError(error) {
    const message = error?.message || String(error || "");
    if (message.includes("Extension context invalidated") || !hasRuntimeContext()) {
      extensionContextAlive = false;
      state.lastError = "Extension context invalidated. Reload this Meshy tab after reloading the extension.";
    }
  }

  function hasRuntimeContext() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  }

  function extractTaskId(url) {
    const match = String(url || "").match(/\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
    return match?.[1] || "";
  }

  function sanitizeFilename(filename) {
    return String(filename || "meshy-loaded-model.glb")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "meshy-loaded-model.glb";
  }
})();
