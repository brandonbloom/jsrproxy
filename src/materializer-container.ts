import { Container } from "@cloudflare/containers";

/** Hosts the isolated native materializer for one active package job. */
export class MaterializerContainer extends Container {
  defaultPort = 8080;
  pingEndpoint = "localhost/health";
  sleepAfter = "1m";
  enableInternet = false;
}
