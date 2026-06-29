import { hashBytesSha256 } from './hashing'

/**
 * Describes one contiguous text replacement.
 */
export interface TextReplacement {
  /** UTF-16 offset where the replacement starts. */
  readonly from: number
  /** Number of UTF-16 code units to delete at `from`. */
  readonly deleteLength: number
  /** Text to insert at `from` after deleting `deleteLength`. */
  readonly insert: string
}

/**
 * Canonicalizes Markdown text for Y.Text storage.
 *
 * @param text Raw text read from disk or from Y.Text.
 * @returns Text with a leading BOM removed and CRLF/CR converted to LF.
 */
export function canonicalizeTextForYText(text: string): string {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  return withoutBom.replace(/\r\n?/g, '\n')
}

/**
 * Canonicalizes Markdown text for hash-gates.
 *
 * @param text Raw text read from disk or from Y.Text.
 * @returns Text normalized for equality checks. It uses Y.Text canonical form
 * and gives non-empty files exactly one terminal newline.
 */
export function canonicalizeTextForHash(text: string): string {
  const withLf = canonicalizeTextForYText(text)
  if (withLf.length === 0) {
    return ''
  }

  return withLf.endsWith('\n') ? withLf : `${withLf}\n`
}

/**
 * Hashes text after Kuroflare's canonical text normalization using SHA-256.
 *
 * @param text Raw text read from disk or from Y.Text.
 * @returns Stable SHA-256 hash encoded as lowercase hexadecimal.
 */
export async function hashCanonicalText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeTextForHash(text))
  return hashBytesSha256(bytes)
}

/**
 * Computes a single minimal contiguous replacement between two strings.
 *
 * @param previous Current text.
 * @param next Desired text.
 * @returns A replacement for the changed middle region, or `null` when equal.
 */
export function computeMinimalTextReplacement(
  previous: string,
  next: string,
): TextReplacement | null {
  if (previous === next) {
    return null
  }

  const prefixLength = commonPrefixLength(previous, next)
  const suffixLength = commonSuffixLength(previous, next, prefixLength)
  const previousEnd = previous.length - suffixLength
  const nextEnd = next.length - suffixLength

  return {
    from: prefixLength,
    deleteLength: previousEnd - prefixLength,
    insert: next.slice(prefixLength, nextEnd),
  }
}

function commonPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length)
  let index = 0
  while (index < maxLength && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1
  }
  return index
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
  const maxLength = Math.min(left.length, right.length) - prefixLength
  let length = 0
  while (
    length < maxLength &&
    left.charCodeAt(left.length - 1 - length) === right.charCodeAt(right.length - 1 - length)
  ) {
    length += 1
  }
  return length
}
