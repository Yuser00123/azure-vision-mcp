import { createMcpHandler } from '@vercel/mcp-adapter';
import { ComputerVisionClient } from '@azure/cognitiveservices-computervision';
import { ApiKeyCredentials } from '@azure/ms-rest-js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------
export const runtime = 'nodejs';   // Buffer + ms-rest-js need Node, not Edge
export const maxDuration = 60;     // Vercel Hobby defaults to 10s — too short

// Fail fast. The old code used `|| ''`, which built a client with an empty
// endpoint and produced cryptic failures at call time instead of at boot.
const key = process.env.AZURE_VISION_KEY;
const endpoint = process.env.AZURE_VISION_ENDPOINT;
if (!key || !endpoint) {
  throw new Error('AZURE_VISION_KEY and AZURE_VISION_ENDPOINT must be set');
}

// Gate the endpoint. Without this, anyone on the internet can spend your
// Azure Vision free tier (5k tx/month, 20/min) through a public URL.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // see note: Vercel body limit, not Azure's
const MAX_TEXT_OUT = 6000;               // never hand the model a context bomb

const client = new ComputerVisionClient(
  new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': key } }),
  endpoint
);

const VISUAL_FEATURES = ['Description', 'Tags', 'Categories', 'Objects'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function truncate(s: string, n = MAX_TEXT_OUT): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
}

function formatAnalysis(r: any): string {
  const caption = r.description?.captions?.[0]?.text || 'No description found.';
  const tags = r.tags?.map((t: any) => t.name).join(', ') || 'None';
  const categories = r.categories?.map((c: any) => c.name).join(', ') || 'None';
  // 'Objects' was requested but previously discarded — now rendered.
  const objects =
    r.objects?.map((o: any) => `${o.object || o.name} (${(o.confidence * 100).toFixed(0)}%)`).join(', ') ||
    'None';
  return `Caption: ${caption}\nTags: ${tags}\nCategories: ${categories}\nObjects: ${objects}`;
}

function formatOcr(r: any): string {
  const lines: string[] = [];
  for (const region of r.regions || []) {
    for (const line of region.lines || []) {
      lines.push((line.words || []).map((w: any) => w.text).join(' '));
    }
  }
  return lines.length ? truncate(lines.join('\n')) : 'No text detected in image.';
}

/** Reject oversized base64 before it reaches Azure (and before it costs a call). */
function decodeBase64(b64: string): Buffer {
  const clean = b64.replace(/^data:[^;]*;base64,/, '');
  const buf = Buffer.from(clean, 'base64');
  if (!buf.length) throw new Error('base64Data decoded to 0 bytes — is it valid base64?');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is ${(buf.length / 1048576).toFixed(1)}MB. Limit is 3MB because base64 inflates ` +
        `size by ~33% and Vercel rejects request bodies over 4.5MB with a 413 before ` +
        `this handler ever runs. ` +
        `Downscale it, or upload it and use analyze_image_url instead.`
    );
  }
  return buf;
}

const err = (msg: string) => ({
  content: [{ type: 'text' as const, text: msg }],
  isError: true,
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const handler = createMcpHandler(
  (server) => {
    // ---- PREFERRED: URL-based. Keeps bytes out of the model's context. ----
    server.tool(
      'analyze_image_url',
      'Analyzes an image at a public HTTP/HTTPS URL using Azure AI Vision. Returns a caption, tags, categories and detected objects. PREFER this tool — pass a URL, never base64.',
      { imageUrl: z.string().url().describe('Public URL of the image') },
      async ({ imageUrl }) => {
        try {
          return { content: [{ type: 'text', text: formatAnalysis(await client.analyzeImage(imageUrl, { visualFeatures: [...VISUAL_FEATURES] })) }] };
        } catch (e: any) {
          return err(`Error analyzing image URL: ${e.message}`);
        }
      }
    );

    // NEW: OCR by URL. Previously OCR was base64-only, which forced the model
    // to inline image bytes into tool arguments.
    server.tool(
      'read_text_url',
      'Extracts printed and handwritten text (OCR) from an image at a public HTTP/HTTPS URL. PREFER this over read_text_base64.',
      { imageUrl: z.string().url().describe('Public URL of the image') },
      async ({ imageUrl }) => {
        try {
          return { content: [{ type: 'text', text: formatOcr(await client.recognizePrintedText(true, imageUrl)) }] };
        } catch (e: any) {
          return err(`Error reading text from URL: ${e.message}`);
        }
      }
    );

    // ---- FALLBACK: base64. Size-checked and explicitly discouraged. ----
    server.tool(
      'analyze_image_base64',
      'Analyzes a local image passed as base64. Use ONLY when no public URL exists — prefer analyze_image_url, since base64 is large and slow.',
      { base64Data: z.string().describe('Base64 image data, with or without a data: URL prefix') },
      async ({ base64Data }) => {
        try {
          const buf = decodeBase64(base64Data);
          return { content: [{ type: 'text', text: formatAnalysis(await client.analyzeImageInStream(buf as any, { visualFeatures: [...VISUAL_FEATURES] })) }] };
        } catch (e: any) {
          return err(`Error analyzing base64 image: ${e.message}`);
        }
      }
    );

    server.tool(
      'read_text_base64',
      'Extracts text (OCR) from a local image passed as base64. Use ONLY when no public URL exists — prefer read_text_url.',
      { base64Data: z.string().describe('Base64 image data, with or without a data: URL prefix') },
      async ({ base64Data }) => {
        try {
          const buf = decodeBase64(base64Data);
          return { content: [{ type: 'text', text: formatOcr(await client.recognizePrintedTextInStream(true, buf as any)) }] };
        } catch (e: any) {
          return err(`Error reading text from base64 image: ${e.message}`);
        }
      }
    );
  },
  // NOTE: this 2nd argument is MCP `ServerOptions` (capabilities, instructions,
  // errorHandler) — NOT the server name/version. @vercel/mcp-adapter hardcodes
  //   new McpServer({ name: 'mcp-typescript server on vercel', version: '0.1.0' }, serverOptions)
  // so every server built with this adapter reports the SAME serverInfo.name.
  // Your orchestrator's MCP registry must therefore key servers by its own
  // configured id (e.g. 'azure_vision'), never by the name in the initialize
  // response, or two of these will collide.
  {},
  {
    // 🔴 THE BUG FIX.
    // Without this, @vercel/mcp-adapter defaults basePath to '' and matches
    // only "/mcp", "/sse", "/message". This route is served at "/api/mcp",
    // so every request fell through to the adapter's `else` branch:
    //     res.statusCode = 404; res.end("Not found");
    // With basePath '/api' the stateless Streamable-HTTP endpoint resolves to
    // '/api/mcp' and matches this file. No Redis needed for streamable HTTP.
    basePath: '/api',
    maxDuration: 60,
    verboseLogs: false,
  }
);

// ---------------------------------------------------------------------------
// Auth wrapper — createMcpHandler returns (request) => Promise<Response>,
// so guarding it is a plain function wrap.
// ---------------------------------------------------------------------------
async function guarded(request: Request): Promise<Response> {
  if (AUTH_TOKEN) {
    const got = request.headers.get('authorization');
    // Constant-time-ish compare; avoids trivially leaking the token length.
    const want = `Bearer ${AUTH_TOKEN}`;
    if (!got || got.length !== want.length || got !== want) {
      return new Response('Unauthorized', { status: 401 });
    }
  }
  return handler(request);
}

export const GET = guarded;
export const POST = guarded;
