import { Container, type OutboundHandlerContext } from "@cloudflare/containers";
import { publishArtifact, type R2PublicationBucket } from "./r2-publication.ts";

interface MaterializerEnvironment {
  ARTIFACTS: R2PublicationBucket;
}

/** Hosts the isolated native materializer for one active package job. */
export class MaterializerContainer extends Container<MaterializerEnvironment> {
  defaultPort = 8080;
  pingEndpoint = "localhost/health";
  sleepAfter = "1m";
  enableInternet = false;
  allowedHosts = ["github.internal", "artifacts.r2"];

  static outboundByHost = {
    "github.internal": (request: Request) => proxyGitHubRequest(request),
    "artifacts.r2": (request: Request, env: MaterializerEnvironment, _context: OutboundHandlerContext) =>
      publishArtifact(env.ARTIFACTS, request),
  };
}

async function proxyGitHubRequest(request: Request): Promise<Response> {
  const host = request.headers.get("x-jsrproxy-github-host");
  if (host !== "api.github.com" && host !== "codeload.github.com") {
    return new Response("invalid GitHub host", { status: 400 });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("x-jsrproxy-github-host");
  headers.delete("host");
  try {
    const response = await fetch(`https://${host}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: "manual",
    });
    console.log("GitHub outbound proxy response", host, response.status);
    return response;
  } catch {
    console.warn("GitHub outbound proxy request failed", host);
    return new Response("GitHub request failed", { status: 503 });
  }
}
