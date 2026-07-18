import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { CoreBackendProvider } from "@/composition/CoreBackendProvider";
import { handleLazyChunkLoadFailure } from "@/lib/protocolCompatibility";
import { queryClient } from "@/lib/queryClient";
import { router } from "@/router";

export function startApplication() {
  window.addEventListener("vite:preloadError", handleLazyChunkLoadFailure);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <CoreBackendProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </CoreBackendProvider>
    </React.StrictMode>,
  );

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    });
  }
}
