import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";

const DEFAULT_PROFILES = {
  cleanup: {
    ratio: 1,
    error: 0,
    lockBorder: true,
    quantize: false,
    simplify: false
  },
  safe: {
    ratio: 0.82,
    error: 0.001,
    lockBorder: true,
    quantize: true,
    simplify: true
  },
  balanced: {
    ratio: 0.58,
    error: 0.003,
    lockBorder: true,
    quantize: true,
    simplify: true
  },
  aggressive: {
    ratio: 0.32,
    error: 0.01,
    lockBorder: false,
    quantize: true,
    simplify: true
  }
};

self.addEventListener("message", (event) => {
  optimize(event.data)
    .then((result) => {
      self.postMessage({
        id: event.data?.id || "",
        ok: true,
        ...result
      }, [result.arrayBuffer]);
    })
    .catch((error) => {
      self.postMessage({
        id: event.data?.id || "",
        ok: false,
        error: error?.message || String(error)
      });
    });
});

async function optimize(message = {}) {
  if (message.type !== "OPTIMIZE_GLB") {
    throw new Error(`Unknown worker message: ${message.type || "missing"}`);
  }

  const input = message.arrayBuffer;
  if (!(input instanceof ArrayBuffer) || input.byteLength <= 0) {
    throw new Error("Missing GLB ArrayBuffer.");
  }

  await Promise.all([
    MeshoptDecoder.ready,
    MeshoptSimplifier.ready
  ]);

  const options = normalizeOptions(message.options || {});
  if (options.textureMode === "strip") {
    return optimizeBuffer(input, options, { stripTextures: true, textureMode: "strip" });
  }

  const keepResult = await optimizeBuffer(input, options, { stripTextures: false, textureMode: "keep" });

  if (options.textureMode === "auto" && keepResult.after.textureBytes > 0) {
    const stripResult = await optimizeBuffer(input, options, { stripTextures: true, textureMode: "auto-strip" });
    if (stripResult.arrayBuffer.byteLength < keepResult.arrayBuffer.byteLength) {
      return stripResult;
    }
  }

  return keepResult;
}

async function optimizeBuffer(input, options, outputOptions = {}) {
  const io = new WebIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder
    });

  const document = await io.readBinary(new Uint8Array(input));
  const before = inspectDocument(document, input.byteLength);
  const report = optimizeDocument(document, options);
  report.textureMode = outputOptions.textureMode || "keep";

  if (outputOptions.stripTextures) {
    report.strippedTextures = stripDocumentTextures(document);
  }

  const output = await io.writeBinary(document);
  const after = inspectDocument(document, output.byteLength);

  return {
    arrayBuffer: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength),
    before,
    after,
    report,
    options: {
      ...options,
      textureMode: report.textureMode
    }
  };
}

function normalizeOptions(input = {}) {
  const profile = DEFAULT_PROFILES[input.profile] || DEFAULT_PROFILES.balanced;
  const ratio = clampNumber(input.ratio ?? profile.ratio, 0.05, 1, profile.ratio);
  const error = clampNumber(input.error ?? profile.error, 0, 0.25, profile.error);
  return {
    profile: input.profile || "balanced",
    ratio,
    error,
    lockBorder: input.lockBorder ?? profile.lockBorder,
    quantize: input.quantize ?? profile.quantize,
    textureMode: ["auto", "keep", "strip"].includes(input.textureMode) ? input.textureMode : "auto",
    topology: input.topology === "quads" ? "quads" : "triangles",
    simplify: input.simplify ?? profile.simplify
  };
}

function optimizeDocument(document, options) {
  const report = {
    simplifiedPrimitives: 0,
    skippedPrimitives: 0,
    inputTriangles: 0,
    outputTriangles: 0
  };

  if (!options.simplify || options.ratio >= 0.999) {
    return report;
  }

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const result = simplifyPrimitive(document, primitive, options);
      report.inputTriangles += result.inputTriangles;
      report.outputTriangles += result.outputTriangles;

      if (result.changed) {
        report.simplifiedPrimitives += 1;
      } else {
        report.skippedPrimitives += 1;
      }
    }
  }

  return report;
}

function stripDocumentTextures(document) {
  const root = document.getRoot();
  const removed = {
    textureSlots: 0,
    textures: 0
  };

  for (const material of root.listMaterials()) {
    const setters = [
      "setBaseColorTexture",
      "setEmissiveTexture",
      "setNormalTexture",
      "setOcclusionTexture",
      "setMetallicRoughnessTexture"
    ];

    for (const setter of setters) {
      if (typeof material[setter] === "function") {
        material[setter](null);
        removed.textureSlots += 1;
      }
    }
  }

  for (const texture of root.listTextures()) {
    texture.setImage(null);
    texture.dispose();
    removed.textures += 1;
  }

  return removed;
}

