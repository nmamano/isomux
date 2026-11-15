// The runner side of "file-read" (internal-docs/member-os-user-design.md,
// slice 2a): bytes of one file that an isolated member's agent names, read as
// the member. The output is one JSON line {real, size}, then the bytes from
// offset up to offset + length or the end of the file. A file that is not
// regular, that ends early, or that grew past its size when the read reached
// its end fails the entry. Light imports: this module is in the runner bundle.

import { constants } from "fs";
import { open, realpath } from "fs/promises";

export interface FileReadInput {
  path: string;
  offset: number;
  length: number;
}

export async function sendFileRange(
  input: FileReadInput,
  write: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const { path, offset, length } = input ?? {};
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  )
    throw new Error("file-read needs an absolute path, an offset and a length");
  const real = await realpath(path);
  const file = await open(
    real,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
    const size = stats.size;
    await write(Buffer.from(`${JSON.stringify({ real, size })}\n`));
    const end = Math.min(size, offset + length);
    let position = offset;
    while (position < end) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, end - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error(`${path} became shorter`);
      await write(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (end === size && position === size) {
      const { bytesRead } = await file.read(Buffer.alloc(1), 0, 1, size);
      if (bytesRead > 0) throw new Error(`${path} grew while it was read`);
    }
  } finally {
    await file.close();
  }
}
