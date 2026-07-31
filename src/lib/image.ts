/**
 * A schematic is a text document that happens to be drawn. Everything that
 * makes it useful — designators, values, net labels, the title block — is small
 * text, and small text is the first thing a downscale destroys.
 *
 * 3072px on the long edge is well above what a photo would need, and
 * deliberately: on a scanned A3 service sheet that is roughly the point where a
 * 2 mm designator stops being resolvable at all. Above it the provider
 * downsamples anyway and you are paying for pixels nobody reads.
 */
const MAX_EDGE = 3072

/**
 * Higher than a photo would use. JPEG ringing gathers around exactly the
 * feature a schematic is made of — a thin black line on white — and at the
 * default 0.8 the ringing around 7px text is enough to turn an 8 into a 6.
 */
const JPEG_QUALITY = 0.94

/**
 * A lossless source small enough to send as-is is sent as-is: no re-encode, no
 * ringing, nothing between the scan and the model. Line art often lands well
 * under this even at full size, so this path is taken more often than it looks.
 */
const LOSSLESS_PASSTHROUGH_BYTES = 6 * 1024 * 1024

/**
 * History thumbnails live in localStorage, which is only a few MB in total.
 * 512px at quality 0.6 lands around 30KB each — nothing legible at that size,
 * but enough to recognise which sheet a saved report belongs to.
 */
const THUMB_EDGE = 512
const THUMB_QUALITY = 0.6

export interface PreparedImage {
  /** Base64 payload with no data: prefix, ready for the API. */
  base64: string
  mimeType: string
  /** Object URL for previewing. Caller must revoke it. */
  previewUrl: string
  /** Small data: URL, cheap enough to keep in history alongside the report. */
  thumbnail: string
  width: number
  height: number
  bytes: number
  /** True when the pixels reached the model untouched. Surfaced in the UI,
   *  because it changes how much to trust a borderline character reading. */
  lossless: boolean
  /** Set when this came from a PDF, e.g. "page 3 of 7". */
  origin?: string
}

export async function prepareImage(file: Blob, origin?: string): Promise<PreparedImage> {
  // from-image applies EXIF rotation, so a phone photo of a paper manual isn't
  // sideways.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get a 2D canvas context.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const thumbnail = makeThumbnail(canvas)

  // A lossless original that needed no downscale goes through untouched.
  const passthrough =
    scale === 1 &&
    file.size <= LOSSLESS_PASSTHROUGH_BYTES &&
    (file.type === 'image/png' || file.type === 'image/webp')

  const blob = passthrough
    ? file
    : await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
      ).then((b) => {
        if (!b) throw new Error('Could not encode the image.')
        return b
      })

  return {
    base64: await blobToBase64(blob),
    mimeType: passthrough ? file.type : 'image/jpeg',
    previewUrl: URL.createObjectURL(blob),
    thumbnail,
    width,
    height,
    bytes: blob.size,
    lossless: passthrough,
    origin,
  }
}

/** Downscales the already-prepared canvas; the source bitmap is closed by now. */
function makeThumbnail(source: HTMLCanvasElement): string {
  const scale = Math.min(1, THUMB_EDGE / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))

  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  // White behind it: a transparent PNG export of a schematic is black lines on
  // nothing, and a thumbnail composited onto a dark UI would be invisible.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)

  try {
    return canvas.toDataURL('image/jpeg', THUMB_QUALITY)
  } catch {
    // A thumbnail is a nicety — never fail the analysis over one.
    return ''
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the image file.'))
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

/** Splits a stored thumbnail back into the parts an API call needs. */
export function splitDataUrl(dataUrl: string): { base64: string; mimeType: string } | null {
  const match = /^data:([^;,]+)[^,]*,(.*)$/s.exec(dataUrl)
  return match ? { mimeType: match[1], base64: match[2] } : null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
