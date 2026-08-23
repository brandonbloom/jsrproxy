import { Container, type OutboundHandlerContext } from "@cloudflare/containers";
import { publishArtifact, type R2PublicationBucket } from "./r2-publication.ts";

interface MaterializerEnvironment {
  ARTIFACTS: R2PublicationBucket;
}

/** Hosts the isolated native materializer for one active package job. */
export class MaterializerContainer extends Container<MaterializerEnvironment> {
  defaultPort = 8080;
  sleepAfter = "1m";
  enableInternet = false;
  allowedHosts = ["api.github.com"];

  static outboundByHost = {
    "artifacts.r2": (request: Request, env: MaterializerEnvironment, _context: OutboundHandlerContext) =>
      publishArtifact(env.ARTIFACTS, request),
  };
}
