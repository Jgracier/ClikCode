import { emitJson } from './structured-output';

export function isHumanOutputRequested(): boolean {
  return process.argv.includes('--human') || process.env.CLIKDEPLOY_OUTPUT_MODE === 'human';
}

export function isJsonDefaultMode(): boolean {
  return !isHumanOutputRequested();
}

export function emitResultJson(payload: unknown): boolean {
  if (!isJsonDefaultMode()) return false;
  emitJson(payload);
  return true;
}

