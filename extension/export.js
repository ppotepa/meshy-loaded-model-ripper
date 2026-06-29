import * as THREE from "./vendor/three/three.module.js";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { GLTFExporter } from "./vendor/three/GLTFExporter.js";
import { OBJExporter } from "./vendor/three/OBJExporter.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import { SimplifyModifier } from "./vendor/three/SimplifyModifier.js";

window.__MESHY_EXPORT_STUDIO_STARTED__ = true;

const CHUNK_SIZE = 512 * 1024;
const params = new URLSearchParams(window.location.search);
const sourceTabId = Number(params.get("sourceTabId") || 0);
const requestedModelId = params.get("modelId") || "";

const elements = {};
let capturedModel = null;
let originalArrayBuffer = null;
let sourceRoot = null;
let previewRoot = null;
let sourceStats = null;
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let animationFrame = 0;
let wireframeEnabled = false;
let isBusy = false;

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
  elements.resetCamera = document.getElementById("reset-camera");
  elements.toggleWireframe = document.getElementById("toggle-wireframe");
  elements.format = document.getElementById("format");
  elements.formatNote = document.getElementById("format-note");
  elements.optimize = document.getElementById("optimize");
  elements.ratio = document.getElementById("ratio");
  elements.ratioValue = document.getElementById("ratio-value");
  elements.estimateTris = document.getElementById("estimate-tris");
  elements.estimateSize = document.getElementById("estimate-size");
  elements.inputSize = document.getElementById("input-size");
  elements.outputSize = document.getElementById("output-size");
  elements.sourceUrl = document.getElementById("source-url");
  elements.save = document.getElementById("save");
  elements.progressBar = document.getElementById("progress-bar");
  elements.statusText = document.getElementById("status-text");
  elements.statMeshes = document.getElementById("stat-meshes");
  elements.statTris = document.getElementById("stat-tris");
  elements.statVerts = document.getElementById("stat-verts");
}

