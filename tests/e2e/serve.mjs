// Serves the static site locally: `deno task serve`, then open http://localhost:8080/demo/
import { startServer } from "./server.mjs";
const s = await startServer(8080);
console.log("Serving on " + s.url);
