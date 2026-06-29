const API_BASE = "https://api.meshy.ai/web";
const TASKS_V2 = "/v2/tasks";
const TRACKED_TASKS_STORAGE_KEY = "trackedTasks";
const TASK_POLL_ALARM_NAME = "pollTrackedMeshyTasks";
const TASK_POLL_PERIOD_MINUTES = 1;
const MAX_TRACKED_TASKS = 40;
const EXPORT_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_EXPORT_SESSIONS = 4;
const EXPORT_SESSION_CHUNK_SIZE = 512 * 1024;
const TASK_TABS = [
  "https://*.meshy.ai/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
];

const exportSessions = new Map();

ensureTaskPollAlarm();

chrome.runtime.onInstalled?.addListener(ensureTaskPollAlarm);
chrome.runtime.onStartup?.addListener(ensureTaskPollAlarm);

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === TASK_POLL_ALARM_NAME) {
    pollTrackedTasks().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "INJECT_PAGE_HOOK":
      return injectPageHook(sender);
    case "GET_RECENT_TASKS":
      return getRecentTasks(message.payload);
    case "GET_TASK_STATUS":
      return getTaskStatus(message.payload);
    case "TRACK_TASK":
      return trackTask(message.payload, sender);
    case "GET_TRACKED_TASKS":
      return getTrackedTasks();
    case "PREPARE_EXPORT_SESSION":
      return prepareExportSession(message.payload);
    case "GET_EXPORT_SESSION_CHUNK":
      return getExportSessionChunk(message.payload);
    case "GET_CAPTURED_MODEL_META":
      return relayCapturedModelRequest("GET_CAPTURED_MODEL_META", message.payload);
    case "GET_CAPTURED_MODEL_CHUNK":
      return relayCapturedModelRequest("GET_CAPTURED_MODEL_CHUNK", message.payload);
    default:
      throw new Error(`Unknown message type: ${message?.type || "missing"}`);
  }
}

async function injectPageHook(sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    return { injected: false };
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["page-hook.js"],
    world: "MAIN"
  });

  return { injected: true };
}

async function getRecentTasks(payload = {}) {
  const pageSize = clampInteger(payload.pageSize, 1, 50, 20);
  const response = await fetchApiJson(TASKS_V2, {
    params: {
      pageSize,
      pageNum: 1,
      sortBy: "-created_at"
    }
  });

  const tasks = collectTasks(response).map(normalizeTask).filter(Boolean);
  return { tasks };
}

async function getTaskStatus(payload = {}) {
  const taskId = sanitizeTaskId(payload.taskId);
  if (!taskId) {
    throw new Error("Missing task ID.");
  }

  const response = await fetchApiJson(`${TASKS_V2}/${encodeURIComponent(taskId)}`, {
    params: { type: payload.taskType || "Task" }
  });

  const task = normalizeTask(response.result || response);
  if (!task?.id) {
    throw new Error("Task status endpoint did not return a task.");
  }

  return { task };
}

async function trackTask(payload = {}, sender = {}) {
  const task = normalizeTask(payload.task || payload);
  if (!task?.id) {
    throw new Error("Missing task ID.");
  }

  const now = Date.now();
  const stored = await chrome.storage.local.get({ [TRACKED_TASKS_STORAGE_KEY]: [] });
  const trackedTasks = Array.isArray(stored[TRACKED_TASKS_STORAGE_KEY])
    ? stored[TRACKED_TASKS_STORAGE_KEY]
    : [];

  const previous = trackedTasks.find((item) => item.id === task.id) || {};
  const next = {
    ...previous,
    ...task,
    tabId: sender?.tab?.id || previous.tabId || null,
    pageUrl: sender?.tab?.url || previous.pageUrl || "",
    lastSeenAt: now,
    lastPolledAt: previous.lastPolledAt || 0,
    lastPollError: ""
  };

  const merged = [
    next,
    ...trackedTasks.filter((item) => item.id !== task.id)
  ]
    .sort((a, b) => Number(b.lastSeenAt || b.updatedAt || 0) - Number(a.lastSeenAt || a.updatedAt || 0))
    .slice(0, MAX_TRACKED_TASKS);

  await chrome.storage.local.set({ [TRACKED_TASKS_STORAGE_KEY]: merged });
  ensureTaskPollAlarm();

  return { task: next };
}