function simplifyPrimitive(document, primitive, options) {
  const position = primitive.getAttribute("POSITION");
  const mode = primitive.getMode();

  if (!position || mode !== 4) {
    return {
      changed: false,
      inputTriangles: getPrimitiveTriangleCount(primitive),
      outputTriangles: getPrimitiveTriangleCount(primitive)
    };
  }

  const sourceIndices = getPrimitiveIndices(primitive, position.getCount());
  const inputTriangles = Math.floor(sourceIndices.length / 3);
  const targetIndexCount = Math.max(3, Math.floor(sourceIndices.length * options.ratio / 3) * 3);

  if (targetIndexCount >= sourceIndices.length) {
    return {
      changed: false,
      inputTriangles,
      outputTriangles: inputTriangles
    };
  }

  const positionArray = getSimplifierPositionArray(position);
  const [simplifiedIndices] = MeshoptSimplifier.simplify(
    sourceIndices,
    positionArray,
    3,
    targetIndexCount,
    options.error,
    options.lockBorder ? ["LockBorder"] : []
  );

  if (!simplifiedIndices || simplifiedIndices.length < 3) {
    return {
      changed: false,
      inputTriangles,
      outputTriangles: inputTriangles
    };
  }

  const oldIndices = primitive.getIndices();
  const compaction = createVertexCompaction(simplifiedIndices);
  primitive.setIndices(document.createAccessor()
    .setArray(compaction.indices)
    .setType("SCALAR"));
  disposeIfExclusive(oldIndices);

  for (const semantic of primitive.listSemantics()) {
    const accessor = primitive.getAttribute(semantic);
    primitive.setAttribute(semantic, compactAccessor(document, accessor, compaction));
    disposeIfExclusive(accessor);
  }

  for (const target of primitive.listTargets()) {
    for (const semantic of target.listSemantics()) {
      const accessor = target.getAttribute(semantic);
      target.setAttribute(semantic, compactAccessor(document, accessor, compaction));
      disposeIfExclusive(accessor);
    }
  }

  return {
    changed: true,
    inputTriangles,
    outputTriangles: Math.floor(compaction.indices.length / 3)
  };
}

function getPrimitiveTriangleCount(primitive) {
  const indices = primitive.getIndices();
  const position = primitive.getAttribute("POSITION");
  return Math.floor((indices?.getCount() || position?.getCount() || 0) / 3);
}

function getPrimitiveIndices(primitive, vertexCount) {
  const indices = primitive.getIndices()?.getArray();
  if (indices) {
    return indices instanceof Uint32Array ? indices : new Uint32Array(indices);
  }

  const sequential = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) {
    sequential[index] = index;
  }

  return sequential;
}

function getSimplifierPositionArray(position) {
  const array = position.getArray();
  if (array instanceof Float32Array && position.getElementSize() === 3) {
    return array;
  }

  const count = position.getCount();
  const output = new Float32Array(count * 3);
  const element = [];

  for (let index = 0; index < count; index += 1) {
    position.getElement(index, element);
    output[index * 3] = Number(element[0]) || 0;
    output[index * 3 + 1] = Number(element[1]) || 0;
    output[index * 3 + 2] = Number(element[2]) || 0;
  }

  return output;
}

function createVertexCompaction(indices) {
  const oldToNew = new Map();
  const orderedOldIndices = [];
  const IndexArray = indices.length <= 65535 ? Uint16Array : Uint32Array;
  const compactedIndices = new IndexArray(indices.length);

  for (let index = 0; index < indices.length; index += 1) {
    const oldIndex = indices[index];
    let newIndex = oldToNew.get(oldIndex);

    if (newIndex === undefined) {
      newIndex = orderedOldIndices.length;
      oldToNew.set(oldIndex, newIndex);
      orderedOldIndices.push(oldIndex);
    }

    compactedIndices[index] = newIndex;
  }

  return {
    indices: compactedIndices,
    oldToNew,
    orderedOldIndices
  };
}

function compactAccessor(document, accessor, compaction) {
  const sourceArray = accessor.getArray();
  const elementSize = accessor.getElementSize();
  const TargetArray = sourceArray.constructor;
  const targetArray = new TargetArray(compaction.orderedOldIndices.length * elementSize);

  for (let newIndex = 0; newIndex < compaction.orderedOldIndices.length; newIndex += 1) {
    const oldIndex = compaction.orderedOldIndices[newIndex];
    const sourceOffset = oldIndex * elementSize;
    const targetOffset = newIndex * elementSize;

    for (let component = 0; component < elementSize; component += 1) {
      targetArray[targetOffset + component] = sourceArray[sourceOffset + component];
    }
  }

  return document.createAccessor(accessor.getName())
    .setArray(targetArray)
    .setType(accessor.getType())
    .setNormalized(accessor.getNormalized());
}

function disposeIfExclusive(property) {
  if (property && property.listParents().length === 0) {
    property.dispose();
  }
}

function inspectDocument(document, totalBytes = 0) {
  const root = document.getRoot();
  const stats = {
    totalBytes,
    geometryBytes: 0,
    textureBytes: 0,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    primitives: 0,
    vertices: 0,
    triangles: 0,
    animations: root.listAnimations().length,
    skins: root.listSkins().length
  };

  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      stats.primitives += 1;
      const indices = primitive.getIndices();
      const position = primitive.getAttribute("POSITION");
      const vertexCount = position?.getCount() || 0;
      const indexCount = indices?.getCount() || 0;
      stats.vertices += vertexCount;
      stats.triangles += Math.floor((indexCount || vertexCount) / 3);

      if (indices) {
        stats.geometryBytes += getAccessorByteLength(indices);
      }

      for (const semantic of primitive.listSemantics()) {
        const accessor = primitive.getAttribute(semantic);
        stats.geometryBytes += getAccessorByteLength(accessor);
      }
    }
  }

  for (const texture of root.listTextures()) {
    const image = texture.getImage();
    if (image) {
      stats.textureBytes += image.byteLength || 0;
    }
  }

  return stats;
}

function getAccessorByteLength(accessor) {
  const array = accessor?.getArray?.();
  return array?.byteLength || 0;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
