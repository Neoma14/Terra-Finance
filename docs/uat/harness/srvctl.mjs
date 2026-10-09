import { startServer, stopServer, waitHealthy } from "./lib.mjs";
const cmd = process.argv[2];
if (cmd === "start") { startServer(process.argv[3] ?? "run"); console.log("healthy:", await waitHealthy()); }
if (cmd === "stop") { await stopServer(false); console.log("stopped"); }
if (cmd === "kill") { await stopServer(true); console.log("killed"); }
process.exit(0);
