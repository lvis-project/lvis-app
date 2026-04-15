/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/hooks/schemas.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 */
import { z } from "zod";

export const CommandHookDefinitionSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  timeoutSeconds: z.number().int().min(1).max(600).default(30),
  matcher: z.string().optional(),
  blockOnFailure: z.boolean().default(false),
});

export const HttpHookDefinitionSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
  timeoutSeconds: z.number().int().min(1).max(600).default(30),
  matcher: z.string().optional(),
  blockOnFailure: z.boolean().default(false),
});

export const HookDefinitionSchema = z.discriminatedUnion("type", [
  CommandHookDefinitionSchema,
  HttpHookDefinitionSchema,
]);

export type CommandHookDefinition = z.infer<typeof CommandHookDefinitionSchema>;
export type HttpHookDefinition = z.infer<typeof HttpHookDefinitionSchema>;
export type HookDefinition = z.infer<typeof HookDefinitionSchema>;

export const HooksConfigSchema = z.object({
  preToolUse: z.array(HookDefinitionSchema).default([]),
  postToolUse: z.array(HookDefinitionSchema).default([]),
});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export const EMPTY_HOOKS_CONFIG: HooksConfig = { preToolUse: [], postToolUse: [] };