function bindEvents() {
  elements.format.addEventListener("change", () => {
    renderFormatNote();
    renderEstimate();
  });
  elements.optimize.addEventListener("change", () => {
    elements.ratio.disabled = !elements.optimize.checked || isBusy;
    renderEstimate();
  });
  elements.ratio.addEventListener("input", renderEstimate);
  elements.save.addEventListener("click", saveModel);
  elements.resetCamera.addEventListener("click", () => {
    if (previewRoot) {
      fitCameraToObject(previewRoot);
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
  if (!Number.isInteger(sourceTabId) || sourceTabId <= 0) {
    throw new Error("Open Export Studio from the extension popup on a Meshy viewer tab.");
  }

  initPreviewScene();
  setStatus("Reading captured GLB from Meshy tab...");
  const loaded = await fetchCapturedModel();
  capturedModel = loaded.model;
  originalArrayBuffer = loaded.arrayBuffer;

  renderCapturedModel();
  setStatus("Parsing GLB...");
  setProgress(75);

  const gltf = await parseGltf(originalArrayBuffer);
  sourceRoot = gltf.scene || gltf.scenes?.[0];
  if (!sourceRoot) {
    throw new Error("The captured GLB does not contain a scene.");
  }

  sourceStats = computeSceneStats(sourceRoot);
  previewRoot = sourceRoot.clone(true);
  scene.add(previewRoot);
  renderStats();
  fitCameraToObject(previewRoot);
  setControlsEnabled(true);
  setProgress(100);
  window.__MESHY_EXPORT_STUDIO_READY__ = true;
  setStatus("Ready.");
  renderEstimate();
}

async function fetchCapturedModel() {
  let offset = 0;
  let target = null;
  let model = null;

  while (true) {
    const response = await sendRuntimeMessage({
      type: "GET_CAPTURED_MODEL_CHUNK",
      payload: {
        sourceTabId,
        modelId: requestedModelId,
        offset,
        length: CHUNK_SIZE
      }
    });

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

async function saveModel() {
  if (!sourceRoot || !sourceStats || isBusy) {
    return;
  }

  const format = elements.format.value === "obj" ? "obj" : "glb";
  const optimize = elements.optimize.checked;
  const ratio = optimize ? Number(elements.ratio.value) / 100 : 1;
  const filename = buildOutputFilename(capturedModel?.filename, format, optimize ? elements.ratio.value : "");

  setBusy(true);
  setProgress(0);
  setStatus("Preparing export scene...");

  try {
    const exportRoot = cloneForExport(sourceRoot);
    await nextFrame();

    let simplifyResult = { processed: 0, skipped: 0 };
    if (optimize && ratio < 0.995) {
      setStatus(`Optimizing mesh to ${Math.round(ratio * 100)}% target detail...`);
      setProgress(20);
      await nextFrame();
      simplifyResult = simplifyScene(exportRoot, ratio);
    }

    setProgress(65);
    setStatus(`Exporting ${format.toUpperCase()}...`);
    await nextFrame();

    const blob = format === "obj"
      ? exportObj(exportRoot)
      : await exportGlb(exportRoot);

    elements.outputSize.textContent = formatBytes(blob.size);
    downloadBlob(blob, filename);
    setProgress(100);

    const optimizedText = optimize
      ? ` Optimized ${simplifyResult.processed} mesh${simplifyResult.processed === 1 ? "" : "es"}.`
      : "";
    const skippedText = simplifyResult.skipped
      ? ` Skipped ${simplifyResult.skipped} protected mesh${simplifyResult.skipped === 1 ? "" : "es"}.`
      : "";
    setStatus(`Saved ${filename} (${formatBytes(blob.size)}).${optimizedText}${skippedText}`);
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

function cloneForExport(root) {
  const clone = root.clone(true);
  clone.traverse((object) => {
    if (!object?.isMesh) {
      return;
    }

    if (object.geometry?.clone) {
      object.geometry = object.geometry.clone();
    }

    if (Array.isArray(object.material)) {
      object.material = object.material.map(cloneMaterialForExport);
    } else {
      object.material = cloneMaterialForExport(object.material);
    }
  });
  return clone;
}

function cloneMaterialForExport(material) {
  if (!material?.clone) {
    return material;
  }

  const clone = material.clone();
  if ("wireframe" in clone) {
    clone.wireframe = false;
  }
  return clone;
}

function simplifyScene(root, ratio) {
  const modifier = new SimplifyModifier();
  const result = {
    processed: 0,
    skipped: 0
  };

  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object?.isMesh || !object.geometry) {
      return;
    }

    if (object.isSkinnedMesh || hasMorphTargets(object.geometry)) {
      result.skipped += 1;
      return;
    }

    const position = object.geometry.getAttribute("position");
    if (!position || position.count < 30) {
      return;
    }

    const removeCount = Math.floor(position.count * (1 - ratio));
    if (removeCount <= 0 || removeCount >= position.count - 3) {
      return;
    }

    try {
      const simplified = modifier.modify(object.geometry, removeCount);
      simplified.computeVertexNormals();
      object.geometry = simplified;
      result.processed += 1;
    } catch (error) {
      console.warn("Mesh simplification failed.", error);
      result.skipped += 1;
    }
  });

  return result;
}

function exportGlb(root) {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(new Blob([result], { type: "model/gltf-binary" }));
          return;
        }

        resolve(new Blob([JSON.stringify(result, null, 2)], { type: "model/gltf+json" }));
      },
      reject,
      {
        binary: true,
        onlyVisible: true,
        includeCustomExtensions: false
      }
    );
  });
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
    capturedModel?.size ? formatBytes(capturedModel.size) : "",
    capturedModel?.taskId || ""
  ].filter(Boolean).join(" - ");
  elements.inputSize.textContent = formatBytes(capturedModel?.size || originalArrayBuffer?.byteLength || 0);
  elements.sourceUrl.value = capturedModel?.encryptedUrl || capturedModel?.sourceUrl || "";
}

