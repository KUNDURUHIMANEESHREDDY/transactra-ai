import React from "react";
import {createRoot} from "react-dom/client";
import App from "./App";
import Dashboard from "./Dashboard";
import "./styles.css";
const showPayments=new URLSearchParams(window.location.search).get("view")==="payments";
createRoot(document.getElementById("root")!).render(<React.StrictMode>{showPayments?<App/>:<Dashboard/>}</React.StrictMode>);
