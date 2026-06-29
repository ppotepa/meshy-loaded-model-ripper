(function installMeshyLoadedModelRipperPageHook() {
  const PAGE_SOURCE = "MESHY_LOADED_MODEL_RIPPER_PAGE";
  const EXTENSION_SOURCE = "MESHY_LOADED_MODEL_RIPPER_EXTENSION";
  const INSTALL_KEY = "__MESHY_LOADED_MODEL_RIPPER_PAGE_HOOK_0_3_0__";

  const TASKS_PATTERN = /\/web\/v2\/tasks(?:\/|$|\?)/;
  const ENCRYPTED_MODEL_PATTERN = /(?:\.meshy(?:[?#]|$)|\/misc\/cdn-models(?:\/|$|\?))/i;
  const DECRYPT_WORKER_PATTERN = /\/resource\/decrypt\/loader-worker\.min\.js(?:[?#]|$)/i;
  const MODEL_SOURCE_PATTERN = /\.(glb|gltf)(?:[?#]|$)|\/model\.(glb|gltf)(?:[?#]|$)/i;

  const MAX_TASKS = 30;
  const MAX_MODEL_REQUESTS = 20;
  const MAX_LOADED_MODELS = 8;
  const MAX_SCENE_ROOTS = 8;
  const MAX_WORKER_EVENTS = 20;
  const OBJECT_URL_TTL_MS = 30 * 60 * 1000;
  const STATE_PUBLISH_INTERVAL_MS = 1500;
  const GLOBAL_LOADER_HOOK_INTERVAL_MS = 1000;
  const RECENT_MODEL_SIGNAL_MS = 90000;

  if (window[INSTALL_KEY]) {
    postMessageToContent({ type: "HOOK_READY" });
    return;
  }

  window[INSTALL_KEY] = true;

  let nativeCreateObjectURL = URL.createObjectURL?.bind(URL) || null;
  let loadedModelSequence = 0;

  const tasksById = new Map();
  const modelRequests = [];
  const loadedModels = [];
  const sceneRoots = [];
  const workerEvents = [];
  const decryptWorkerState = new WeakMap();
  let workerPrototypePostMessageHooked = false;

  hookWorkerPrototype();
  hookWorkerConstructor();
  hookFetch();
  hookXhr();
  hookObjectUrls();
  installGlobalLoaderWatcher();

  window.addEventListener("message", handleContentRequest);
  postMessageToContent({ type: "HOOK_READY" });
  postState();
  window.setInterval(postState, STATE_PUBLISH_INTERVAL_MS);

  function handleContentRequest(event) {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const message = event.data;
    if (!message || message.source !== EXTENSION_SOURCE || !message.requestId) {
      return;
    }

    if (message.type === "GET_RIPPER_STATE") {
      respond(message.requestId, () => ({ state: getSerializableState() }));
      return;
    }

    if (message.type === "DOWNLOAD_LATEST_LOADED_MODEL") {
      respond(message.requestId, () => downloadLatestLoadedModel(message.payload || {}));
      return;
    }

    if (message.type === "GET_CAPTURED_MODEL_META") {
      respond(message.requestId, () => getCapturedModelMeta(message.payload || {}));
      return;
    }

    if (message.type === "GET_CAPTURED_MODEL_CHUNK") {
      respond(message.requestId, () => getCapturedModelChunk(message.payload || {}));
    }
  }

  async function respond(requestId, handler) {
    try {
      const result = await handler();
      postMessageToContent({
        requestId,
        ok: true,
        ...(result && typeof result === "object" ? result : { result })
      });
    } catch (error) {
      postMessageToContent({
        requestId,
        ok: false,
        error: error?.message || String(error)
      });
    }
  }

  function hookWorkerConstructor() {
    const NativeWorker = window.Worker;
    if (typeof NativeWorker !== "function" || NativeWorker.__meshyLoadedModelRipperConstructorHookedV030) {
      return;
    }

    function MeshyRipperWorker(scriptURL, options) {
      const worker = new NativeWorker(scriptURL, options);
      instrumentWorker(worker, scriptURL, "Worker.constructor");
      return worker;
    }

    try {
      Object.setPrototypeOf(MeshyRipperWorker, NativeWorker);
    } catch {
      // Non-critical. The returned instance is the native worker.
    }

    MeshyRipperWorker.prototype = NativeWorker.prototype;
    MeshyRipperWorker.__meshyLoadedModelRipperConstructorHookedV030 = true;
    window.Worker = MeshyRipperWorker;
  }

  function hookWorkerPrototype() {
    const proto = window.Worker?.prototype;
    if (!proto || proto.__meshyLoadedModelRipperPrototypeHookedV030 || typeof proto.postMessage !== "function") {
      return;
    }

    const originalPostMessage = proto.postMessage;
    proto.postMessage = function postMessage(message, transfer) {
      const state = ensureWorkerState(this, "", "Worker.prototype.postMessage");
      inspectDecryptWorkerPostMessage(state, message);
      return originalPostMessage.apply(this, arguments);
    };

    proto.__meshyLoadedModelRipperPrototypeHookedV030 = true;
    workerPrototypePostMessageHooked = true;
  }

  function instrumentWorker(worker, scriptURL, source) {
    if (!worker) {
      return;
    }

    const state = ensureWorkerState(worker, scriptURL, source);
    if (!workerPrototypePostMessageHooked && typeof worker.postMessage === "function" && !worker.__meshyLoadedModelRipperInstanceHookedV030) {
      const originalPostMessage = worker.postMessage;
      worker.postMessage = function postMessage(message, transfer) {
        inspectDecryptWorkerPostMessage(state, message);
        return originalPostMessage.apply(this, arguments);
      };
      try {
        worker.__meshyLoadedModelRipperInstanceHookedV030 = true;
      } catch {
        // Some browser objects may reject expando fields.
      }
    }
  }

  function ensureWorkerState(worker, scriptURL, source) {
    if (decryptWorkerState.has(worker)) {
      const state = decryptWorkerState.get(worker);
      if (scriptURL && !state.scriptURL) {
        state.scriptURL = stringifyUrl(scriptURL);
        state.isDecryptWorker = isDecryptWorkerUrl(scriptURL);
      }
      return state;
    }

    const state = {
      scriptURL: stringifyUrl(scriptURL),
      isDecryptWorker: isDecryptWorkerUrl(scriptURL),
      pendingById: new Map()
    };
    decryptWorkerState.set(worker, state);

    registerWorkerEvent({
      source,
      scriptURL: state.scriptURL,
      isDecryptWorker: state.isDecryptWorker,
      event: "instrumented"
    });

    try {
      worker.addEventListener("message", (event) => {
        inspectDecryptWorkerMessage(state, event.data);
      });
    } catch {
      // If listener registration fails, postMessage diagnostics still work.
    }

    return state;
  }

  function inspectDecryptWorkerPostMessage(state, message) {
    if (!message || message.type !== "process" || message.id === undefined) {
      return;
    }

    const encryptedUrl = latestEncryptedModelUrl();
    const request = {
      id: String(message.id),
      mode: message.mode || "default",
      encryptedUrl,
      inputBytes: byteLengthOf(message.data),
      source: state.isDecryptWorker ? "decrypt-worker.postMessage" : "worker.postMessage",
      detectedAt: Date.now()
    };

    state.pendingById.set(String(message.id), request);

    registerWorkerEvent({
      source: request.source,
      scriptURL: state.scriptURL,
      isDecryptWorker: state.isDecryptWorker,
      event: "process-request",
      id: request.id,
      mode: request.mode,
      inputBytes: request.inputBytes,
      encryptedUrl
    });

    if (request.encryptedUrl) {
      registerModelRequest({
        url: request.encryptedUrl,
        source: request.source,
        stage: "decrypt-request",
        mode: request.mode,
        inputBytes: request.inputBytes
      });
    }
  }

  function inspectDecryptWorkerMessage(state, message) {
    if (!message || message.type !== "process" || message.id === undefined) {
      return;
    }

    const id = String(message.id);
    const pending = state.pendingById.get(id) || {};
    state.pendingById.delete(id);

    if (!message.success || !message.data) {
      registerWorkerEvent({
        source: state.isDecryptWorker ? "decrypt-worker.message" : "worker.message",
        scriptURL: state.scriptURL,
        isDecryptWorker: state.isDecryptWorker,
        event: "process-error",
        id,
        error: message.error || ""
      });
      return;
    }

    registerWorkerEvent({
      source: state.isDecryptWorker ? "decrypt-worker.message" : "worker.message",
      scriptURL: state.scriptURL,
      isDecryptWorker: state.isDecryptWorker,
      event: "process-success",
      id,
      outputBytes: byteLengthOf(message.data)
    });

    registerLoadedModelFromBuffer(message.data, {
      encryptedUrl: pending.encryptedUrl || latestEncryptedModelUrl(),
      mode: pending.mode || "default",
      source: state.isDecryptWorker ? "decrypt-worker.message" : "worker.message"
    });
  }

  function hookFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function" || originalFetch.__meshyLoadedModelRipperHooked) {
      return;
    }

    function hookedFetch(input, init) {
      const requestUrl = getRequestUrl(input);
      if (isEncryptedModelUrl(requestUrl)) {
        registerModelRequest({
          url: requestUrl,
          source: "fetch",
          stage: "encrypted-request"
        });
      }

      const promise = originalFetch.call(this, input, init);
      promise
        .then((response) => inspectFetchResponse(requestUrl, response))
        .catch(() => {});

      return promise;
    }

    hookedFetch.__meshyLoadedModelRipperHooked = true;
    window.fetch = hookedFetch;
  }

  async function inspectFetchResponse(url, response) {
    const contentType = response?.headers?.get?.("content-type") || "";

    if (isTaskApiUrl(url) && contentType.includes("json")) {
      try {
        const payload = await response.clone().json();
        publishTasksFromPayload(url, payload);
      } catch {
        // Ignore consumed or non-JSON responses.
      }
      return;
    }

    if (!isPotentialPlainModelSource(url, contentType)) {
      return;
    }

    try {
      const arrayBuffer = await response.clone().arrayBuffer();
      registerPlainModelSource(arrayBuffer, {
        url,
        contentType,
        source: "fetch"
      });
    } catch {
      // Ignore consumed or opaque responses.
    }
  }

  function hookXhr() {
    const Xhr = window.XMLHttpRequest;
    if (!Xhr || Xhr.prototype.__meshyLoadedModelRipperHooked) {
      return;
    }

    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;

    Xhr.prototype.open = function open(method, url) {
      this.__meshyLoadedModelRipperUrl = getRequestUrl(url);
      if (isEncryptedModelUrl(this.__meshyLoadedModelRipperUrl)) {
        registerModelRequest({
          url: this.__meshyLoadedModelRipperUrl,
          source: "xhr",
          stage: "encrypted-request"
        });
      }
      return originalOpen.apply(this, arguments);
    };

    Xhr.prototype.send = function send() {
      this.addEventListener("load", () => {
        const url = this.__meshyLoadedModelRipperUrl || "";
        const contentType = this.getResponseHeader?.("content-type") || "";

        if (isTaskApiUrl(url)) {
          try {
            publishTasksFromPayload(url, JSON.parse(this.responseText));
          } catch {
            // Ignore non-JSON responses.
          }
        }

        if (!isPotentialPlainModelSource(url, contentType)) {
          return;
        }

        try {
          if (this.response instanceof ArrayBuffer) {
            registerPlainModelSource(this.response, {
              url,
              contentType,
              source: "xhr"
            });
          } else if (this.response instanceof Blob) {
            inspectBlobCandidate(this.response, {
              url,
              contentType,
              source: "xhr"
            }).catch(() => {});
          }
        } catch {
          // Ignore inaccessible response payloads.
        }
      });

      return originalSend.apply(this, arguments);
    };

    Xhr.prototype.__meshyLoadedModelRipperHooked = true;
  }

  function hookObjectUrls() {
    if (!URL?.createObjectURL || URL.createObjectURL.__meshyLoadedModelRipperHooked) {
      return;
    }

    function hookedCreateObjectURL(value) {
      const objectUrl = nativeCreateObjectURL(value);
      if (value instanceof Blob) {
        inspectBlobCandidate(value, {
          objectUrl,
          source: "URL.createObjectURL"
        }).catch(() => {});
      }
      return objectUrl;
    }

    hookedCreateObjectURL.__meshyLoadedModelRipperHooked = true;
    URL.createObjectURL = hookedCreateObjectURL;
  }

  function installGlobalLoaderWatcher() {
    tryInstallGlobalLoaderHooks();
    window.setInterval(tryInstallGlobalLoaderHooks, GLOBAL_LOADER_HOOK_INTERVAL_MS);
  }

  function tryInstallGlobalLoaderHooks() {
    hookGLTFLoaderClass(window.GLTFLoader, "window.GLTFLoader");
    hookGLTFLoaderClass(window.THREE?.GLTFLoader, "window.THREE.GLTFLoader");
    hookObject3DClass(window.THREE?.Object3D, "window.THREE.Object3D");
  }

  function hookGLTFLoaderClass(GLTFLoader, source) {
    const proto = GLTFLoader?.prototype;
    if (!proto || proto.__meshyLoadedModelRipperHooked) {
      return;
    }

    const originalParse = proto.parse;
    if (typeof originalParse === "function") {
      proto.parse = function parse(data, path, onLoad, onError) {
        registerParsePayload(data, path, `${source}.parse`);
        const wrappedOnLoad = typeof onLoad === "function"
          ? (gltf) => {
              registerGltfScene(gltf, {
                source: `${source}.parse`,
                url: typeof path === "string" ? path : latestEncryptedModelUrl()
              });
              return onLoad(gltf);
            }
          : onLoad;

        return originalParse.call(this, data, path, wrappedOnLoad, onError);
      };
    }

    const originalParseAsync = proto.parseAsync;
    if (typeof originalParseAsync === "function") {
      proto.parseAsync = function parseAsync(data, path) {
        registerParsePayload(data, path, `${source}.parseAsync`);
        return originalParseAsync.call(this, data, path).then((gltf) => {
          registerGltfScene(gltf, {
            source: `${source}.parseAsync`,
            url: typeof path === "string" ? path : latestEncryptedModelUrl()
          });
          return gltf;
        });
      };
    }

    proto.__meshyLoadedModelRipperHooked = true;
  }

  function hookObject3DClass(Object3D, source) {
    const proto = Object3D?.prototype;
    if (!proto || proto.__meshyLoadedModelRipperAddHooked || typeof proto.add !== "function") {
      return;
    }

    const originalAdd = proto.add;
    proto.add = function add(...objects) {
      if (hasRecentModelSignal()) {
        for (const object of objects) {
          if (looksLikeModelRoot(object)) {
            registerSceneRoot(object, {
              source: `${source}.add`,
              url: latestEncryptedModelUrl()
            });
          }
        }
      }

      return originalAdd.apply(this, objects);
    };

    proto.__meshyLoadedModelRipperAddHooked = true;
  }

  function registerParsePayload(data, path, source) {
    const url = latestEncryptedModelUrl() || (typeof path === "string" ? path : "");
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      registerPlainModelSource(data, {
        encryptedUrl: url,
        url,
        contentType: "model/gltf-binary",
        source
      });
    }
  }

  async function inspectBlobCandidate(blob, metadata = {}) {
    if (!blob || blob.size <= 0) {
      return;
    }

    const head = await blob.slice(0, 256).arrayBuffer();
    const kind = detectModelKind(head, metadata.url || metadata.objectUrl || "", blob.type || metadata.contentType || "");
    if (!kind) {
      return;
    }

    const arrayBuffer = await blob.arrayBuffer();
    registerLoadedModelFromBuffer(arrayBuffer, {
      encryptedUrl: latestEncryptedModelUrl(),
      url: metadata.url || "",
      appObjectUrl: metadata.objectUrl || "",
      contentType: blob.type || metadata.contentType || "",
      source: metadata.source || "blob"
    });
  }

  function registerPlainModelSource(data, metadata = {}) {
    const arrayBuffer = copyArrayBuffer(data);
    if (!arrayBuffer) {
      return;
    }

    const kind = detectModelKind(arrayBuffer, metadata.url || metadata.encryptedUrl || "", metadata.contentType || "");
    if (!kind) {
      return;
    }

    registerLoadedModelFromBuffer(arrayBuffer, {
      ...metadata,
      kind,
      source: metadata.source || "plain-model-source"
    });
  }

  function registerLoadedModelFromBuffer(data, metadata = {}) {
    const arrayBuffer = copyArrayBuffer(data);
    if (!arrayBuffer || arrayBuffer.byteLength <= 0) {
      return;
    }

    const kind = metadata.kind || detectModelKind(arrayBuffer, metadata.url || metadata.encryptedUrl || "", metadata.contentType || "");
    if (!kind) {
      return;
    }

    const encryptedUrl = metadata.encryptedUrl || latestEncryptedModelUrl();
    const task = findTaskForModelUrl(encryptedUrl || metadata.url || "");
    const taskId = task?.id || extractTaskId(encryptedUrl || metadata.url || "");
    const filename = sanitizeFilename(
      metadata.filename ||
      `${task?.name || taskId || "meshy-loaded-model"}.${kind === "gltf" ? "gltf" : "glb"}`
    );
    const mimeType = kind === "gltf" ? "model/gltf+json" : "model/gltf-binary";
    const blob = new Blob([arrayBuffer], { type: mimeType });
    const objectUrl = createObjectUrl(blob);
    const now = Date.now();

    const model = {
      id: `${now}-${++loadedModelSequence}`,
      kind,
      filename,
      mimeType,
      size: arrayBuffer.byteLength,
      arrayBuffer,
      objectUrl,
      encryptedUrl,
      sourceUrl: metadata.url || "",
      appObjectUrl: metadata.appObjectUrl || "",
      taskId,
      taskName: task?.name || "",
      mode: metadata.mode || "",
      source: metadata.source || "decrypted-buffer",
      detectedAt: now,
      expiresAt: now + OBJECT_URL_TTL_MS
    };

    const key = model.encryptedUrl || model.sourceUrl || model.appObjectUrl || `${model.source}:${model.size}`;
    const existingIndex = loadedModels.findIndex((item) => {
      const itemKey = item.encryptedUrl || item.sourceUrl || item.appObjectUrl || `${item.source}:${item.size}`;
      return itemKey === key && item.size === model.size;
    });

    if (existingIndex >= 0) {
      revokeModelObjectUrl(loadedModels[existingIndex]);
      loadedModels.splice(existingIndex, 1);
    }

    loadedModels.unshift(model);
    while (loadedModels.length > MAX_LOADED_MODELS) {
      revokeModelObjectUrl(loadedModels.pop());
    }

    window.setTimeout(() => {
      const item = loadedModels.find((candidate) => candidate.id === model.id);
      if (item && Date.now() >= item.expiresAt) {
        revokeModelObjectUrl(item);
      }
    }, OBJECT_URL_TTL_MS + 1000);

    postMessageToContent({
      type: "LOADED_MODEL",
      model: serializeLoadedModel(model)
    });
    postState();
  }

  function registerModelRequest(candidate) {
    if (!candidate?.url) {
      return;
    }

    const normalized = {
      url: String(candidate.url),
      source: candidate.source || "unknown",
      stage: candidate.stage || "request",
      mode: candidate.mode || "",
      inputBytes: candidate.inputBytes || 0,
      taskId: extractTaskId(candidate.url),
      detectedAt: Date.now()
    };

    const existingIndex = modelRequests.findIndex((item) => item.url === normalized.url && item.stage === normalized.stage);
    if (existingIndex >= 0) {
      modelRequests.splice(existingIndex, 1);
    }

    modelRequests.unshift(normalized);
    modelRequests.splice(MAX_MODEL_REQUESTS);

    postMessageToContent({
      type: "MODEL_REQUEST",
      request: normalized
    });
    postState();
  }

  function registerGltfScene(gltf, metadata = {}) {
    const root = gltf?.scene || gltf?.scenes?.[0] || null;
    registerSceneRoot(root, metadata);
  }

  function registerSceneRoot(root, metadata = {}) {
    if (!looksLikeModelRoot(root)) {
      return;
    }

    const counts = countGeometry(root);
    const sceneRoot = {
      source: metadata.source || "scene-root",
      url: metadata.url || latestEncryptedModelUrl(),
      name: metadata.name || root.name || "",
      triangleCount: counts.triangleCount,
      vertexCount: counts.vertexCount,
      meshCount: counts.meshCount,
      detectedAt: Date.now()
    };

    const key = `${sceneRoot.source}:${sceneRoot.url}:${sceneRoot.triangleCount}:${sceneRoot.vertexCount}:${sceneRoot.meshCount}`;
    const existingIndex = sceneRoots.findIndex((item) => item.key === key);
    if (existingIndex >= 0) {
      sceneRoots.splice(existingIndex, 1);
    }

    sceneRoots.unshift({ key, ...sceneRoot });
    sceneRoots.splice(MAX_SCENE_ROOTS);

    postMessageToContent({
      type: "SCENE_ROOT",
      sceneRoot
    });
    postState();
  }

  function downloadLatestLoadedModel(payload = {}) {
    cleanupExpiredModels();
    const model = loadedModels[0];
    if (!model?.objectUrl) {
      throw new Error("No decrypted loaded model is available yet.");
    }

    const filename = sanitizeFilename(payload.filename || model.filename || "meshy-loaded-model.glb");
    const anchor = document.createElement("a");
    anchor.href = model.objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.documentElement.append(anchor);
    anchor.click();
    anchor.remove();

    return {
      filename,
      model: serializeLoadedModel(model)
    };
  }

  function getCapturedModelMeta(payload = {}) {
    cleanupExpiredModels();
    const model = findLoadedModel(payload.modelId);
    if (!model?.arrayBuffer) {
      throw new Error("No captured loaded model is available yet.");
    }

    return {
      model: serializeLoadedModel(model)
    };
  }

  function getCapturedModelChunk(payload = {}) {
    cleanupExpiredModels();
    const model = findLoadedModel(payload.modelId);
    if (!model?.arrayBuffer) {
      throw new Error("No captured loaded model is available yet.");
    }

    const totalSize = model.arrayBuffer.byteLength;
    const offset = clampInteger(payload.offset, 0, totalSize, 0);
    const length = clampInteger(payload.length, 1, 2 * 1024 * 1024, 512 * 1024);
    const end = Math.min(totalSize, offset + length);
    const bytes = new Uint8Array(model.arrayBuffer, offset, Math.max(0, end - offset));

    return {
      chunk: {
        model: serializeLoadedModel(model),
        offset,
        byteLength: bytes.byteLength,
        totalSize,
        base64: bytesToBase64(bytes),
        done: end >= totalSize
      }
    };
  }

  function postState() {
    postMessageToContent({
      type: "RIPPER_STATE",
      state: getSerializableState()
    });
  }

  function getSerializableState() {
    cleanupExpiredModels();
    return {
      pageUrl: window.location.href,
      hookReady: true,
      currentTask: getCurrentTask(),
      tasks: [...tasksById.values()]
        .sort((a, b) => scoreTask(b) - scoreTask(a))
        .slice(0, MAX_TASKS),
      latestRequest: modelRequests[0] || null,
      latestLoadedModel: loadedModels[0] ? serializeLoadedModel(loadedModels[0]) : null,
      latestSceneRoot: sceneRoots[0] || null,
      latestWorkerEvent: workerEvents[0] || null,
      modelRequests: modelRequests.slice(0, 5),
      loadedModels: loadedModels.slice(0, 5).map(serializeLoadedModel),
      sceneRoots: sceneRoots.slice(0, 5),
      workerEvents: workerEvents.slice(0, 5)
    };
  }

  function publishTasksFromPayload(url, payload) {
    const tasks = collectTasks(payload).map(normalizeTask).filter(Boolean);
    for (const task of tasks) {
      tasksById.set(task.id, {
        ...tasksById.get(task.id),
        ...task,
        seenAt: Date.now()
      });
    }

    if (!tasks.length) {
      return;
    }

    postMessageToContent({
      type: "TASKS",
      origin: url,
      tasks
    });
    postState();
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
    if (isTaskLike(result)) {
      return [result];
    }
    return [];
  }

  function normalizeTask(task) {
    if (!isTaskLike(task)) {
      return null;
    }

    const texture = task.result?.texture || task.texture || null;
    const generate = task.result?.generate || task.generate || null;
    const modelUrl = texture?.modelUrl || generate?.modelUrl || task.modelUrl || "";
    const taskId = task.taskId || task.id || "";

    return {
      id: taskId,
      taskId,
      name: task.name || "Meshy model",
      status: task.status || "",
      phase: task.phase || "",
      modelUrl,
      textureUrls: texture?.textureUrls || task.textureUrls || [],
      triangleCount: task.triangleCount || 0,
      vertexCount: task.vertexCount || 0,
      updatedAt: task.updatedAt || task.createdAt || 0
    };
  }

  function getCurrentTask() {
    const loaded = loadedModels[0];
    const request = modelRequests[0];
    const task =
      findTaskForModelUrl(loaded?.encryptedUrl || loaded?.sourceUrl || "") ||
      findTaskForModelUrl(request?.url || "");

    if (task) {
      return task;
    }

    return [...tasksById.values()].sort((a, b) => scoreTask(b) - scoreTask(a))[0] || null;
  }

  function findTaskForModelUrl(url) {
    const taskId = extractTaskId(url);
    if (taskId && tasksById.has(taskId)) {
      return tasksById.get(taskId);
    }

    if (!url) {
      return null;
    }

    return [...tasksById.values()].find((task) => task.modelUrl && task.modelUrl === url) || null;
  }

  function scoreTask(task) {
    let score = Number(task.updatedAt || task.seenAt || 0) / 1000;
    if (task.modelUrl) score += 100000000;
    if (String(task.status).toUpperCase() === "SUCCEEDED") score += 10000000;
    if (task.phase === "texture") score += 1000000;
    if (task.phase === "generate") score += 500000;
    return score;
  }

  function serializeLoadedModel(model) {
    return {
      id: model.id,
      kind: model.kind,
      filename: model.filename,
      mimeType: model.mimeType,
      size: model.size,
      objectUrl: model.objectUrl,
      encryptedUrl: model.encryptedUrl,
      sourceUrl: model.sourceUrl,
      taskId: model.taskId,
      taskName: model.taskName,
      mode: model.mode,
      source: model.source,
      detectedAt: model.detectedAt,
      expiresAt: model.expiresAt
    };
  }

  function findLoadedModel(modelId) {
    if (modelId) {
      const matching = loadedModels.find((model) => model.id === modelId);
      if (matching) {
        return matching;
      }
    }

    return loadedModels[0] || null;
  }

  function detectModelKind(arrayBuffer, url = "", contentType = "") {
    const bytes = new Uint8Array(arrayBuffer || new ArrayBuffer(0));
    const lowerUrl = String(url || "").toLowerCase();
    const lowerType = String(contentType || "").toLowerCase();

    if (bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
      return "glb";
    }

    if (lowerType.includes("model/gltf-binary") || lowerUrl.includes(".glb")) {
      return bytes.length ? null : "glb";
    }

    try {
      const head = new TextDecoder("utf-8").decode(bytes.slice(0, 512)).trimStart();
      if (head.startsWith("{") && head.includes('"asset"') && head.includes('"version"')) {
        return "gltf";
      }
    } catch {
      // Binary payload, not JSON glTF.
    }

    if (lowerType.includes("model/gltf+json") || lowerUrl.includes(".gltf")) {
      return "gltf";
    }

    return null;
  }

  function isPotentialPlainModelSource(url, contentType = "") {
    const lowerType = String(contentType || "").toLowerCase();
    return MODEL_SOURCE_PATTERN.test(String(url || "")) ||
      lowerType.includes("model/gltf") ||
      lowerType.includes("model/gltf-binary");
  }

  function isEncryptedModelUrl(url) {
    return ENCRYPTED_MODEL_PATTERN.test(String(url || ""));
  }

  function isDecryptWorkerUrl(scriptURL) {
    try {
      const url = new URL(stringifyUrl(scriptURL), window.location.href);
      return DECRYPT_WORKER_PATTERN.test(url.pathname + url.search + url.hash);
    } catch {
      return DECRYPT_WORKER_PATTERN.test(stringifyUrl(scriptURL));
    }
  }

  function isTaskApiUrl(url) {
    return TASKS_PATTERN.test(String(url || ""));
  }

  function latestEncryptedModelUrl() {
    return modelRequests.find((item) => isEncryptedModelUrl(item.url))?.url || "";
  }

  function hasRecentModelSignal() {
    const now = Date.now();
    const latest = Math.max(
      Number(modelRequests[0]?.detectedAt || 0),
      Number(loadedModels[0]?.detectedAt || 0)
    );
    return latest > 0 && now - latest < RECENT_MODEL_SIGNAL_MS;
  }

  function looksLikeModelRoot(value) {
    if (!value || typeof value.traverse !== "function") {
      return false;
    }

    const counts = countGeometry(value);
    return counts.meshCount > 0 && (counts.vertexCount >= 20 || counts.triangleCount >= 10);
  }

  function countGeometry(root) {
    let triangleCount = 0;
    let vertexCount = 0;
    let meshCount = 0;

    try {
      root.traverse((obj) => {
        if (!obj?.isMesh || !obj.geometry) {
          return;
        }

        meshCount += 1;
        const geometry = obj.geometry;
        const position = geometry.attributes?.position;
        const index = geometry.index;
        vertexCount += position?.count || 0;
        triangleCount += index ? index.count / 3 : (position?.count || 0) / 3;
      });
    } catch {
      return { triangleCount: 0, vertexCount: 0, meshCount: 0 };
    }

    return {
      triangleCount: Math.floor(triangleCount),
      vertexCount,
      meshCount
    };
  }

  function cleanupExpiredModels() {
    const now = Date.now();
    for (let index = loadedModels.length - 1; index >= 0; index -= 1) {
      if (loadedModels[index].expiresAt <= now) {
        revokeModelObjectUrl(loadedModels[index]);
        loadedModels.splice(index, 1);
      }
    }
  }

  function registerWorkerEvent(event) {
    const normalized = {
      ...event,
      detectedAt: Date.now()
    };
    workerEvents.unshift(normalized);
    workerEvents.splice(MAX_WORKER_EVENTS);
    postMessageToContent({
      type: "WORKER_EVENT",
      event: normalized
    });
  }

  function revokeModelObjectUrl(model) {
    if (model?.objectUrl) {
      try {
        URL.revokeObjectURL(model.objectUrl);
      } catch {
        // Ignore already-revoked object URLs.
      }
    }
  }

  function copyArrayBuffer(value) {
    if (value instanceof ArrayBuffer) {
      return value.slice(0);
    }

    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }

    return null;
  }

  function byteLengthOf(value) {
    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    if (ArrayBuffer.isView(value)) {
      return value.byteLength;
    }
    return 0;
  }

  function createObjectUrl(blob) {
    if (!nativeCreateObjectURL) {
      throw new Error("URL.createObjectURL is not available.");
    }
    return nativeCreateObjectURL(blob);
  }

  function extractTaskId(url) {
    const match = String(url || "").match(/\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
    return match?.[1] || "";
  }

  function getRequestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.toString();
    }
    return input?.url || "";
  }

  function stringifyUrl(value) {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof URL) {
      return value.toString();
    }
    return String(value || "");
  }

  function sanitizeFilename(filename) {
    return String(filename || "meshy-loaded-model.glb")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "meshy-loaded-model.glb";
  }

  function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
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

  function isTaskLike(value) {
    return Boolean(value && typeof value === "object" && (value.id || value.taskId));
  }

  function postMessageToContent(payload) {
    window.postMessage({
      source: PAGE_SOURCE,
      ...payload
    }, window.location.origin);
  }
})();
