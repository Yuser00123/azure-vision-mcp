# Azure Vision MCP Server (Vercel Serverless)

A Model Context Protocol (MCP) server that connects your AI assistants (Claude, Cursor, Windsurf, custom agents) directly to **Azure AI Vision API**. Hosted remotely as a serverless endpoint on Vercel.

This MCP server supports both **public image URLs** and **local images** (via Base64 encoding), enabling image analysis and Optical Character Recognition (OCR) directly inside your AI chat interfaces.

---

## Features

- **Analyze Image (Base64 / Local Files):** Decodes raw Base64 image data from local storage and returns visual tags, categories, and AI-generated descriptive captions.
- **Read Text / OCR (Base64 / Local Files):** Extracts handwritten or printed text line-by-line from local images using Azure AI Vision OCR.
- **Analyze Image (Public URL):** Analyzes images from any public `http://` or `https://` link.
- **Read Text / OCR (Public URL):** Performs OCR on public image URLs.
- **Serverless Ready:** Designed using `@vercel/mcp-adapter` for low-latency, zero-downtime execution on Vercel's free tier.

---

## Project Structure

```text
.
├── app/
│   └── api/
│       └── mcp/
│           └── route.ts       # Core MCP Server handler & tools
├── next.config.js             # Next.js configuration
├── package.json               # Project dependencies
└── README.md                  # Documentation