async function getTrackedTasks() {
  const stored = await chrome.storage.local.get({ [TRACKED_TASKS_STORAGE_KEY]: [] });
  return {
    tasks: Array.isArray(stored[TRACKED_TASKS_STORAGE_KEY])
      ? stored[TRACKED_TASKS_STORAGE_KEY]
      : []
  };
}

async function relayCapturedModelRequest(type, payload = {}) {
  const sourceTabId = Number(payload.sourceTabId);
  if (!Number.isInteger(sourceTabId) || sourceTabId <= 0) {
    throw new Error("Missing source Meshy tab ID.");
  }

  const message = {
    type,
    payload: {
      ...payload,
      sourceTabId
    }
  };

  const firstResponse = await sendTabMessage(sourceTabId, message);
  if (firstResponse?.ok !== false || !isMissingReceivingEnd(firstResponse.error)) {
    return firstResponse || {};
  }

  await injectContentScript(sourceTabId);
  await delay(150);
  return sendTabMessage(sourceTabId, message);
}

async function prepareExportSession(payload = {}) {
  cleanupExportSessions();

  const sourceTabId = Number(payload.sourceTabId);
  if (!Number.isInteger(sourceTabId) || sourceTabId <= 0) {
    throw new Error("Missing source Meshy tab ID.");
  }

  const modelId = String(payload.modelId || "");
  let offset = 0;
  let target = null;
  let model = null;

  while (true) {
    const response = await relayCapturedModelRequest("GET_CAPTURED_MODEL_CHUNK", {
      sourceTabId,
      modelId,
      offset,
      length: EXPORT_SESSION_CHUNK_SIZE
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not read the captured model from the Meshy tab.");
    }

    const chunk = response.chunk;
    if (!chunk || !Number.isFinite(chunk.totalSize)) {
      throw new Error("The Meshy tab returned an invalid model chunk.");
    }

    if (!target) {
      target = new Uint8Array(chunk.totalSize);
      model = chunk.model || null;
    }

    const bytes = base64ToBytes(chunk.base64 || "");
    target.set(bytes, chunk.offset || 0);
    offset = (chunk.offset || 0) + bytes.byteLength;

    if (chunk.done) {
      break;
    }

    if (bytes.byteLength === 0) {
      throw new Error("The Meshy tab returned an empty model chunk.");
    }
  }

  const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const session = {
    id: sessionId,
    model,
    bytes: target,
    size: target.byteLength,
    sourceTabId,
    modelId,
    createdAt: Date.now(),
    expiresAt: Date.now() + EXPORT_SESSION_TTL_MS
  };

  exportSessions.set(sessionId, session);
  trimExportSessions();

  return {
    session: serializeExportSession(session)
  };
}

function getExportSessionChunk(payload = {}) {
  cleanupExportSessions();

  const sessionId = String(payload.sessionId || "");
  const session = exportSessions.get(sessionId);
  if (!session?.bytes) {
    throw new Error("Export session expired. Reopen Export Studio from the Meshy popup.");
  }

  const totalSize = session.bytes.byteLength;
  const offset = clampInteger(payload.offset, 0, totalSize, 0);
  const length = clampInteger(payload.length, 1, 2 * 1024 * 1024, EXPORT_SESSION_CHUNK_SIZE);
  const end = Math.min(totalSize, offset + length);
  const bytes = session.bytes.subarray(offset, end);

  session.expiresAt = Date.now() + EXPORT_SESSION_TTL_MS;

  return {
    chunk: {
      session: serializeExportSession(session),
      model: session.model,
      offset,
      byteLength: bytes.byteLength,
      totalSize,
      base64: bytesToBase64(bytes),
      done: end >= totalSize
    }
  };
}

async function pollTrackedTasks() {
  const stored = await chrome.storage.local.get({ [TRACKED_TASKS_STORAGE_KEY]: [] });
  const trackedTasks = Array.isArray(stored[TRACKED_TASKS_STORAGE_KEY])
    ? stored[TRACKED_TASKS_STORAGE_KEY]
    : [];

  if (!trackedTasks.length) {
    return;
  }

  const now = Date.now();
  const nextTasks = [];
  const updatedTasks = [];

  for (const trackedTask of trackedTasks) {
    if (!trackedTask?.id) {
      continue;
    }

    if (!shouldPollTask(trackedTask)) {
      nextTasks.push(trackedTask);
      continue;
    }

    try {
      const { task } = await getTaskStatus({
        taskId: trackedTask.id,
        taskType: trackedTask.taskType || "Task"
      });
      const nextTask = {
        ...trackedTask,
        ...task,
        lastPolledAt: now,
        lastPollError: ""
      };
      nextTasks.push(nextTask);
      updatedTasks.push(nextTask);
    } catch (error) {
      nextTasks.push({
        ...trackedTask,
        lastPolledAt: now,
        lastPollError: error.message || String(error)
      });
    }
  }

  const recentTasks = nextTasks
    .filter((task) => now - Number(task.lastSeenAt || now) < 24 * 60 * 60 * 1000)
    .slice(0, MAX_TRACKED_TASKS);

  await chrome.storage.local.set({ [TRACKED_TASKS_STORAGE_KEY]: recentTasks });
  await Promise.all(updatedTasks.map((task) => broadcastTaskUpdate(task)));
}

async function broadcastTaskUpdate(task) {
  const tabs = await chrome.tabs.query({ url: TASK_TABS });
  await Promise.all(tabs.map((tab) => sendTabMessageNoop(tab.id, {
    type: "TASK_STATUS_UPDATED",
    task
  })));
}

function sendTabMessageNoop(tabId, message) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve();
      return;
    }

    chrome.tabs.sendMessage(tabId, message, () => resolve());
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve({ ok: false, error: "Missing tab ID." });
      return;
    }

    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response || {});
    });
  });
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

