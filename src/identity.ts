const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Encodes a canonical GitHub repository name into JSR's package alphabet.
 * GitHub repository names are case-insensitive, so callers are canonicalized
 * to lowercase before escaping UTF-8 bytes.
 */
export function encodeRepositoryName(repository: string): string {
  const canonical = repository.toLowerCase();
  if (canonical.length === 0) {
    throw new Error("repository name must not be empty");
  }

  let encoded = "";
  for (const byte of encoder.encode(canonical)) {
    if ((byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)) {
      encoded += String.fromCharCode(byte);
    } else if (byte === 0x2d) {
      encoded += "--";
    } else {
      encoded += `-x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return encoded;
}

/** Decodes and verifies the one canonical representation of a repository name. */
export function decodeRepositoryName(encoded: string): string {
  if (!/^[a-z0-9-]+$/.test(encoded)) {
    throw new Error("package name contains an invalid character");
  }

  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character !== "-") {
      bytes.push(character.charCodeAt(0));
      continue;
    }

    if (encoded[index + 1] === "-") {
      bytes.push(0x2d);
      index += 1;
      continue;
    }
    if (encoded[index + 1] === "x" && /^[0-9a-f]{2}$/.test(encoded.slice(index + 2, index + 4))) {
      bytes.push(Number.parseInt(encoded.slice(index + 2, index + 4), 16));
      index += 3;
      continue;
    }
    throw new Error("package name has a malformed escape");
  }

  let repository: string;
  try {
    repository = decoder.decode(new Uint8Array(bytes));
  } catch {
    throw new Error("package name has invalid UTF-8");
  }
  if (encodeRepositoryName(repository) !== encoded) {
    throw new Error("package name is not canonically encoded");
  }
  return repository;
}

/** Parses the two segments that identify a synthetic JSR package. */
export function parsePackageIdentity(pathname: string): { scope: string; name: string } | undefined {
  const match = /^\/@([a-z0-9][a-z0-9-]*)\/([a-z0-9-]+)(?:\/|$)/.exec(pathname);
  if (!match) {
    return undefined;
  }
  return { scope: match[1], name: match[2] };
}
