import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { queryClient } from "@/lib/queryClient";
import { router } from "@/router";
import "@nvidia-elements/themes/fonts/inter.css";
import "@fontsource-variable/noto-sans-sc/index.css";
import "@nvidia-elements/themes/index.css";
import "@nvidia-elements/themes/compact.css";
import "@nvidia-elements/styles/typography.css";
import "@nvidia-elements/styles/layout.css";
import "@nvidia-elements/styles/labs/layout-viewport.css";
import "@/elements";
import "@/design-tokens.css";
import "@/design-system.css";
import "@/styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
