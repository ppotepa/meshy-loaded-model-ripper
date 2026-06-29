const API_BASE = "https://api.meshy.ai/web";
const TASKS_V2 = "/v2/tasks";
const TRACKED_TASKS_STORAGE_KEY = "trackedTasks";
const TASK_POLL_ALARM_NAME = "pollTrackedMeshyTasks";
const TASK_POLL_PERIOD_MINUTES = 1;
const MAX_TRACKED_TASKS = 40;
const TASK_TABS = [
  "https://*.meshy.ai/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
];

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

function ensureTaskPollAlarm() {
  chrome.alarms?.create(TASK_POLL_ALARM_NAME, {
    periodInMinutes: TASK_POLL_PERIOD_MINUTES
  });
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
