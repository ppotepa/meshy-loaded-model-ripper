import * as THREE from "./vendor/three/three.module.js";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { OBJExporter } from "./vendor/three/OBJExporter.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";

window.__MESHY_EXPORT_STUDIO_STARTED__ = true;

const CHUNK_SIZE = 512 * 1024;
const PROFILE_DEFAULTS = {
  cleanup: { ratio: 100, error: 0, lockBorder: true, quantize: false },
  safe: { ratio: 82, error: 10, lockBorder: true, quantize: true },
  balanced: { ratio: 58, error: 30, lockBorder: true, quantize: true },
  aggressive: { ratio: 32, error: 100, lockBorder: false, quantize: true }
};

const params = new URLSearchParams(window.location.search);
const exportSessionId = params.get("sessionId") || "";
const sourceTabId = Number(params.get("sourceTabId") || 0);
const requestedModelId = params.get("modelId") || "";

const elements = {};
let capturedModel = null;
let originalArrayBuffer = null;
let optimizedArrayBuffer = null;
let originalRoot = null;
let optimizedRoot = null;
let activeRoot = null;
let originalStats = null;
let optimizedStats = null;
let optimizationWorkerStats = null;
let validationResult = null;
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let animationFrame = 0;
let wireframeEnabled = false;
let activeMode = "original";
let isBusy = false;
let progressTimer = 0;

cacheElements();
bindEvents();
init().catch((error) => {
  setStatus(error.message || String(error), true);
  setProgress(0);
});

function cacheElements() {
  elements.modelTitle = document.getElementById("model-title");
  elements.modelSubtitle = document.getElementById("model-subtitle");
  elements.canvas = document.getElementById("preview-canvas");
  elements.viewOriginal = document.getElementById("view-original");
  elements.viewOptimized = document.getElementById("view-optimized");
  elements.resetCamera = document.getElementById("reset-camera");
  elements.toggleWireframe = document.getElementById("toggle-wireframe");
  elements.format = document.getElementById("format");
  elements.formatNote = document.getElementById("format-note");
  elements.textureMode = document.getElementById("texture-mode");
  elements.textureModeNote = document.getElementById("texture-mode-note");
  elements.profile = document.getElementById("profile");
  elements.ratio = document.getElementById("ratio");
  elements.ratioValue = document.getElementById("ratio-value");
  elements.error = document.getElementById("error");
  elements.errorValue = document.getElementById("error-value");
  elements.lockBorder = document.getElementById("lock-border");
  elements.quantize = document.getElementById("quantize");
  elements.topology = document.getElementById("topology");
  elements.generateOptimized = document.getElementById("generate-optimized");
  elements.validation = document.getElementById("validation");
  elements.originalTotal = document.getElementById("original-total");
  elements.optimizedTotal = document.getElementById("optimized-total");
  elements.originalGeometry = document.getElementById("original-geometry");
  elements.optimizedGeometry = document.getElementById("optimized-geometry");
  elements.originalTextures = document.getElementById("original-textures");
  elements.optimizedTextures = document.getElementById("optimized-textures");
  elements.originalTris = document.getElementById("original-tris");
  elements.optimizedTris = document.getElementById("optimized-tris");
  elements.originalVerts = document.getElementById("original-verts");
  elements.optimizedVerts = document.getElementById("optimized-verts");
  elements.sourceUrl = document.getElementById("source-url");
  elements.saveOriginal = document.getElementById("save-original");
  elements.saveOptimized = document.getElementById("save-optimized");
  elements.progressBar = document.getElementById("progress-bar");
  elements.busyModal = document.getElementById("busy-modal");
  elements.busyTitle = document.getElementById("busy-title");
  elements.busyMessage = document.getElementById("busy-message");
  elements.busyBarFill = document.getElementById("busy-bar-fill");
  elements.statusText = document.getElementById("status-text");
  elements.statMeshes = document.getElementById("stat-meshes");
  elements.statTris = document.getElementById("stat-tris");
  elements.statVerts = document.getElementById("stat-verts");
}

