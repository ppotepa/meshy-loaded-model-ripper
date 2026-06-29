(function bootMeshyExportStudio() {
  const START_TIMEOUT_MS = 2500;

  window.addEventListener("error", (event) => {
    showBootError(event.message || "Export Studio failed to start.");
  });

  window.addEventListener("unhandledrejection", (event) => {
    showBootError(event.reason?.message || String(event.reason || "Export Studio failed to start."));
  });

  window.setTimeout(() => {
    if (!window.__MESHY_EXPORT_STUDIO_STARTED__) {
      showBootError("Export Studio did not start. Reload the extension package; the local Three.js runtime may be incomplete.");
    }
  }, START_TIMEOUT_MS);

  function showBootError(message) {
    if (window.__MESHY_EXPORT_STUDIO_READY__) {
      return;
    }

    const subtitle = document.getElementById("model-subtitle");
    const status = document.getElementById("status-text");
    if (subtitle) {
      subtitle.textContent = "Startup failed";
    }
    if (status) {
      status.textContent = message;
      status.classList.add("is-error");
    }
  }
})();
