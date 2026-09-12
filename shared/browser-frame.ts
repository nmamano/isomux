/** Browser JPEG v1: big-endian fixed 28-byte header, UTF-8 agent id, JPEG.
 * Each message is self-contained; other binary protocols fail the magic/kind
 * checks. DataView accepts unaligned buffers (including Bun Buffer slices). */
const MAGIC = 0x49534d58; // ISMX
const HEADER = 28;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface BinaryBrowserFrame {
  agentId: string;
  generation: number;
  width: number;
  height: number;
  jpeg: Uint8Array<ArrayBuffer>;
}

export function encodeBrowserFrame(
  frame: BinaryBrowserFrame,
): Uint8Array<ArrayBuffer> {
  const id = encoder.encode(frame.agentId);
  if (!id.length || id.length > 65535 || !validGeneration(frame.generation))
    throw new Error("Invalid browser frame identity");
  const result = new Uint8Array(HEADER + id.length + frame.jpeg.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, MAGIC);
  view.setUint8(4, 1); // version
  view.setUint8(5, 1); // JPEG kind
  view.setUint16(6, id.length);
  view.setFloat64(8, frame.generation);
  view.setUint32(16, frame.width);
  view.setUint32(20, frame.height);
  view.setUint32(24, frame.jpeg.byteLength);
  result.set(id, HEADER);
  result.set(frame.jpeg, HEADER + id.length);
  return result;
}

export function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function decodeBrowserFrame(
  data: ArrayBuffer | Uint8Array<ArrayBuffer>,
): BinaryBrowserFrame | null {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (bytes.byteLength < HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0) !== MAGIC ||
    view.getUint8(4) !== 1 ||
    view.getUint8(5) !== 1
  )
    return null;
  const idLength = view.getUint16(6);
  const generation = view.getFloat64(8);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  const jpegLength = view.getUint32(24);
  if (
    !idLength ||
    HEADER + idLength + jpegLength !== bytes.byteLength ||
    jpegLength < 2 ||
    !validGeneration(generation) ||
    !width ||
    !height
  )
    return null;
  try {
    const agentId = decoder.decode(bytes.subarray(HEADER, HEADER + idLength));
    const jpeg = bytes.subarray(HEADER + idLength);
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
    return { agentId, generation, width, height, jpeg };
  } catch {
    return null;
  }
}
