// Local static server for the website. Run: `deno task serve` (or `deno serve -A server.ts`),
// then open http://localhost:8080/demo/
import { serveDir } from "jsr:@std/http@1/file-server";

export default {
  fetch(req: Request): Promise<Response> {
    return serveDir(req, { fsRoot: ".", quiet: true });
  },
} satisfies Deno.ServeDefaultExport;
