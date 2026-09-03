import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import "./styles/tokens.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
const runtimeMode =
  root.dataset.runtimeMode === "production" || root.dataset.runtimeMode === "test"
    ? root.dataset.runtimeMode
    : "local";

createRoot(root).render(
  <StrictMode>
    <App runtimeMode={runtimeMode} />
  </StrictMode>,
);
