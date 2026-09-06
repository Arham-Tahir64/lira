import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBackend } from "./client";
import { App } from "./App";
import "./style.css";
import { captureInvitation } from "./invitation";
captureInvitation();
const root = ReactDOM.createRoot(document.getElementById("root")!);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15000, refetchOnWindowFocus: true },
  },
});
root.render(
  <main className="boot" role="status">
    Connecting to Lira…
  </main>,
);
createBackend()
  .then((backend) =>
    root.render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          <App backend={backend} />
        </QueryClientProvider>
      </React.StrictMode>,
    ),
  )
  .catch(() =>
    root.render(
      <main className="boot">
        <h1>Lira</h1>
        <p>We couldn't connect to your workspace.</p>
        <button onClick={() => location.reload()}>Try again</button>
      </main>,
    ),
  );
