let activeTabId = null;
let pageState = null;
let autoRefreshTimer = null;

const elements = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  await refresh();
  startAutoRefresh();
}

function cacheElements() {
  elements.pageStatus = document.getElementById("page-status");
  elements.refresh = document.getElementById("refresh");
  elements.readerState = document.getElementById("reader-state");
  elements.readerModel = document.getElementById("reader-model");
  elements.sourceUrl = document.getElementById("source-url");
  elements.copySource = document.getElementById("copy-source");
  elements.loadedSize = document.getElementById("loaded-size");
  elements.workerState = document.getElementById("worker-state");
  elements.sceneStats = document.getElementById("scene-stats");
  elements.taskState = document.getElementById("task-state");
  elements.taskMeta = document.getElementById("task-meta");
  elements.openStudio = document.getElementById("open-studio");
  elements.saveLoaded = document.getElementById("save-loaded");
  elements.status = document.getElementById("status");
}

function bindEvents() {
  elements.refresh.addEventListener("click", () => refresh());
  elements.copySource.addEventListener("click", copySourceLink);
  elements.openStudio.addEventListener("click", openExportStudio);
  elements.saveLoaded.addEventListener("click", saveLoadedModel);
}

async function refresh(options = {}) {
  const silent = options.silent === true;
  if (!silent) {
    setBusy(true);
    setStatus("Refreshing page state...");
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    if (!activeTabId) {
      throw new Error("No active tab.");
    }

    const response = await sendTabMessage(activeTabId, { type: "REFRESH_PAGE_STATE" });
    if (!response?.ok) {
      throw new Error(response?.error || "Meshy content script is not available on this page.");
    }

    pageState = response.state || {};
    if (!pageState.currentTask) {
      await loadRecentTasksFallback();
    }

    renderState();
    if (!silent) {
      setStatus("");
    }
  } catch (error) {
    renderState();
    if (!silent) {
      setStatus(error.message || String(error), true);
    }
  } finally {
    if (!silent) {
      setBusy(false);
    }
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) {
    window.clearInterval(autoRefreshTimer);
  }
  autoRefreshTimer = window.setInterval(() => refresh({ silent: true }), 2500);
}

async function loadRecentTasksFallback() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_RECENT_TASKS",
      payload: { pageSize: 20 }
    });

    if (!response?.ok || !response.tasks?.length) {
      return;
    }

    pageState = {
      ...(pageState || {}),
      currentTask: response.tasks[0],
      tasks: response.tasks
    };
  } catch {
    // Optional context only.
  }
}

async function openExportStudio() {
  if (!activeTabId) {
    setStatus("No active Meshy tab.", true);
    return;
  }

  const model = pageState?.latestLoadedModel;
  if (!model?.objectUrl) {
    setStatus("No captured GLB is available yet.", true);
    return;
  }

  setBusy(true);
  setStatus("Preparing Export Studio model transfer...");

  let sessionId = "";
  try {
    const prepared = await chrome.runtime.sendMessage({
      type: "PREPARE_EXPORT_SESSION",
      payload: {
        sourceTabId: activeTabId,
        modelId: model.id || ""
      }
    });

    if (!prepared?.ok || !prepared.session?.id) {
      throw new Error(prepared?.error || "Could not prepare the captured model for Export Studio.");
    }

    sessionId = prepared.session.id;
  } catch (error) {
    setStatus(renderExportPreparationError(error), true);
    setBusy(false);
    return;
  }

  const url = chrome.runtime.getURL(
    `export.html?sessionId=${encodeURIComponent(sessionId)}&sourceTabId=${encodeURIComponent(activeTabId)}&modelId=${encodeURIComponent(model.id || "")}`
  );

  try {
    await chrome.windows.create({
      url,
      type: "popup",
      width: 1180,
      height: 820,
      focused: true
    });
  } catch {
    await chrome.tabs.create({ url });
  } finally {
    setStatus("");
    setBusy(false);
  }
}