function renderDownloadShell(model, totalSize) {
  elements.modelTitle.textContent = model?.taskName || model?.filename || "Captured Meshy model";
  elements.modelSubtitle.textContent = `Reading ${formatBytes(totalSize)} from the Meshy tab`;
  elements.inputSize.textContent = formatBytes(totalSize);
  elements.sourceUrl.value = model?.encryptedUrl || model?.sourceUrl || "";
}

function renderStats() {
  if (!sourceStats) {
    return;
  }

  elements.statMeshes.textContent = formatNumber(sourceStats.meshCount);
  elements.statTris.textContent = formatNumber(sourceStats.triangleCount);
  elements.statVerts.textContent = formatNumber(sourceStats.vertexCount);
}

function renderEstimate() {
  const ratioPercent = Number(elements.ratio.value || 100);
  const ratio = ratioPercent / 100;
  const optimize = elements.optimize.checked;
  elements.ratioValue.textContent = `${ratioPercent}%`;
  elements.ratio.disabled = !optimize || isBusy;

  renderFormatNote();

  if (!sourceStats) {
    elements.estimateTris.textContent = "-";
    elements.estimateSize.textContent = "-";
    return;
  }

  const targetTris = optimize
    ? Math.max(1, Math.round(sourceStats.triangleCount * ratio))
    : sourceStats.triangleCount;
  const inputSize = capturedModel?.size || originalArrayBuffer?.byteLength || 0;
  const estimatedSize = optimize
    ? Math.round(inputSize * Math.max(0.2, 0.35 + ratio * 0.65))
    : inputSize;

  elements.estimateTris.textContent = formatNumber(targetTris);
  elements.estimateSize.textContent = `~${formatBytes(estimatedSize)}`;
}

function renderFormatNote() {
  elements.formatNote.textContent = elements.format.value === "obj"
    ? "OBJ exports geometry and UVs, but it does not preserve Meshy PBR materials like GLB."
    : "GLB is recommended for Meshy exports because it keeps embedded textures and PBR materials.";
}

function setControlsEnabled(enabled) {
  elements.save.disabled = !enabled || isBusy;
  elements.resetCamera.disabled = !enabled;
  elements.toggleWireframe.disabled = !enabled;
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  elements.save.disabled = nextBusy || !sourceRoot;
  elements.format.disabled = nextBusy;
  elements.optimize.disabled = nextBusy;
  elements.ratio.disabled = nextBusy || !elements.optimize.checked;
}

function setPreviewWireframe(enabled) {
  if (!previewRoot) {
    return;
  }

  previewRoot.traverse((object) => {
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

function computeSceneStats(root) {
  const materials = new Set();
  const textures = new Set();
  const stats = {
    meshCount: 0,
    triangleCount: 0,
    vertexCount: 0,
    materialCount: 0,
    textureCount: 0
  };

  root.traverse((object) => {
    if (!object?.isMesh || !object.geometry) {
      return;
    }

    stats.meshCount += 1;
    const geometry = object.geometry;
    const position = geometry.getAttribute("position");
    const index = geometry.index;
    stats.vertexCount += position?.count || 0;
    stats.triangleCount += index ? index.count / 3 : (position?.count || 0) / 3;

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
  return stats;
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

function hasMorphTargets(geometry) {
  return Boolean(
    geometry?.morphAttributes &&
    Object.values(geometry.morphAttributes).some((attributes) => Array.isArray(attributes) && attributes.length)
  );
}

function buildOutputFilename(inputName = "", format = "glb", ratio = "") {
  const withoutQuery = String(inputName || "meshy-model").split(/[?#]/)[0];
  const base = withoutQuery
    .replace(/\.(glb|gltf|obj)$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim() || "meshy-model";
  const suffix = ratio ? `-optimized-${ratio}` : "";
  return `${base}${suffix}.${format}`;
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

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.classList.toggle("is-error", Boolean(isError));
}

function setProgress(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  elements.progressBar.style.width = `${percent}%`;
}

function nextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
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
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

window.addEventListener("beforeunload", () => {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
});
