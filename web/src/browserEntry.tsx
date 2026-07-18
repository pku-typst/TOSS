import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { BrowserBackendProvider } from "@/browserBackend/BrowserBackendProvider";
import { browserBackendConfiguration } from "@/browserBackend/browserApplicationConfiguration";
import { browserRouter } from "@/browserBackend/browserRouter";
import { queryClient } from "@/lib/queryClient";

export function startApplication() {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    window.location.reload();
  });
  const configuration = browserBackendConfiguration();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserBackendProvider configuration={configuration}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={browserRouter} />
        </QueryClientProvider>
      </BrowserBackendProvider>
    </React.StrictMode>,
  );
}