function bindEvents() {
  elements.format.addEventListener("change", renderFormatNote);
  elements.textureMode.addEventListener("change", () => {
    renderTextureModeNote();
    markOptimizedStale();
  });
  elements.profile.addEventListener("change", () => applyProfileDefaults(elements.profile.value));
  elements.ratio.addEventListener("input", renderOptimizationControls);
  elements.ratio.addEventListener("change", maybeGenerateLodPreview);
  elements.error.addEventListener("input", renderOptimizationControls);
  elements.error.addEventListener("change", maybeGenerateLodPreview);
  elements.lockBorder.addEventListener("change", () => {
    markOptimizedStale();
    maybeGenerateLodPreview();
  });
  elements.quantize.addEventListener("change", () => {
    markOptimizedStale();
    maybeGenerateLodPreview();
  });
  elements.generateOptimized.addEventListener("click", generateOptimizedModel);
  elements.saveOriginal.addEventListener("click", () => saveModel("original"));
  elements.saveOptimized.addEventListener("click", () => saveModel("optimized"));
  elements.viewOriginal.addEventListener("click", () => setPreviewMode("original"));
  elements.viewOptimized.addEventListener("click", () => setPreviewMode("optimized"));
  elements.resetCamera.addEventListener("click", () => {
    if (activeRoot) {
      fitCameraToObject(activeRoot);
    }
  });
  elements.toggleWireframe.addEventListener("click", () => {
    wireframeEnabled = !wireframeEnabled;
    elements.toggleWireframe.classList.toggle("is-active", wireframeEnabled);
    setPreviewWireframe(wireframeEnabled);
  });
  window.addEventListener("resize", resizeRenderer);
}

async function init() {
  if (!exportSessionId && (!Number.isInteger(sourceTabId) || sourceTabId <= 0)) {
    throw new Error("Open Export Studio from the extension popup on a Meshy viewer tab.");
  }

  initPreviewScene();
  applyProfileDefaults("balanced", { resetOptimized: false });
  renderFormatNote();
  renderTextureModeNote();
  setStatus(exportSessionId ? "Reading prepared export session..." : "Reading captured GLB from Meshy tab...");

  const loaded = await fetchCapturedModel();
  capturedModel = loaded.model;
  originalArrayBuffer = loaded.arrayBuffer;
  renderCapturedModel();

  setStatus("Parsing original GLB...");
  setProgress(75);
  const original = await parseGltf(originalArrayBuffer);
  originalRoot = original.scene || original.scenes?.[0];
  if (!originalRoot) {
    throw new Error("The captured GLB does not contain a scene.");
  }

  originalStats = computeSceneStats(originalRoot, originalArrayBuffer.byteLength);
  setPreviewMode("original", { fit: true });
  renderAllStats();
  setControlsEnabled(true);
  setProgress(100);
  window.__MESHY_EXPORT_STUDIO_READY__ = true;
  setStatus("Ready. Move the target slider to generate an LOD preview, or click Generate Optimized.");
}

async function fetchCapturedModel() {
  let offset = 0;
  let target = null;
  let model = null;

  while (true) {
    const response = await requestCapturedModelChunk(offset);
    if (!response?.ok) {
      throw new Error(response?.error || "Could not read captured model from the Meshy tab.");
    }

    const chunk = response.chunk;
    if (!chunk || !Number.isFinite(chunk.totalSize)) {
      throw new Error("The Meshy tab returned an invalid model chunk.");
    }

    if (!target) {
      target = new Uint8Array(chunk.totalSize);
      model = chunk.model || null;
      renderDownloadShell(model, chunk.totalSize);
    }

    const bytes = base64ToBytes(chunk.base64 || "");
    target.set(bytes, chunk.offset || 0);
    offset = (chunk.offset || 0) + bytes.byteLength;
    setProgress(Math.min(70, Math.round((offset / Math.max(1, chunk.totalSize)) * 70)));
    setStatus(`Reading captured model: ${formatBytes(offset)} / ${formatBytes(chunk.totalSize)}`);

    if (chunk.done) {
      break;
    }

    if (bytes.byteLength === 0) {
      throw new Error("The Meshy tab returned an empty chunk before the model was complete.");
    }
  }

  return {
    model,
    arrayBuffer: target.buffer
  };
}