async function saveLoadedModel() {
  if (!activeTabId) {
    setStatus("No active Meshy tab.", true);
    return;
  }

  const model = pageState?.latestLoadedModel;
  if (!model?.objectUrl) {
    setStatus("No decrypted loaded GLB is available yet.", true);
    return;
  }

  setBusy(true);
  setStatus("Starting loaded GLB download...");

  try {
    const response = await sendTabMessage(activeTabId, {
      type: "SAVE_LOADED_MODEL",
      payload: {
        filename: model.filename
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Loaded model download failed.");
    }

    pageState = response.state || pageState;
    renderState();
    setStatus(`Download started: ${response.filename}`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

function renderState() {
  const task = pageState?.currentTask || null;
  const request = pageState?.latestRequest || null;
  const model = pageState?.latestLoadedModel || null;
  const scene = pageState?.latestSceneRoot || null;
  const worker = pageState?.latestWorkerEvent || null;

  elements.pageStatus.textContent = pageState?.pageHookReady
    ? "Connected to Meshy loader"
    : "Open a Meshy viewer page";

  renderModelState(task, request, model, scene, worker);
  renderTaskState(task);

  const hasLoadedModel = Boolean(model?.objectUrl);
  elements.openStudio.disabled = !hasLoadedModel;
  elements.saveLoaded.disabled = !hasLoadedModel;
  elements.openStudio.textContent = hasLoadedModel ? "Open Export Studio" : "Waiting for GLB";
  elements.saveLoaded.textContent = hasLoadedModel ? "Quick Save GLB" : "Quick Save GLB";
  elements.copySource.disabled = !elements.sourceUrl.value;
}

function renderModelState(task, request, model, scene, worker) {
  const sourceUrl = model?.encryptedUrl || request?.url || worker?.encryptedUrl || task?.modelUrl || "";
  elements.sourceUrl.value = sourceUrl;

  if (model?.objectUrl) {
    const label = model.kind === "gltf" ? "GLTF" : "GLB";
    elements.readerState.textContent = `${label} ready`;
    elements.readerModel.textContent = [
      model.taskName || task?.name || model.filename || "Meshy model",
      model.source ? `captured from ${model.source}` : "",
      model.mode ? `mode ${model.mode}` : ""
    ].filter(Boolean).join(" - ");
    elements.loadedSize.textContent = formatBytes(model.size);
  } else if (scene) {
    elements.readerState.textContent = "Scene hooked";
    elements.readerModel.textContent = "Viewport root was detected. Waiting for decrypted GLB from the loader worker.";
    elements.loadedSize.textContent = "-";
  } else if (worker?.event) {
    elements.readerState.textContent = worker.event === "process-success" ? "Checking GLB" : "Worker seen";
    elements.readerModel.textContent = renderWorkerMessage(worker);
    elements.loadedSize.textContent = worker.outputBytes ? formatBytes(worker.outputBytes) : "-";
  } else if (request?.url) {
    elements.readerState.textContent = request.stage === "decrypt-request" ? "Decrypting" : "Loading";
    elements.readerModel.textContent = "Encrypted model.meshy was requested. Keep the viewer open until decrypt finishes.";
    elements.loadedSize.textContent = request.inputBytes ? formatBytes(request.inputBytes) : "-";
  } else if (task?.modelUrl) {
    elements.readerState.textContent = "Task found";
    elements.readerModel.textContent = "Open the model in the viewer to trigger model.meshy loading.";
    elements.loadedSize.textContent = "-";
  } else {
    elements.readerState.textContent = "Waiting";
    elements.readerModel.textContent = "No model.meshy request has been seen yet.";
    elements.loadedSize.textContent = "-";
  }

  if (scene) {
    const sceneText = [
      scene.meshCount ? `${formatNumber(scene.meshCount)} meshes` : "",
      scene.triangleCount ? `${formatNumber(scene.triangleCount)} tris` : ""
    ].filter(Boolean).join(" / ") || "-";
    elements.sceneStats.textContent = `Scene: ${sceneText}`;
  } else {
    elements.sceneStats.textContent = "Scene not detected.";
  }

  elements.workerState.textContent = renderWorkerState(worker);
}

function renderWorkerState(worker) {
  if (!worker?.event) {
    return "-";
  }

  if (worker.event === "process-success") {
    return worker.outputBytes ? formatBytes(worker.outputBytes) : "success";
  }

  if (worker.event === "process-request") {
    return worker.inputBytes ? formatBytes(worker.inputBytes) : "request";
  }

  if (worker.event === "instrumented") {
    return worker.isDecryptWorker ? "hooked" : "seen";
  }

  if (worker.event === "process-error") {
    return "error";
  }

  return worker.event;
}

function renderWorkerMessage(worker) {
  if (worker.event === "instrumented") {
    return worker.isDecryptWorker
      ? "Decrypt worker is hooked. Open or reload the model to trigger a process event."
      : "A worker is hooked. Waiting for model decrypt activity.";
  }

  if (worker.event === "process-request") {
    return "Worker received a process request. Waiting for decrypted GLB response.";
  }

  if (worker.event === "process-success") {
    return "Worker returned data. Checking whether it is a GLB payload.";
  }

  if (worker.event === "process-error") {
    return worker.error || "Worker process returned an error.";
  }

  return "Worker activity was detected.";
}

function renderTaskState(task) {
  if (!task?.id) {
    elements.taskState.textContent = "Unknown";
    elements.taskMeta.textContent = "No task detected yet.";
    return;
  }

  elements.taskState.textContent = task.status || "Task";
  const counts = [
    task.triangleCount ? `${formatNumber(task.triangleCount)} tris` : "",
    task.vertexCount ? `${formatNumber(task.vertexCount)} verts` : ""
  ].filter(Boolean).join(" / ");
  elements.taskMeta.textContent = [
    task.name || "Meshy model",
    task.phase || "",
    task.id,
    counts
  ].filter(Boolean).join(" - ");
}

function setBusy(isBusy) {
  elements.refresh.disabled = isBusy;
  elements.openStudio.disabled = isBusy || !pageState?.latestLoadedModel?.objectUrl;
  elements.saveLoaded.disabled = isBusy || !pageState?.latestLoadedModel?.objectUrl;
  elements.copySource.disabled = isBusy || !elements.sourceUrl.value;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", Boolean(isError));
}

function renderExportPreparationError(error) {
  const message = error?.message || String(error || "");
  if (message.includes("No captured loaded model")) {
    return "Captured model buffer is gone. Reload the Meshy model, wait for GLB ready, then open Export Studio again.";
  }
  return message || "Could not prepare Export Studio.";
}

async function copySourceLink() {
  const url = elements.sourceUrl.value.trim();
  if (!url) {
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    setStatus("Source link copied.");
  } catch {
    elements.sourceUrl.select();
    document.execCommand("copy");
    setStatus("Source link copied.");
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response);
    });
  }).then(async (response) => {
    if (response?.ok !== false || !isMissingReceivingEnd(response.error)) {
      return response;
    }

    const injected = await injectContentScript(tabId);
    if (!injected.ok) {
      return injected;
    }

    await delay(150);
    return sendTabMessageOnce(tabId, message);
  });
}

function sendTabMessageOnce(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response);
    });
  });
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function isMissingReceivingEnd(message) {
  return String(message || "").includes("Receiving end does not exist");
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
