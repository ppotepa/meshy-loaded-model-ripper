# Meshy Loaded Model Ripper Extension

This directory is the unpacked MV3 extension. Load this exact folder in Chrome or Edge developer mode.

## What This Extension Does

It captures the decrypted GLB payload created while Meshy loads an encrypted `model.meshy` file into the viewer. Once a model is captured, the popup can either quick-save the raw GLB or open Export Studio.

Export Studio provides:

- Three.js preview of the captured model,
- original and optimized preview modes,
- `GLB` and `OBJ` output selection,
- LOD-style target slider that generates optimized GLB variants after slider release,
- glTF Transform + meshoptimizer optimization in a Web Worker,
- progress modal while optimized output is generated and validated,
- original vs optimized MB, geometry MB, texture MB, triangle, and vertex stats.

## Hook Path

```txt
fetch model.meshy
  -> decrypt worker /resource/decrypt/loader-worker.min.js
  -> worker message type=process success data=<decrypted GLB ArrayBuffer>
  -> page hook stores the bytes and a blob URL
  -> popup and Export Studio request that captured model through the extension bridge
```

The hook runs in the page `MAIN` world through `page-hook.js`. `content.js` forwards state and chunk requests between the page and extension. `background.js` injects scripts when needed, prepares Export Studio sessions, and polls detected task status. `optimize-worker.js` is a bundled worker generated from `src/optimize-worker-source.js`.

## Local Load

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Click `Load unpacked`.
4. Select this `extension` directory.
5. Reload the Meshy viewer tab.
6. Open a model, then open the extension popup.

If the popup shows a task but no loaded model, reload the Meshy tab and open the model again so the `document_start` hook is active before the decrypt worker starts.
