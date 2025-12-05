import React from "react";
import ReactDOM from "react-dom";
import { App } from "./components/App";

import "./index.scss";

const container = document.getElementById("app");
if (container) {
  ReactDOM.render(<App />, container);
}
