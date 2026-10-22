/** Built on its own as dist/computer-tools.js so a rebuilt copy can replace the running one (hot-tools.ts). */
import { computerDesktopTool } from './tools/computer.js';
import { computerWebTool } from './tools/computer-web.js';
import { clikDeployStepUpTool } from './tools/clikdeploy-step-up.js';
import type { ToolDefinition } from './tool-contract.js';

export const computerToolSet = [computerWebTool, computerDesktopTool, clikDeployStepUpTool] as unknown as ToolDefinition[];
