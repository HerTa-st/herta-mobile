import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "./App.tsx";
import "./styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root 不见了");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>
);
