# Meshy Loaded Model Ripper

Chrome/Edge MV3 extension for authorized first-party inspection of the Meshy viewer loader pipeline.

The extension captures the decrypted GLB bytes produced while Meshy loads an encrypted `model.meshy` file into the viewport. It can quick-save the raw loaded GLB, or open an Export Studio with a WebGL preview, output format selection, and optional mesh simplification.

It does not call Meshy official export endpoints and it does not attempt generic WebGL frame or GPU buffer scraping.

## Features

- Detects Meshy task metadata from first-party task API responses.
- Watches encrypted `model.meshy` requests.
- Hooks the Meshy decrypt worker at `/resource/decrypt/loader-worker.min.js`.
- Captures successful worker `process` responses containing decrypted GLB `ArrayBuffer` data.
- Shows model/task/worker status in the extension popup.
- Opens Export Studio for the captured model.
- Previews the captured model with Three.js and orbit controls.
- Saves as `GLB` or `OBJ`.
- Optionally simplifies mesh geometry with a target-detail slider during save.
- Shows target triangle count, approximate MB before export, and exact saved MB after export.
- Keeps optional background task polling for detected jobs.

## How It Works

```txt
Meshy viewer requests model.meshy
  -> page-hook sees the encrypted model URL
  -> Meshy decrypt worker receives type=process
  -> worker returns decrypted GLB ArrayBuffer
  -> page-hook stores the bytes and a page-owned blob URL
  -> popup shows the loaded model
  -> Export Studio reads the bytes in chunks through the extension bridge
  -> Three.js previews and exports GLB or OBJ
```

The useful capture point is the decrypt worker response. The viewer parses the decrypted buffer before placing the model in the scene, so this is more reliable than trying to read the viewport after rendering.

## Project Layout

```txt
extension/
  manifest.json              MV3 manifest
  page-hook.js               MAIN-world loader/decrypt hook
  content.js                 isolated-world bridge between page and extension
  background.js              service worker, task polling, chunk relay
  popup.html/css/js          popup status and quick actions
  export.html/css/js         Export Studio preview/export UI
  vendor/three/              vendored Three.js modules used by Export Studio
build.ps1                    creates a ZIP package in dist/
buid.ps1                     backwards-compatible alias for build.ps1
package.json                 syntax check and build scripts
```

## Install Locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Click `Load unpacked`.
4. Select the `extension` directory.
5. Reload the Meshy viewer tab after installing or updating the extension.

## Use

1. Open a Meshy workspace/viewer page.
2. Open or reload a model so `model.meshy` is fetched and decrypted.
3. Open the extension popup.
4. Wait for the state to become `GLB ready`.
5. Click `Open Export Studio`.
6. Preview the model, choose `GLB` or `OBJ`, optionally enable `Optimize mesh`, then click `Save`.

`Quick Save GLB` remains available in the popup when you only want the raw loaded GLB without preview or optimization.

## Build

```powershell
npm install
npm run check
npm run build
```

The package is written to `dist/meshy-loaded-model-ripper-v<version>.zip`.

The typo-compatible wrapper also works:

```powershell
.\buid.ps1
```

## Notes

- `GLB` is the recommended output because it preserves embedded textures and PBR materials.
- `OBJ` is useful for geometry workflows but does not preserve Meshy PBR material data.
- Mesh optimization uses a fast export-time triangle decimator on a clone of the captured model.
- The optimizer preserves vertex attributes, UVs, normals, and material groups where possible.
- Skinned or morph-target meshes are skipped during simplification to avoid corrupting animated geometry.
- The MB estimate is approximate; the actual saved MB is measured from the generated file blob after export.
- The captured model is kept in the Meshy tab page hook for a limited time, so keep that tab open while using Export Studio.

## Scope

This project is for authorized first-party debugging and local inspection of the Meshy viewer load path. It should not be extended into a universal WebGL ripper or used to bypass product policy.