async function requestCapturedModelChunk(offset) {
  if (exportSessionId) {
    const sessionResponse = await sendRuntimeMessage({
      type: "GET_EXPORT_SESSION_CHUNK",
      payload: {
        sessionId: exportSessionId,
        offset,
        length: CHUNK_SIZE
      }
    });

    if (sessionResponse?.ok || !Number.isInteger(sourceTabId) || sourceTabId <= 0) {
      return sessionResponse;
    }

    console.warn("Prepared export session failed; falling back to Meshy tab bridge.", sessionResponse?.error);
  }

  return sendRuntimeMessage({
    type: "GET_CAPTURED_MODEL_CHUNK",
    payload: {
      sourceTabId,
      modelId: requestedModelId,
      offset,
      length: CHUNK_SIZE
    }
  });
}

async function generateOptimizedModel() {
  if (!originalArrayBuffer || isBusy) {
    return;
  }

  setBusy(true);
  setOptimizedState(null);
  renderAllStats();
  setValidation("Generating optimized GLB...", "neutral");
  showBusyModal("Generating LOD Preview", "Running glTF Transform + meshoptimizer...");
  startProgressPulse(18, 88);
  setStatus("Running glTF Transform + meshoptimizer in worker...");

  try {
    const options = getOptimizationOptions();
    const result = await runOptimizationWorker(originalArrayBuffer, options);
    stopProgressPulse();

    if (!result.ok || !(result.arrayBuffer instanceof ArrayBuffer) || result.arrayBuffer.byteLength <= 0) {
      throw new Error(result.error || "Optimizer did not return a GLB.");
    }

    setProgress(90);
    setBusyModalProgress(90, "Validating optimized preview...");
    setStatus("Validating optimized GLB...");
    optimizedArrayBuffer = result.arrayBuffer;
    optimizationWorkerStats = {
      before: result.before || null,
      after: result.after || null,
      report: result.report || null,
      options: result.options || options
    };

    const optimized = await parseGltf(optimizedArrayBuffer);
    optimizedRoot = optimized.scene || optimized.scenes?.[0];
    if (!optimizedRoot) {
      throw new Error("Optimized GLB does not contain a scene.");
    }

    optimizedStats = computeSceneStats(optimizedRoot, optimizedArrayBuffer.byteLength, optimizationWorkerStats.after);
    validationResult = validateOptimizedModel(originalStats, optimizedStats, originalRoot, optimizedRoot);
    if (!validationResult.ok) {
      setOptimizedState(null);
      throw new Error(validationResult.errors.join(" "));
    }

    elements.viewOptimized.disabled = false;
    renderAllStats();
    setPreviewMode("optimized", { fit: true });
    setValidation(renderValidationMessage(validationResult), validationResult.warnings.length ? "warning" : "valid");
    setProgress(100);
    hideBusyModal();
    setStatus(`Optimized GLB ready (${getOptimizedVariantLabel()}): ${formatBytes(originalArrayBuffer.byteLength)} -> ${formatBytes(optimizedArrayBuffer.byteLength)}.`);
  } catch (error) {
    stopProgressPulse();
    hideBusyModal();
    setProgress(0);
    setValidation(error.message || String(error), "error");
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function maybeGenerateLodPreview() {
  if (!originalArrayBuffer || isBusy || elements.profile.value === "cleanup") {
    return;
  }
  await generateOptimizedModel();
}

function runOptimizationWorker(arrayBuffer, options) {
  return new Promise((resolve) => {
    const worker = new Worker("optimize-worker.js");
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timeout = window.setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, error: "Optimization timed out." });
    }, 5 * 60 * 1000);

    worker.addEventListener("message", (event) => {
      if (event.data?.id && event.data.id !== id) {
        return;
      }
      window.clearTimeout(timeout);
      worker.terminate();
      resolve(event.data || { ok: false, error: "Optimizer returned no data." });
    });

    worker.addEventListener("error", (event) => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve({ ok: false, error: event.message || "Optimization worker failed." });
    });

    const workerBuffer = arrayBuffer.slice(0);
    worker.postMessage({
      id,
      type: "OPTIMIZE_GLB",
      arrayBuffer: workerBuffer,
      options
    }, [workerBuffer]);
  });
}

