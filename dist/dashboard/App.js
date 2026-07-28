"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.App = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const store_1 = require("./store");
const Header_1 = require("./components/Header");
const ControlCenter_1 = require("./components/ControlCenter");
const AiTelemetry_1 = require("./components/AiTelemetry");
const ExecutionView_1 = require("./components/ExecutionView");
const App = () => {
    (0, react_1.useEffect)(() => {
        // Initialize WebWorker connection to Node.js telemetry server on port 8080
        const wsHost = window.location.hostname || "localhost";
        (0, store_1.initTelemetryWorker)(`ws://${wsHost}:8080`);
    }, []);
    return ((0, jsx_runtime_1.jsxs)("div", { className: "min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans", children: [(0, jsx_runtime_1.jsx)(Header_1.Header, {}), (0, jsx_runtime_1.jsxs)("main", { className: "flex-1 p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-[1800px] w-full mx-auto", children: [(0, jsx_runtime_1.jsx)("div", { className: "space-y-6", children: (0, jsx_runtime_1.jsx)(ControlCenter_1.ControlCenter, {}) }), (0, jsx_runtime_1.jsx)("div", { className: "space-y-6", children: (0, jsx_runtime_1.jsx)(AiTelemetry_1.AiTelemetry, {}) }), (0, jsx_runtime_1.jsx)("div", { className: "space-y-6", children: (0, jsx_runtime_1.jsx)(ExecutionView_1.ExecutionView, {}) })] })] }));
};
exports.App = App;
exports.default = exports.App;
