#!/usr/bin/env node

import { rmSync } from "node:fs";
import { resolve } from "node:path";

rmSync(resolve(process.cwd(), "dist"), { force: true, recursive: true });