function ensureTaskPollAlarm() {
  chrome.alarms?.create(TASK_POLL_ALARM_NAME, {
    periodInMinutes: TASK_POLL_PERIOD_MINUTES
  });
}

function isMissingReceivingEnd(message) {
  return String(message || "").includes("Receiving end does not exist");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeExportSession(session) {
  return {
    id: session.id,
    model: session.model,
    size: session.size,
    sourceTabId: session.sourceTabId,
    modelId: session.modelId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  };
}

function cleanupExportSessions() {
  const now = Date.now();
  for (const [sessionId, session] of exportSessions.entries()) {
    if (session.expiresAt <= now) {
      exportSessions.delete(sessionId);
    }
  }
}

function trimExportSessions() {
  cleanupExportSessions();
  const sessions = [...exportSessions.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  for (const session of sessions.slice(MAX_EXPORT_SESSIONS)) {
    exportSessions.delete(session.id);
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000));
    let chunk = "";
    for (let index = 0; index < slice.length; index += 1) {
      chunk += String.fromCharCode(slice[index]);
    }
    binary += chunk;
  }
  return btoa(binary);
}

async function fetchApiJson(path, options = {}) {
  const url = new URL(path.startsWith("http") ? path : `${API_BASE}${path}`);
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method: options.method || "GET",
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { result: text };
    }
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.result || data?.code || `HTTP ${response.status}`);
  }

  if (data?.code && data.code !== "OK") {
    throw new Error(data.message || data.result || data.code);
  }

  return data;
}

function collectTasks(payload) {
  const result = payload?.result ?? payload;
  if (Array.isArray(result)) {
    return result;
  }
  if (Array.isArray(result?.tasks)) {
    return result.tasks;
  }
  if (Array.isArray(result?.list)) {
    return result.list;
  }
  return [];
}

function normalizeTask(task) {
  if (!task || typeof task !== "object") {
    return null;
  }

  const texture = task.result?.texture || null;
  const generate = task.result?.generate || null;
  const modelUrl = texture?.modelUrl || generate?.modelUrl || task.modelUrl || "";

  return {
    id: task.id || task.taskId || "",
    taskId: task.taskId || task.id || "",
    name: task.name || "Meshy model",
    taskType: task.taskType || "Task",
    status: task.status || "",
    phase: task.phase || "",
    modelUrl,
    textureUrls: texture?.textureUrls || task.textureUrls || [],
    triangleCount: task.triangleCount || 0,
    vertexCount: task.vertexCount || 0,
    updatedAt: task.updatedAt || task.createdAt || 0
  };
}

function shouldPollTask(task) {
  const status = String(task?.status || "").toUpperCase();
  return !["SUCCEEDED", "FAILED", "CANCELED", "CANCELLED"].includes(status);
}

function sanitizeTaskId(taskId) {
  const value = String(taskId || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : "";
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
