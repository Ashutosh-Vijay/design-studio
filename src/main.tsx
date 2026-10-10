import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, savedTheme } from "./theme";
import "./index.css";

const t = savedTheme();
applyTheme(t.pref, t.accent);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