async function saveModel(mode) {
  if (isBusy) {
    return;
  }

  const format = elements.format.value === "obj" ? "obj" : "glb";
  const isOptimized = mode === "optimized";
  const root = isOptimized ? optimizedRoot : originalRoot;
  const buffer = isOptimized ? optimizedArrayBuffer : originalArrayBuffer;

  if (!root || !buffer) {
    setStatus(isOptimized ? "Generate and validate an optimized model first." : "Original model is not loaded.", true);
    return;
  }

  if (isOptimized && !validationResult?.ok) {
    setStatus("Optimized model is not validated yet.", true);
    return;
  }

  setBusy(true);
  setProgress(20);
  showBusyModal("Saving Model", `Saving ${isOptimized ? "optimized" : "original"} ${format.toUpperCase()}...`);
  setStatus(`Saving ${isOptimized ? "optimized" : "original"} ${format.toUpperCase()}...`);

  try {
    const filename = buildOutputFilename(capturedModel?.filename, format, isOptimized, getOptimizedFilenameSuffix());
    const blob = format === "glb"
      ? new Blob([buffer], { type: "model/gltf-binary" })
      : exportObj(root);
    downloadBlob(blob, filename);
    setProgress(100);
    setBusyModalProgress(100, "Download started.");
    setStatus(`Saved ${filename} (${formatBytes(blob.size)}).`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    window.setTimeout(hideBusyModal, 250);
    setBusy(false);
  }
}

function parseGltf(arrayBuffer) {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer.slice(0), "", resolve, reject);
  });
}

