# Meshy Loaded Model Ripper Extension

This directory contains the MV3 extension files. See the repository root README for the full project overview.

The extension has one path: it saves the GLB produced while Meshy loads an encrypted `model.meshy` file into the viewer. It does not call official export endpoints and it does not try to be a generic WebGL ripper.

## Load Locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Load unpacked extension from this `extension` directory.
4. Open a Meshy viewer/workspace page and wait for the model to load.
5. Open the extension popup and click `Save Loaded GLB`.

## Hook Path

`page-hook.js` runs in the page `MAIN` world and hooks the loader pipeline:

```txt
fetch model.meshy
  -> decrypt worker /resource/decrypt/loader-worker.min.js
  -> worker message type=process success data=<decrypted GLB ArrayBuffer>
  -> page hook stores its own blob: URL
  -> popup saves that blob through a page-side anchor click
```

The useful capture point is the decrypt worker response. The main Meshy viewport loader parses the decrypted ArrayBuffer directly with `GLTFLoader.parse`, so `URL.createObjectURL` is not guaranteed to happen for the main viewer path.

The hook also watches:

- task API responses for task/name/status context,
- plain GLB/GLTF blobs as a fallback,
- global `GLTFLoader`/`THREE.Object3D` only when those constructors are exposed globally.

## Background Worker

`background.js` only injects the page hook and keeps optional task status polling for detected tasks. Downloading the loaded GLB is handled in the page context because the captured artifact is a page-owned `blob:` URL.

## Packaging

Run:

```powershell
.\build.ps1
```

or:

```powershell
.\buid.ps1
```

The ZIP is written to the repository-level `dist` directory.
