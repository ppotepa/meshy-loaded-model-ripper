import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  prune,
  weld,
  simplify,
  quantize,
  reorder
} from "@gltf-transform/functions";
import {
  MeshoptDecoder,
  MeshoptEncoder,
  MeshoptSimplifier
} from "meshoptimizer";

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
    MeshoptEncoder.ready,
    MeshoptSimplifier.ready
  ]);

  const options = normalizeOptions(message.options || {});
  const io = new WebIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder
    });

  const document = await io.readBinary(new Uint8Array(input));
  const before = inspectDocument(document, input.byteLength);
  const transforms = [
    dedup(),
    prune(),
    weld()
  ];

  if (options.simplify && options.ratio < 0.999) {
    transforms.push(simplify({
      simplifier: MeshoptSimplifier,
      ratio: options.ratio,
      error: options.error,
      lockBorder: options.lockBorder
    }));
  }

  transforms.push(prune());
  transforms.push(reorder({ encoder: MeshoptEncoder }));

  if (options.quantize) {
    transforms.push(quantize({
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeColor: 8
    }));
  }

  await document.transform(...transforms);

  const output = await io.writeBinary(document);
  const after = inspectDocument(document, output.byteLength);

  return {
    arrayBuffer: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength),
    before,
    after,
    options
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
    simplify: input.simplify ?? profile.simplify
  };
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