function initPreviewScene() {
  renderer = new THREE.WebGLRenderer({
    canvas: elements.canvas,
    antialias: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(getPreviewBackground());

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(3, 2, 4);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = false;

  const ambient = new THREE.HemisphereLight(0xffffff, 0x5f6670, 2.2);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(4, 6, 5);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xbfd2ff, 1.2);
  fill.position.set(-5, 3, -4);
  scene.add(fill);

  resizeRenderer();
  animate();
}

function animate() {
  animationFrame = window.requestAnimationFrame(animate);
  controls?.update();
  renderer?.render(scene, camera);
}

function resizeRenderer() {
  if (!renderer || !camera) {
    return;
  }

  const width = Math.max(1, elements.canvas.clientWidth);
  const height = Math.max(1, elements.canvas.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function setPreviewMode(mode, options = {}) {
  const nextRoot = mode === "optimized" ? optimizedRoot : originalRoot;
  if (!nextRoot) {
    return;
  }

  if (activeRoot) {
    scene.remove(activeRoot);
  }

  activeMode = mode;
  activeRoot = nextRoot.clone(true);
  scene.add(activeRoot);
  setPreviewWireframe(wireframeEnabled);
  elements.viewOriginal.classList.toggle("is-active", activeMode === "original");
  elements.viewOptimized.classList.toggle("is-active", activeMode === "optimized");
  renderOverlayStats(mode === "optimized" ? optimizedStats : originalStats);

  if (options.fit !== false) {
    fitCameraToObject(activeRoot);
  }
}

function fitCameraToObject(root) {
  if (!root || !camera || !controls) {
    return;
  }

  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    camera.position.set(3, 2, 4);
    controls.target.set(0, 0, 0);
    controls.update();
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.1);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.45;
  const direction = new THREE.Vector3(0.85, 0.55, 1).normalize();

  camera.near = Math.max(0.01, distance / 100);
  camera.far = Math.max(1000, distance * 100);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.maxDistance = distance * 8;
  controls.update();
}

function exportObj(root) {
  const exporter = new OBJExporter();
  const text = exporter.parse(root);
  return new Blob([text], { type: "text/plain;charset=utf-8" });
}

function renderCapturedModel() {
  const taskName = capturedModel?.taskName || capturedModel?.filename || "Captured Meshy model";
  elements.modelTitle.textContent = taskName;
  elements.modelSubtitle.textContent = [
    capturedModel?.source ? `Captured from ${capturedModel.source}` : "Captured loader output",
    originalArrayBuffer ? formatBytes(originalArrayBuffer.byteLength) : "",
    capturedModel?.taskId || ""
  ].filter(Boolean).join(" - ");
  elements.sourceUrl.value = capturedModel?.encryptedUrl || capturedModel?.sourceUrl || "";
}

function renderDownloadShell(model, totalSize) {
  elements.modelTitle.textContent = model?.taskName || model?.filename || "Captured Meshy model";
  elements.modelSubtitle.textContent = `Reading ${formatBytes(totalSize)} from the Meshy tab`;
  elements.sourceUrl.value = model?.encryptedUrl || model?.sourceUrl || "";
}

function renderOverlayStats(stats) {
  elements.statMeshes.textContent = stats ? formatNumber(stats.meshCount) : "-";
  elements.statTris.textContent = stats ? formatNumber(stats.triangleCount) : "-";
  elements.statVerts.textContent = stats ? formatNumber(stats.vertexCount) : "-";
}

function renderAllStats() {
  renderStatsColumn("original", originalStats);
  renderStatsColumn("optimized", optimizedStats);
  renderOverlayStats(activeMode === "optimized" ? optimizedStats : originalStats);
}

function renderStatsColumn(prefix, stats) {
  elements[`${prefix}Total`].textContent = stats ? formatBytes(stats.totalBytes) : "-";
  elements[`${prefix}Geometry`].textContent = stats ? formatBytes(stats.geometryBytes) : "-";
  elements[`${prefix}Textures`].textContent = stats ? formatBytes(stats.textureBytes) : "-";
  elements[`${prefix}Tris`].textContent = stats ? formatNumber(stats.triangleCount) : "-";
  elements[`${prefix}Verts`].textContent = stats ? formatNumber(stats.vertexCount) : "-";
}

function renderFormatNote() {
  elements.formatNote.textContent = elements.format.value === "obj"
    ? "OBJ exports geometry and UVs, but it does not preserve Meshy PBR materials like GLB."
    : "GLB is recommended for Meshy exports because it keeps embedded textures and PBR materials.";
}

function renderTextureModeNote() {
  const notes = {
    auto: "Auto generates textured and geometry-only optimized GLBs, then keeps the smaller result.",
    keep: "Keeps embedded material textures. Geometry can shrink while total GLB size still grows if textures are embedded.",
    strip: "Removes material textures for the smallest GLB. Geometry, UVs, normals, and material colors remain."
  };
  elements.textureModeNote.textContent = notes[elements.textureMode.value] || notes.auto;
}

function renderOptimizationControls() {
  elements.ratioValue.textContent = `${elements.ratio.value}%`;
  elements.errorValue.textContent = formatErrorValue(getErrorValue());
}

function applyProfileDefaults(profile, options = {}) {
  const defaults = PROFILE_DEFAULTS[profile] || PROFILE_DEFAULTS.balanced;
  elements.profile.value = profile;
  elements.ratio.value = defaults.ratio;
  elements.error.value = defaults.error;
  elements.lockBorder.checked = defaults.lockBorder;
  elements.quantize.checked = defaults.quantize;
  elements.ratio.disabled = profile === "cleanup";
  elements.error.disabled = profile === "cleanup";
  renderOptimizationControls();

  if (options.resetOptimized !== false) {
    markOptimizedStale();
    maybeGenerateLodPreview();
  }
}

function getOptimizationOptions() {
  const profile = elements.profile.value;
  return {
    profile,
    ratio: Number(elements.ratio.value) / 100,
    error: getErrorValue(),
    lockBorder: elements.lockBorder.checked,
    quantize: elements.quantize.checked,
    textureMode: elements.textureMode.value,
    topology: elements.topology.value,
    simplify: profile !== "cleanup"
  };
}

function getErrorValue() {
  return Number(elements.error.value) / 10000;
}

function formatErrorValue(value) {
  if (value <= 0) {
    return "0";
  }
  return value.toFixed(value < 0.01 ? 3 : 2);
}

function markOptimizedStale() {
  if (!optimizedArrayBuffer) {
    return;
  }

  setOptimizedState(null);
  setValidation("Optimization settings changed. Generate optimized output again.", "neutral");
  renderAllStats();
}

function setOptimizedState(next) {
  optimizedArrayBuffer = next?.arrayBuffer || null;
  optimizedRoot = next?.root || null;
  optimizedStats = next?.stats || null;
  optimizationWorkerStats = next?.workerStats || null;
  validationResult = next?.validation || null;

  if (!optimizedRoot && activeMode === "optimized" && originalRoot) {
    setPreviewMode("original", { fit: false });
  }

  elements.viewOptimized.disabled = !optimizedRoot;
  elements.saveOptimized.disabled = !optimizedRoot || !validationResult?.ok || isBusy;
}

function validateOptimizedModel(original, optimized, originalScene, optimizedScene) {
  const errors = [];
  const warnings = [];

  if (!optimized || optimized.meshCount <= 0) {
    errors.push("Optimized GLB has no meshes.");
  }
  if (!optimized || optimized.triangleCount <= 0) {
    errors.push("Optimized GLB has no triangles.");
  }
  if (!optimized || optimized.totalBytes <= 0) {
    errors.push("Optimized GLB is empty.");
  }

  if (original && optimized) {
    if (optimized.materialCount === 0 && original.materialCount > 0) {
      warnings.push("No materials were found after optimization.");
    }
    if (optimized.textureCount === 0 && original.textureCount > 0) {
      warnings.push("No textures were found after optimization.");
    }
    if (optimized.triangleCount > original.triangleCount && optimizationWorkerStats?.options?.profile !== "cleanup") {
      warnings.push("Triangle count did not decrease.");
    }
    if (optimized.totalBytes > original.totalBytes) {
      warnings.push(`Final GLB is ${formatBytes(optimized.totalBytes - original.totalBytes)} larger because remaining package payload outweighed geometry savings.`);
    }
    if (optimized.unusedAccessorBytes > 0) {
      warnings.push(`Optimized GLB still contains ${formatBytes(optimized.unusedAccessorBytes)} of unused geometry accessors.`);
    }
    if (optimizationWorkerStats?.report?.textureMode === "strip") {
      warnings.push("Optimized output is geometry-only; material texture images were removed.");
    }
    if (optimizationWorkerStats?.report?.textureMode === "auto-strip") {
      warnings.push("Auto mode selected the smaller geometry-only GLB instead of the textured GLB.");
    }
    if (optimizationWorkerStats?.report?.stripError) {
      warnings.push(`Geometry-only candidate failed: ${optimizationWorkerStats.report.stripError}`);
    }
    const variantSummary = renderVariantSummary(optimizationWorkerStats?.report?.variants);
    if (variantSummary) {
      warnings.push(variantSummary);
    }
  }

  const originalBounds = computeBounds(originalScene);
  const optimizedBounds = computeBounds(optimizedScene);
  if (originalBounds && optimizedBounds) {
    const originalSize = originalBounds.size.length();
    const optimizedSize = optimizedBounds.size.length();
    if (originalSize > 0) {
      const ratio = optimizedSize / originalSize;
      if (ratio < 0.25 || ratio > 4) {
        errors.push("Optimized model bounds differ too much from the original.");
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    originalBounds,
    optimizedBounds
  };
}

function renderValidationMessage(result) {
  const parts = ["Optimized GLB validated."];
  if (result.warnings.length) {
    parts.push(result.warnings.join(" "));
  }
  return parts.join(" ");
}

function renderVariantSummary(variants) {
  if (!variants) {
    return "";
  }

  const selected = variants.selected === "geometry" ? "geometry-only" : "textured";
  return `Auto compared textured ${formatBytes(variants.texturedBytes)} vs geometry-only ${formatBytes(variants.geometryOnlyBytes)} and selected ${selected}.`;
}

function setValidation(message, state = "neutral") {
  elements.validation.textContent = message;
  elements.validation.classList.toggle("is-valid", state === "valid" || state === "warning");
  elements.validation.classList.toggle("is-error", state === "error");
}

function setControlsEnabled(enabled) {
  elements.generateOptimized.disabled = !enabled || isBusy;
  elements.saveOriginal.disabled = !enabled || isBusy;
  elements.saveOptimized.disabled = !optimizedRoot || !validationResult?.ok || isBusy;
  elements.viewOriginal.disabled = !enabled;
  elements.viewOptimized.disabled = !optimizedRoot;
  elements.resetCamera.disabled = !enabled;
  elements.toggleWireframe.disabled = !enabled;
  controls.enabled = enabled;
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  elements.generateOptimized.disabled = nextBusy || !originalRoot;
  elements.saveOriginal.disabled = nextBusy || !originalRoot;
  elements.saveOptimized.disabled = nextBusy || !optimizedRoot || !validationResult?.ok;
  elements.format.disabled = nextBusy;
  elements.profile.disabled = nextBusy;
  elements.ratio.disabled = nextBusy || elements.profile.value === "cleanup";
  elements.error.disabled = nextBusy || elements.profile.value === "cleanup";
  elements.lockBorder.disabled = nextBusy;
  elements.quantize.disabled = nextBusy;
  elements.textureMode.disabled = nextBusy;
  elements.topology.disabled = true;
}

function setPreviewWireframe(enabled) {
  if (!activeRoot) {
    return;
  }

  activeRoot.traverse((object) => {
    if (!object?.isMesh) {
      return;
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material && "wireframe" in material) {
        material.wireframe = enabled;
      }
    }
  });
}

function computeSceneStats(root, totalBytes = 0, workerStats = null) {
  const materials = new Set();
  const textures = new Set();
  const stats = {
    totalBytes,
    meshCount: 0,
    triangleCount: 0,
    vertexCount: 0,
    materialCount: 0,
    textureCount: 0,
    geometryBytes: 0,
    textureBytes: 0
  };

  root.traverse((object) => {
    if (!object?.isMesh || !object.geometry) {
      return;
    }

    stats.meshCount += 1;
    const geometry = object.geometry;
    const geometryStats = getGeometryStats(geometry);
    stats.vertexCount += geometryStats.vertexCount;
    stats.triangleCount += geometryStats.triangleCount;
    stats.geometryBytes += geometryStats.byteLength;

    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!material) {
        continue;
      }
      materials.add(material);
      collectMaterialTextures(material, textures);
    }
  });

  stats.triangleCount = Math.floor(stats.triangleCount);
  stats.materialCount = materials.size;
  stats.textureCount = textures.size;

  if (workerStats) {
    stats.geometryBytes = workerStats.geometryBytes ?? stats.geometryBytes;
    stats.textureBytes = workerStats.textureBytes ?? Math.max(0, totalBytes - stats.geometryBytes);
    stats.unusedAccessorBytes = workerStats.unusedAccessorBytes ?? 0;
    stats.unusedAccessors = workerStats.unusedAccessors ?? 0;
  } else {
    stats.textureBytes = Math.max(0, totalBytes - stats.geometryBytes);
    stats.unusedAccessorBytes = 0;
    stats.unusedAccessors = 0;
  }

  return stats;
}

function getGeometryStats(geometry) {
  const position = geometry.getAttribute("position");
  let byteLength = geometry.index?.array?.byteLength || 0;

  for (const attribute of Object.values(geometry.attributes || {})) {
    byteLength += attribute?.array?.byteLength || 0;
  }

  return {
    vertexCount: position?.count || 0,
    triangleCount: Math.floor((geometry.index?.count || position?.count || 0) / 3),
    byteLength
  };
}

function collectMaterialTextures(material, textures) {
  const textureKeys = [
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
    "alphaMap",
    "bumpMap",
    "displacementMap"
  ];

  for (const key of textureKeys) {
    if (material[key]) {
      textures.add(material[key]);
    }
  }
}

function computeBounds(root) {
  if (!root) {
    return null;
  }

  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    return null;
  }
  return {
    box,
    size: box.getSize(new THREE.Vector3()),
    center: box.getCenter(new THREE.Vector3())
  };
}

