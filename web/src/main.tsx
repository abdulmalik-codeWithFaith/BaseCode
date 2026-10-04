import React from "react";
import ReactDOM from "react-dom/client";
import "./monaco-setup";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
