import { Container } from "@cloudflare/containers";
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
  allowedHosts = ["artifacts.r2"];

  static outboundByHost = {
    "artifacts.r2": async (request: Request, env: MaterializerEnvironment) => {
      try {
        const response = await publishArtifact(env.ARTIFACTS, request);
        console.log("materializer R2 publication response", response.status);
        return response;
      } catch (error) {
        console.warn("materializer R2 publication failed", error instanceof Error ? error.message : "unknown error");
        return new Response("artifact publication unavailable", { status: 503 });
      }
    },
  };
}
