import { createMcpHandler } from '@vercel/mcp-adapter';
import { ComputerVisionClient } from '@azure/cognitiveservices-computervision';
import { ApiKeyCredentials } from '@azure/ms-rest-js';
import { z } from 'zod';

// Read Azure Vision credentials from environment variables
const key = process.env.AZURE_VISION_KEY || '';
const endpoint = process.env.AZURE_VISION_ENDPOINT || '';

const credentials = new ApiKeyCredentials({
  inHeader: { 'Ocp-Apim-Subscription-Key': key }
});
const client = new ComputerVisionClient(credentials, endpoint);

const handler = createMcpHandler((server) => {
  // -------------------------------------------------------------
  // Tool 1: Analyze Image via Base64 String (Local Files)
  // -------------------------------------------------------------
  server.tool(
    'analyze_image_base64',
    'Analyzes a local image passed as a Base64 string using Azure AI Vision',
    {
      base64Data: z
        .string()
        .describe('Base64-encoded image data string (with or without data URL prefix)')
    },
    async ({ base64Data }) => {
      try {
        // Strip data URL prefix if present
        const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(cleanBase64, 'base64');

        // Pass Buffer directly as the first argument
        const results = await client.analyzeImageInStream(imageBuffer as any, {
          visualFeatures: ['Description', 'Tags', 'Categories', 'Objects']
        });

        const caption = results.description?.captions?.[0]?.text || 'No description found.';
        const tags = results.tags?.map((t) => t.name).join(', ') || 'None';
        const categories = results.categories?.map((c) => c.name).join(', ') || 'None';

        return {
          content: [
            {
              type: 'text',
              text: `Caption: ${caption}\nTags: ${tags}\nCategories: ${categories}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error analyzing Base64 image: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 2: Read Text / OCR via Base64 String (Local Files)
  // -------------------------------------------------------------
  server.tool(
    'read_text_base64',
    'Extracts text (OCR) from a local image passed as a Base64 string using Azure AI Vision',
    {
      base64Data: z
        .string()
        .describe('Base64-encoded image data string (with or without data URL prefix)')
    },
    async ({ base64Data }) => {
      try {
        const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(cleanBase64, 'base64');

        // Pass Buffer directly as the first argument
        const ocrResult = await client.recognizePrintedTextInStream(true, imageBuffer as any);
        const lines: string[] = [];

        for (const region of ocrResult.regions || []) {
          for (const line of region.lines || []) {
            lines.push(line.words.map((w) => w.text).join(' '));
          }
        }

        const extractedText = lines.length > 0 ? lines.join('\n') : 'No text detected in image.';

        return {
          content: [{ type: 'text', text: extractedText }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error reading text from Base64 image: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  // -------------------------------------------------------------
  // Tool 3: Analyze Public Image URL
  // -------------------------------------------------------------
  server.tool(
    'analyze_image_url',
    'Analyzes an image from a public HTTP/HTTPS URL using Azure AI Vision API',
    { imageUrl: z.string().url().describe('The public URL of the image') },
    async ({ imageUrl }) => {
      try {
        const results = await client.analyzeImage(imageUrl, {
          visualFeatures: ['Description', 'Tags', 'Categories', 'Objects']
        });

        const caption = results.description?.captions?.[0]?.text || 'No description found.';
        const tags = results.tags?.map((t) => t.name).join(', ') || 'None';
        const categories = results.categories?.map((c) => c.name).join(', ') || 'None';

        return {
          content: [
            {
              type: 'text',
              text: `Caption: ${caption}\nTags: ${tags}\nCategories: ${categories}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error analyzing image URL: ${error.message}` }],
          isError: true
        };
      }
    }
  );
});

export const GET = handler;
export const POST = handler;
