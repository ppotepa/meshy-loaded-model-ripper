# Meshy Loaded Model Ripper

Chrome/Edge MV3 extension for first-party debugging of the Meshy viewer loader pipeline.

The extension saves the GLB payload that the Meshy web app produces while loading an encrypted `model.meshy` file into the viewport. It is intentionally scoped to the Meshy page loader path: it does not call Meshy official export/download endpoints, and it does not attempt generic WebGL frame or buffer scraping.

## What It Does

- Detects Meshy task metadata from first-party task API responses.
- Watches encrypted `model.meshy` requests.
- Hooks the Meshy decrypt worker at `/resource/decrypt/loader-worker.min.js`.
- Captures successful worker `process` responses containing the decrypted GLB `ArrayBuffer`.
- Stores the captured GLB as a page-owned `blob:` URL.
- Lets the popup save that loaded GLB after the viewer finishes loading the model.

## How It Works

```txt
Meshy viewer requests model.meshy
  -> page-hook sees the encrypted model URL
  -> Meshy decrypt worker receives type=process
  -> worker returns decrypted GLB ArrayBuffer
  -> page-hook copies the GLB into a Blob
  -> popup enables Save Loaded GLB
  -> page-side download anchor saves the Blob
```

The main hook lives in `extension/page-hook.js`. It runs in the page `MAIN` world at `document_start`, so it can wrap browser APIs used by the bundled Meshy application. `extension/content.js` bridges page state into the extension popup. `extension/background.js` injects the hook when needed and keeps optional task status polling.

## Project Layout

```txt
extension/
  manifest.json      MV3 manifest
  page-hook.js       page MAIN-world loader/decrypt hook
  content.js         isolated-world bridge between page and extension
  background.js      service worker and optional task polling
  popup.html         extension popup UI
  popup.js           popup state and save action
  popup.css          popup styling
build.ps1            creates a ZIP package in dist/
buid.ps1             backwards-compatible alias for build.ps1
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
5. Click `Save Loaded GLB`.

If the popup shows task metadata but the save button is disabled, the extension has seen the task but has not yet captured the decrypted worker response. Reload the Meshy tab and open the model again so the `document_start` hook is active before the decrypt worker starts.

## Build

```powershell
.\build.ps1
```

The package is written to `dist/meshy-loaded-model-ripper-v<version>.zip`.

The typo-compatible wrapper also works:

```powershell
.\buid.ps1
```

## Scope

This project is for authorized first-party debugging and local inspection of the Meshy viewer load path. It should not be extended into a universal WebGL ripper or used to bypass product policy.
