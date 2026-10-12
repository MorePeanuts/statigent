export type ImageFormat = "png" | "jpeg" | "gif" | "webp";
export interface ImageInfo {
  format: ImageFormat;
  mime: string;
  width: number;
  height: number;
}
/**
 * Local limits stay below the provider's documented maxima (DeepSeek: 32 MiB per image, 600 images,
 * 8192 px per side, 4096 px once a request carries 15 or more images).
 */
export interface ImageLimits {
  max_image_bytes: number;
  max_images: number;
  max_side: number;
  many_images: number;
  max_side_many: number;
}
export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  max_image_bytes: 8 * 1024 * 1024,
  max_images: 40,
  max_side: 8192,
  many_images: 15,
  max_side_many: 4096,
};
const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      i += 2;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;
    const sof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof)
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}
function webpSize(b: Buffer): { width: number; height: number } | null {
  const chunk = b.subarray(12, 16).toString("latin1");
  if (chunk === "VP8X" && b.length >= 30)
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 " && b.length >= 30)
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  return null;
}
/** Identifies an image from its bytes and reads its pixel size; returns null for anything else. */
export function imageInfo(data: Uint8Array): ImageInfo | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let format: ImageFormat | null = null;
  let size: { width: number; height: number } | null = null;
  if (
    b.length >= 24 &&
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    b.subarray(12, 16).toString("latin1") === "IHDR"
  ) {
    format = "png";
    size = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    format = "jpeg";
    size = jpegSize(b);
  } else if (
    b.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1"))
  ) {
    format = "gif";
    size = { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  } else if (
    b.length >= 16 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    format = "webp";
    size = webpSize(b);
  }
  if (!format || !size || size.width < 1 || size.height < 1) return null;
  return { format, mime: MIME[format], ...size };
}
/** Validates a request's images together, because the per-side limit depends on how many there are. */
export function checkImages(
  images: Uint8Array[],
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): ImageInfo[] {
  if (images.length > limits.max_images) throw new Error("image_count_limit");
  const side =
    images.length >= limits.many_images
      ? limits.max_side_many
      : limits.max_side;
  return images.map((data) => {
    if (data.byteLength > limits.max_image_bytes)
      throw new Error("image_size_limit");
    const info = imageInfo(data);
    if (!info) throw new Error("image_format_rejected");
    if (info.width > side || info.height > side)
      throw new Error("image_dimension_limit");
    return info;
  });
}
