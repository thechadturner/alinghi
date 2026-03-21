#!/usr/bin/env node
/**
 * Hunico Solid.js MCP server.
 * Exposes resources (Solid/TS conventions) and prompts for Cursor.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SOLID_PATTERNS, TS_CONVENTIONS } from "./content.js";

const server = new McpServer(
  {
    name: "hunico-solid",
    version: "1.0.0",
  },
  {
    capabilities: {},
  }
);

// --- Resources ---

server.registerResource(
  "solid-patterns",
  "hunico://solid/patterns",
  {
    title: "Solid.js patterns",
    description: "Solid.js conventions and patterns for Hunico frontend",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, text: SOLID_PATTERNS }],
  })
);

server.registerResource(
  "ts-conventions",
  "hunico://typescript/conventions",
  {
    title: "TypeScript conventions",
    description: "TypeScript and path alias conventions for Hunico",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, text: TS_CONVENTIONS }],
  })
);

// --- Prompts ---

server.registerPrompt(
  "add-solid-component",
  {
    title: "Add Solid component",
    description: "Add a new Solid.js component with signals and TypeScript",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Add a new Solid.js component. Use createSignal or createStore for state, createEffect/onCleanup for side effects, and import logging from @utils/console. Use path aliases (@/, @store/, @utils/). Keep types explicit and avoid any.`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "refactor-to-signals",
  {
    title: "Refactor to Solid signals",
    description: "Refactor this code to use Solid.js signals and cleanup",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Refactor this to use Solid.js patterns: createSignal/createStore for state, createEffect and onCleanup for side effects. Use @utils/console for logging. No React hooks or React patterns.`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "make-type-safe",
  {
    title: "Make type-safe",
    description: "Make this component or function type-safe (no any)",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Make this code type-safe: remove or replace any, add explicit return types for public functions, use project path aliases (@/, @store/, etc.). Preserve Solid.js patterns (signals, effects, onCleanup).`,
        },
      },
    ],
  })
);

// --- Tool ---

server.registerTool(
  "get_solid_guidance",
  {
    title: "Get Solid/TS guidance",
    description: "Return Solid.js or TypeScript conventions for the given topic",
    inputSchema: z.object({
      topic: z.enum(["solid", "typescript"]).describe("Which guidance to return"),
    }),
  },
  async ({ topic }) => {
    const text = topic === "solid" ? SOLID_PATTERNS : TS_CONVENTIONS;
    return {
      content: [{ type: "text" as const, text }],
    };
  }
);

// --- Start stdio transport ---

const transport = new StdioServerTransport();
await server.connect(transport);
