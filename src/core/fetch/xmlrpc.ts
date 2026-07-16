import { XMLParser } from 'fast-xml-parser';

/**
 * XML-RPC decoding.
 *
 * LJ's responses are ordinary XML-RPC, but the format has two properties worth
 * knowing before touching this: field names live in *text* (`<name>foo</name>`),
 * not in tags, and a `<value>` with no type child is a string by spec. Both bite
 * anyone who reaches for a regex here (DESIGN.md §5.1).
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep everything as strings and convert deliberately. Left on, LJ ids like
  // '0123' silently become 123, and a mood of "7" becomes a number.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

export type XmlRpcValue =
  string | number | boolean | null | XmlRpcValue[] | { [k: string]: XmlRpcValue };

/** fast-xml-parser collapses a one-element list into the element itself. */
function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Decode one <value>. Per the XML-RPC spec a bare `<value>x</value>` with no
 * type child is a string — omitting that case makes untyped fields vanish.
 */
function decodeValue(node: unknown): XmlRpcValue {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);

  const v = node as Record<string, unknown>;

  if ('string' in v) return v['string'] === '' ? '' : String(v['string'] ?? '');
  if ('int' in v) return Number(v['int']);
  if ('i4' in v) return Number(v['i4']);
  if ('double' in v) return Number(v['double']);
  if ('boolean' in v) return String(v['boolean']) === '1';
  if ('nil' in v) return null;
  if ('dateTime.iso8601' in v) return String(v['dateTime.iso8601']);
  if ('base64' in v) {
    return Buffer.from(String(v['base64'] ?? ''), 'base64').toString('utf8');
  }
  if ('array' in v) {
    const data = (v['array'] as Record<string, unknown> | undefined)?.['data'] as
      Record<string, unknown> | undefined;
    return toArray(data?.['value']).map(decodeValue);
  }
  if ('struct' in v) {
    const struct = v['struct'] as Record<string, unknown>;
    const out: Record<string, XmlRpcValue> = {};
    for (const m of toArray(
      struct['member'] as Record<string, unknown> | Record<string, unknown>[],
    )) {
      const key = String(m['name'] ?? '');
      if (key) out[key] = decodeValue(m['value']);
    }
    return out;
  }

  // A <value> whose only content is text: `<value>hello</value>`.
  if ('#text' in v) return String(v['#text']);

  // An empty element: `<value><string/></value>` or `<value/>`.
  return '';
}

export class XmlRpcFault extends Error {
  constructor(
    readonly faultCode: number,
    readonly faultString: string,
  ) {
    super(`XML-RPC fault ${faultCode}: ${faultString}`);
    this.name = 'XmlRpcFault';
  }
}

/**
 * Decode a methodResponse into its single return value.
 *
 * Faults arrive with HTTP 200 and a <fault> body — checking the status code
 * alone reports success on a rejected request.
 */
export function decodeResponse(xml: string): XmlRpcValue {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const res = doc['methodResponse'] as Record<string, unknown> | undefined;
  if (!res) throw new Error('not an XML-RPC methodResponse');

  if ('fault' in res) {
    const f = decodeValue((res['fault'] as Record<string, unknown>)['value']) as Record<
      string,
      XmlRpcValue
    >;
    throw new XmlRpcFault(Number(f['faultCode'] ?? 0), String(f['faultString'] ?? 'unknown'));
  }

  const param = (res['params'] as Record<string, unknown> | undefined)?.['param'] as
    Record<string, unknown> | undefined;
  if (!param) throw new Error('XML-RPC response has no params');
  return decodeValue(param['value']);
}

// --- request encoding ------------------------------------------------------

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeValue(v: string | number | boolean): string {
  if (typeof v === 'number') return `<value><int>${v}</int></value>`;
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  return `<value><string>${escapeXml(v)}</string></value>`;
}

export function encodeRequest(
  method: string,
  params: Record<string, string | number | boolean> = {},
): string {
  const members = Object.entries(params)
    .map(([k, v]) => `<member><name>${k}</name>${encodeValue(v)}</member>`)
    .join('');
  const body = Object.keys(params).length
    ? `<params><param><value><struct>${members}</struct></value></param></params>`
    : '<params/>';
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName>${body}</methodCall>`;
}