function getOptimizedVariantLabel() {
  const mode = optimizationWorkerStats?.report?.textureMode || optimizationWorkerStats?.options?.textureMode || "";
  if (mode === "auto-strip") {
    return "auto smallest, geometry only";
  }
  if (mode === "strip") {
    return "geometry only";
  }
  if (mode === "keep") {
    return "textured";
  }
  return "optimized";
}

function getOptimizedFilenameSuffix() {
  const mode = optimizationWorkerStats?.report?.textureMode || optimizationWorkerStats?.options?.textureMode || "";
  if (mode === "auto-strip") {
    return "optimized-auto-smallest-geometry";
  }
  if (mode === "strip") {
    return "optimized-geometry";
  }
  if (mode === "keep") {
    return "optimized-textured";
  }
  return "optimized";
}

function buildOutputFilename(inputName = "", format = "glb", optimized = false, optimizedSuffix = "optimized") {
  const withoutQuery = String(inputName || "meshy-model").split(/[?#]/)[0];
  const base = withoutQuery
    .replace(/\.(glb|gltf|obj)$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim() || "meshy-model";
  return `${base}${optimized ? `-${optimizedSuffix}` : ""}.${format}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      resolve({ ok: false, error: "Extension runtime is not available." });
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response);
    });
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function startProgressPulse(start, end) {
  stopProgressPulse();
  let value = start;
  setProgress(value);
  progressTimer = window.setInterval(() => {
    value = Math.min(end, value + Math.max(1, (end - value) * 0.08));
    setProgress(value);
    setBusyModalProgress(value);
  }, 350);
}

function stopProgressPulse() {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = 0;
  }
}

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.classList.toggle("is-error", Boolean(isError));
}

function setProgress(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  elements.progressBar.style.width = `${percent}%`;
}

function showBusyModal(title, message) {
  elements.busyTitle.textContent = title;
  elements.busyMessage.textContent = message;
  elements.busyModal.hidden = false;
  setBusyModalProgress(0);
}

function hideBusyModal() {
  elements.busyModal.hidden = true;
}

function setBusyModalProgress(value, message = "") {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  elements.busyBarFill.style.width = `${percent}%`;
  if (message) {
    elements.busyMessage.textContent = message;
  }
}

function getPreviewBackground() {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? 0x111418 : 0xdfe4e5;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Math.round(Number(value || 0)));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1000 && unitIndex < units.length - 1) {
    size /= 1000;
    unitIndex += 1;
  }

  const digits = unitIndex === 0
    ? 0
    : size >= 100
      ? 0
      : size >= 10
        ? 1
        : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

window.addEventListener("beforeunload", () => {
  stopProgressPulse();
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
});
